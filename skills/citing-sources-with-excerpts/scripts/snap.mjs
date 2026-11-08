#!/usr/bin/env node
// Find a quote on a web page, return the surrounding excerpt + a text-fragment URL,
// and optionally save a cropped screenshot with the quote highlighted.
//
// Usage:
//   node snap.mjs <url> [--quote "text"] [--out shot.png] [--prefix "words before"] [--suffix "words after"]
//                 [--frame quote|paragraph|section|viewport] [--context N] [--width PX] [--max-height PX]
//                 [--highlight COLOR|none] [--theme light|dark] [--scale 1|2|3] [--timeout MS]
//   node snap.mjs --batch cites.json        (or --batch - to read stdin)
// <url> may already contain a text fragment (#:~:text=[prefix-,]start[,end][,-suffix]).
// Batch input: [{"url", "quote", "out"?, ...options}] or {"defaults": {...options}, "cites": [...]}.
// Single mode prints one JSON object; batch prints an array in input order.
// Exit 0 = all found, 1 = some not found, 2 = some error.

import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { chromium } from 'playwright';

// ---------- options ----------

const FRAMES = new Set(['quote', 'paragraph', 'section', 'viewport']);
const THEMES = new Set(['light', 'dark']);
const DEFAULTS = { frame: 'paragraph', context: 0, width: 1100, max_height: 500, highlight: null, theme: 'light', scale: 2 };
const NUMERIC = { context: [0, 20], width: [320, 1920], max_height: [80, 2000], scale: [1, 3] };

// Returns [options, error]. Unknown keys are ignored; bad values are errors, not silent defaults.
function screenshotOptions(raw) {
  const o = { ...DEFAULTS };
  for (const [k, [lo, hi]] of Object.entries(NUMERIC)) {
    if (raw[k] === undefined || raw[k] === null) continue;
    const n = Number(raw[k]);
    if (!Number.isFinite(n)) return [null, `${k} must be a number (got ${JSON.stringify(raw[k])})`];
    o[k] = Math.min(hi, Math.max(lo, Math.round(n)));
  }
  if (raw.frame !== undefined) {
    if (!FRAMES.has(raw.frame)) return [null, `frame must be one of ${[...FRAMES].join(', ')} (got ${JSON.stringify(raw.frame)})`];
    o.frame = raw.frame;
  }
  if (raw.theme !== undefined) {
    if (!THEMES.has(raw.theme)) return [null, `theme must be light or dark (got ${JSON.stringify(raw.theme)})`];
    o.theme = raw.theme;
  }
  if (raw.highlight !== undefined && raw.highlight !== null) o.highlight = String(raw.highlight);
  // "Show the whole section" shouldn't be cut at the paragraph-sized default cap.
  if (o.frame === 'section' && (raw.max_height === undefined || raw.max_height === null)) o.max_height = 1200;
  return [o, null];
}

function parseArgs(argv) {
  const args = { timeout: 30000 };
  const flags = { '--quote': 'quote', '--out': 'out', '--batch': 'batch', '--prefix': 'prefix', '--suffix': 'suffix',
    '--frame': 'frame', '--context': 'context', '--width': 'width', '--max-height': 'max_height',
    '--highlight': 'highlight', '--theme': 'theme', '--scale': 'scale', '--timeout': 'timeout' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) args[flags[a]] = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else rest.push(a);
  }
  args.timeout = Number(args.timeout);
  args.url = rest[0];
  return args;
}

// ---------- text fragments ----------

// Parse the first `text=` directive of a text fragment: [prefix-,]start[,end][,-suffix]
function parseTextFragment(url) {
  const i = url.indexOf('#:~:');
  if (i === -1) return { base: url, fragment: null };
  const base = url.slice(0, i);
  const directive = url.slice(i + 4).split('&').find((d) => d.startsWith('text='));
  if (!directive) return { base, fragment: null };
  const parts = directive.slice(5).split(',');
  const dec = (s) => decodeURIComponent(s);
  let prefix = null, suffix = null;
  if (parts[0]?.endsWith('-')) prefix = dec(parts.shift().slice(0, -1));
  if (parts.at(-1)?.startsWith('-')) suffix = dec(parts.pop().slice(1));
  return { base, fragment: { prefix, start: dec(parts[0] ?? ''), end: parts[1] ? dec(parts[1]) : null, suffix } };
}

// encodeURIComponent leaves '-' alone, but '-' and ',' are syntax inside text fragments.
const encFrag = (s) => encodeURIComponent(s).replace(/-/g, '%2D').replace(/,/g, '%2C');

// Long quotes, or quotes whose DOM text differs from the clean text (e.g. a [12] footnote marker
// inside), use the textStart,textEnd form. prefix/suffix pin the right occurrence of repeated text.
function buildFragmentUrl(base, text, { forceRange = false, prefix = null, suffix = null, lines = null } = {}) {
  const words = text.trim().split(/\s+/);
  let body;
  if (lines && lines.length > 1) {
    // Spans several lines: start = opening words of the first line, end = closing words of the last.
    const first = lines[0].split(' '), last = lines.at(-1).split(' ');
    body = `${encFrag(first.slice(0, 5).join(' '))},${encFrag(last.slice(-5).join(' '))}`;
  } else if ((text.length > 160 && words.length > 12) || (forceRange && words.length >= 4)) {
    const n = Math.min(5, Math.floor(words.length / 2));
    body = `${encFrag(words.slice(0, n).join(' '))},${encFrag(words.slice(-n).join(' '))}`;
  } else body = encFrag(text.trim());
  if (prefix) body = `${encFrag(prefix)}-,${body}`;
  if (suffix) body = `${body},-${encFrag(suffix)}`;
  return `${base}#:~:text=${body}`;
}

// ---------- in-page locator ----------

// Runs inside the page. Builds a normalized text index, locates the quote, highlights it,
// stores what's needed to re-measure geometry later (window.__citeMeasure), returns metadata.
function locateInPage({ start, end, prefix, suffix, includeHidden, allowFuzzy, highlight }) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD']);
  const blockOf = (el) => {
    while (el && el !== document.body) {
      const d = getComputedStyle(el).display;
      if (!d.startsWith('inline') && d !== 'contents') return el;
      el = el.parentElement;
    }
    return document.body;
  };
  // Footnote markers like [12] break quotes copied without them; skip them.
  const isRefMarker = (el) => el.closest('sup') && /^\s*\[[^\]]{1,8}\]\s*$/.test(el.closest('sup').textContent);
  const signals = () => ({
    password: !!document.querySelector('input[type=password]'),
    challenge: /just a moment|attention required|checking your browser|verify you are human/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 600))
      || !!document.querySelector('#challenge-form, #cf-challenge-running, .cf-turnstile, [id^="cf-chl"], .g-recaptcha'),
  });

  const nodes = []; // {node, rawStart}
  let raw = '';
  let lastBlock = null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      // <br> has no text but splits lines: browsers' text-fragment matching won't cross it either.
      if (n.nodeType === Node.ELEMENT_NODE) return n.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      const p = n.parentElement;
      if (!p || !n.nodeValue) return NodeFilter.FILTER_REJECT;
      for (let e = p; e; e = e.parentElement) if (SKIP.has(e.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
      if (!includeHidden && p.checkVisibility && !p.checkVisibility()) return NodeFilter.FILTER_REJECT;
      if (isRefMarker(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n; (n = walker.nextNode()); ) {
    if (n.nodeType === Node.ELEMENT_NODE) { if (raw && !raw.endsWith('\u2029')) raw += '\u2029'; continue; }
    const b = blockOf(n.parentElement);
    // U+2029 marks block boundaries; literal newlines inside a text node are just wrapping.
    if (lastBlock && b !== lastBlock && !raw.endsWith('\u2029')) raw += '\u2029';
    lastBlock = b;
    nodes.push({ node: n, rawStart: raw.length });
    raw += n.nodeValue;
  }

  const CHARMAP = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' ' };
  // mode 'norm': lowercase, unify quotes/dashes, collapse whitespace. mode 'loose': letters/digits only.
  function normalize(s, mode) {
    let out = '';
    const map = [];
    for (let i = 0; i < s.length; i++) {
      let c = (CHARMAP[s[i]] ?? s[i]).toLowerCase();
      if (mode === 'loose') {
        if (!/[\p{L}\p{N}]/u.test(c)) continue;
      } else if (/\s/.test(c)) {
        if (out.endsWith(' ') || out === '') continue;
        c = ' ';
      }
      out += c;
      map.push(i);
    }
    return { text: mode === 'loose' ? out : out.trimEnd(), map };
  }

  function findAll(mode) {
    const page = normalize(raw, mode);
    const q1 = normalize(start, mode).text.trim();
    if (!q1) return [];
    const q2 = end ? normalize(end, mode).text.trim() : null;
    const found = [];
    for (let i = page.text.indexOf(q1); i !== -1; i = page.text.indexOf(q1, i + 1)) {
      let j = i + q1.length;
      if (q2) {
        const k = page.text.indexOf(q2, j);
        if (k === -1 || k - j > 5000) continue;
        j = k + q2.length;
      }
      found.push({ i, j, page });
    }
    return found;
  }
  const contextMatches = (c, mode) => {
    const P = prefix ? normalize(prefix, mode).text.trim() : '';
    const S = suffix ? normalize(suffix, mode).text.trim() : '';
    const before = c.page.text.slice(Math.max(0, c.i - P.length - 3), c.i).trimEnd();
    const after = c.page.text.slice(c.j, c.j + S.length + 3).trimStart();
    return (!P || before.endsWith(P)) && (!S || after.startsWith(S));
  };

  // Fuzzy: best-overlapping sentence on the page (for paraphrased / slightly-off quotes).
  function fuzzy() {
    const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const want = new Set(words(start + ' ' + (end || '')));
    if (want.size < 3) return null;
    const re = /[^.!?\u2029]+[.!?]?/g;
    let best = null;
    for (let m; (m = re.exec(raw)); ) {
      const w = new Set(words(m[0]));
      if (w.size < 3) continue;
      let hit = 0;
      for (const x of want) if (w.has(x)) hit++;
      const score = hit / want.size - Math.max(0, w.size - want.size * 2) * 0.01;
      if (!best || score > best.score) best = { score, rawStart: m.index, rawEnd: m.index + m[0].length };
    }
    if (!best || best.score < 0.6) return null;
    const s = raw.slice(best.rawStart, best.rawEnd);
    const lead = s.length - s.trimStart().length;
    return { rawStart: best.rawStart + lead, rawEnd: best.rawStart + s.trimEnd().length, score: best.score };
  }

  let match = null, hit = null, occurrences = 1, contextMissed = false;
  for (const mode of ['norm', 'loose']) {
    const all = findAll(mode);
    if (!all.length) continue;
    match = mode === 'norm' ? 'exact' : 'loose';
    occurrences = all.length;
    let pick = all[0];
    if (prefix || suffix) {
      const good = all.find((c) => contextMatches(c, mode));
      if (good) pick = good; else contextMissed = true;
    }
    hit = { rawStart: pick.page.map[pick.i], rawEnd: pick.page.map[pick.j - 1] + 1, occurrence: all.indexOf(pick) + 1 };
    break;
  }
  if (!hit && allowFuzzy) { match = 'fuzzy'; hit = fuzzy(); }
  if (!hit) return { match: 'none', signals: signals() };

  const pos = (r) => {
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid].rawStart <= r) lo = mid; else hi = mid - 1; }
    const { node, rawStart } = nodes[lo];
    return [node, Math.min(Math.max(r - rawStart, 0), node.nodeValue.length)];
  };
  const range = document.createRange();
  range.setStart(...pos(hit.rawStart));
  range.setEnd(...pos(hit.rawEnd));
  const startEl = range.startContainer.parentElement;

  // Quote found only in hidden content: open collapsed <details> / hidden=until-found ancestors.
  let revealed = false, hidden = false;
  if (includeHidden && !startEl.checkVisibility()) {
    for (let e = startEl; e && e !== document.body; e = e.parentElement) {
      if (e.tagName === 'DETAILS' && !e.open) { e.open = true; revealed = true; }
      if (e.getAttribute('hidden') === 'until-found') { e.removeAttribute('hidden'); revealed = true; }
    }
    hidden = !startEl.checkVisibility();
    if (hidden) revealed = false;
  }

  // Is the rendered page dark? (for dark-theme notes and readable highlight text)
  const bgOf = (el) => getComputedStyle(el).backgroundColor;
  const rgb = [bgOf(document.body), bgOf(document.documentElement)]
    .map((c) => c.match(/[\d.]+/g)?.map(Number))
    .find((v) => v && (v.length < 4 || v[3] > 0)) || [255, 255, 255];
  const darkPage = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.4;

  // Highlight without mutating the DOM (CSS Custom Highlight API).
  let style = document.getElementById('cite-snap-style');
  if (!style) { style = document.createElement('style'); style.id = 'cite-snap-style'; document.head.appendChild(style); }
  const color = highlight === 'none' ? null : highlight && CSS.supports('color', highlight) ? highlight : '#f8d9b8';
  style.textContent = color ? `::highlight(cite-snap){background:${color};color:${darkPage ? '#111' : 'inherit'}}` : '';
  CSS.highlights.set('cite-snap', new Highlight(range));

  const block = startEl.closest('p,li,blockquote,dd,dt,td,th,pre,figcaption,h1,h2,h3,h4,h5,h6') || blockOf(startEl);
  // Table cells: frame the whole row so the value keeps its row context.
  const frameEl = block.matches('td,th') ? block.closest('tr') || block : block;
  if (!hidden) frameEl.scrollIntoView({ block: 'center' });
  // Measure the block's text, not its box: floats (infoboxes) can overlap a paragraph's box.
  const textRange = document.createRange();
  textRange.selectNodeContents(frameEl);
  if (frameEl.tagName === 'TR') {
    const table = frameEl.closest('table');
    // Include the header row (and rows between) so the value keeps its column label.
    const first = table.rows[0];
    const header = table.tHead?.rows[0] || (first !== frameEl && [...first.cells].every((c) => c.tagName === 'TH') ? first : null);
    if (header && header !== frameEl) textRange.setStartBefore(header);
    // Wider than the window: pin the first column so the row label stays in the crop.
    if (table.scrollWidth > window.innerWidth) {
      const bg = [document.body, document.documentElement].map((e) => getComputedStyle(e).backgroundColor)
        .find((c) => !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) || '#fff';
      table.setAttribute('data-cite-snap-table', '');
      let pin = document.getElementById('cite-snap-pin');
      if (!pin) { pin = document.createElement('style'); pin.id = 'cite-snap-pin'; document.head.appendChild(pin); }
      pin.textContent = `[data-cite-snap-table] tr > :first-child{position:sticky;left:0;z-index:2;background:${bg};box-shadow:1px 0 0 rgba(128,128,128,.4)}`;
    }
  }

  // Section: nearest heading before the quote, until the next heading of the same or higher level.
  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,.h1,.h2,.h3,.h4,.h5,.h6')];
  const level = (h) => +(h.tagName.match(/^H(\d)$/)?.[1] || String(h.className).match(/\bh(\d)\b/)?.[1] || 6);
  let si = -1;
  for (let k = 0; k < heads.length; k++) {
    if (heads[k].compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING) si = k; else break;
  }
  const sectionEl = si >= 0 ? heads[si] : null;
  let nextEl = null;
  if (sectionEl) for (let k = si + 1; k < heads.length; k++) if (level(heads[k]) <= level(sectionEl)) { nextEl = heads[k]; break; }

  window.__citeSnap = { range, textRange, sectionEl, nextEl };
  window.__citeMeasure = () => {
    const s = window.__citeSnap;
    const doc = (r) => ({ x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height });
    const q = doc(s.range.getBoundingClientRect());
    const b = doc(s.textRange.getBoundingClientRect());
    let sec = null;
    if (s.sectionEl) {
      const h = doc(s.sectionEl.getBoundingClientRect());
      const bottom = s.nextEl ? s.nextEl.getBoundingClientRect().top + scrollY - 4 : document.documentElement.scrollHeight;
      const x = Math.min(h.x, b.x);
      sec = { x, y: h.y, width: Math.max(h.x + h.width, b.x + b.width) - x, height: Math.max(bottom, b.y + b.height) - h.y };
    }
    // Rendered text lines near the frame (doc coords), so crops can add whole lines and never cut one.
    const near = (r) => r.bottom + scrollY > b.y - 1500 && r.top + scrollY < b.y + b.height + 1500;
    const lineRects = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const rr = document.createRange();
    for (let n; (n = walker.nextNode()); ) {
      const p = n.parentElement;
      if (!p || !n.nodeValue.trim() || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
      if (!near(p.getBoundingClientRect())) continue;
      rr.selectNodeContents(n);
      for (const r of rr.getClientRects()) if (r.height > 0 && r.width > 0) lineRects.push([r.top + scrollY, r.bottom + scrollY]);
    }
    // Merge fragments on the same visual line.
    lineRects.sort((a, c) => a[0] - c[0]);
    const lines = [];
    for (const [t, bt] of lineRects) {
      const last = lines.at(-1);
      if (last && t < last[1] - 2 && bt > last[0] + 2) { last[0] = Math.min(last[0], t); last[1] = Math.max(last[1], bt); }
      else lines.push([t, bt]);
    }
    // The document is never shorter than the window; the body's own box is where content ends.
    const body = document.body.getBoundingClientRect();
    const contentH = Math.ceil(body.bottom + scrollY + (parseFloat(getComputedStyle(document.body).marginBottom) || 0));
    return { q, b, sec, lines, docH: Math.min(document.documentElement.scrollHeight, Math.max(contentH, q.y + q.height + 16)), docW: document.documentElement.scrollWidth };
  };

  const quoteOnPage = raw.slice(hit.rawStart, hit.rawEnd).replace(/\s+/g, ' ').trim();
  const flatWs = (s) => s.replace(/\s+/g, ' ').trim();
  const domDiffers = flatWs(range.toString()) !== quoteOnPage;
  // A text-fragment term can't cross a line/block boundary, so a match that spans lines is linked
  // with start,end terms taken from its first and last line.
  const lines = raw.slice(hit.rawStart, hit.rawEnd).split('\u2029').map(flatWs).filter(Boolean);
  const lastWords = (s, n) => s.split('\u2029').pop().trim().split(/\s+/).filter(Boolean).slice(-n).join(' ');
  const firstWords = (s, n) => s.split('\u2029')[0].trim().split(/\s+/).filter(Boolean).slice(0, n).join(' ');

  const flatText = (e) => flatWs(e.textContent).replace(/\s*[¶#]\s*$/, '');
  const firstH1 = document.querySelector('h1,.h1');
  const pageTitle = document.title.trim()
    || document.querySelector('meta[property="og:title"]')?.content?.trim()
    || (firstH1 ? flatText(firstH1) : '');
  let text = frameEl.innerText || frameEl.textContent;
  if (frameEl.tagName === 'PRE') {
    // Plain-text documents (RFCs): use the blank-line-separated paragraph(s) around the quote.
    const paras = text.split(/\n\s*\n/);
    const k = paras.findIndex((p) => flatWs(p).includes(quoteOnPage.slice(0, 40)));
    if (k !== -1) text = (k > 0 && flatWs(paras[k]).length < 200 ? paras[k - 1] + ' ' : '') + paras[k];
  }
  let excerpt = text.replace(/\[[^\]]{1,8}\]/g, '').replace(/\s+/g, ' ').trim();
  if (excerpt.length > 700) {
    const k = Math.max(0, excerpt.indexOf(quoteOnPage.slice(0, 40)));
    excerpt = (k > 250 ? '…' : '') + excerpt.slice(Math.max(0, k - 250), k + quoteOnPage.length + 250) + '…';
  }
  return {
    match,
    score: hit.score,
    occurrences,
    occurrence: hit.occurrence || 1,
    contextMissed,
    quoteOnPage,
    domDiffers,
    lines,
    before: lastWords(raw.slice(Math.max(0, hit.rawStart - 120), hit.rawStart), 3),
    after: firstWords(raw.slice(hit.rawEnd, hit.rawEnd + 120), 3),
    excerpt,
    pageTitle,
    section: sectionEl ? flatText(sectionEl) : null,
    hidden,
    revealed,
    darkPage,
  };
}

// ---------- URL policy ----------

const CONCURRENCY = 4;
const SLOW_TYPES = new Set(['image', 'font', 'media']);

// URL policy. Defense in depth, not a sandbox: whoever runs this can already reach any host
// from their shell. It stops accidents and prompt-injected "citations".
// - Only http/https pages can be cited (no file://, chrome://): local files must never be quoted.
// - Cloud metadata / link-local addresses are blocked: by literal host for every request, and by
//   resolved IP for navigations (the only responses whose content we read; subresource responses
//   never reach our output, and CORS keeps page scripts from reading metadata responses).
//   Residual risk, accepted: DNS rebinding between our lookup and the browser's fetch.
// - localhost/private networks stay allowed on purpose: internal docs on a VPN are a core use case.
const METADATA = new BlockList();
METADATA.addSubnet('169.254.0.0', 16, 'ipv4'); // AWS/GCP/Azure IMDS + link-local
METADATA.addAddress('100.100.100.200', 'ipv4'); // Alibaba Cloud
METADATA.addSubnet('fe80::', 10, 'ipv6');
METADATA.addAddress('fd00:ec2::254', 'ipv6'); // AWS IMDS over IPv6
// The same IPv4 targets embedded in IPv6: mapped (::ffff:0:0/96), compatible (::/96), NAT64 (64:ff9b::/96).
// BlockList parses any IPv6 text form, so ::ffff:169.254.169.254 and ::ffff:a9fe:a9fe both match.
for (const prefix of ['::ffff:', '::', '64:ff9b::']) {
  METADATA.addSubnet(`${prefix}169.254.0.0`, 112, 'ipv6');
  METADATA.addAddress(`${prefix}100.100.100.200`, 'ipv6');
}
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal']);

function blockedIp(ip) {
  const v = isIP(ip);
  return v ? METADATA.check(ip, v === 4 ? 'ipv4' : 'ipv6') : false;
}
const hostOf = (u) => u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

function urlProblem(raw, { subresource = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { return 'Invalid URL'; }
  const okSchemes = subresource ? ['http:', 'https:', 'data:', 'blob:'] : ['http:', 'https:'];
  if (!okSchemes.includes(u.protocol)) return `Blocked URL scheme ${u.protocol} (only http/https pages can be cited)`;
  if (u.protocol === 'data:' || u.protocol === 'blob:') return null;
  const host = hostOf(u);
  if (METADATA_NAMES.has(host) || blockedIp(host)) return `Blocked host ${host} (cloud metadata / link-local)`;
  return null;
}

async function resolveHost(host) {
  if (isIP(host)) return [host];
  try { return (await lookup(host, { all: true })).map((a) => a.address); } catch { return []; } // unresolvable: the browser reports it
}

// ---------- internal hosts ----------

// Internal = private/loopback address or an intranet-style name. Results from internal pages are
// flagged so the agent can treat their content as possibly confidential.
const PRIVATE = new BlockList();
for (const [net, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['100.64.0.0', 10]]) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
  PRIVATE.addSubnet(`::ffff:${net}`, 96 + bits, 'ipv6');
}
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
const INTRANET_SUFFIXES = ['.local', '.internal', '.intranet', '.corp', '.lan', '.home.arpa', '.localhost'];
function isInternal(host, ips) {
  if (host === 'localhost' || (!isIP(host) && !host.includes('.')) || INTRANET_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return ips.some((ip) => { const f = isIP(ip); return !!f && PRIVATE.check(ip, f === 4 ? 'ipv4' : 'ipv6'); });
}

// Every page navigation (first URL and each redirect hop): URL rules plus a resolved-IP metadata check.
async function navProblem(raw) {
  const problem = urlProblem(raw);
  if (problem) return problem;
  const host = hostOf(new URL(raw));
  const ips = await resolveHost(host);
  const bad = !isIP(host) && ips.find(blockedIp);
  if (bad) return `Blocked host ${host} (resolves to ${bad}: cloud metadata / link-local)`;
  return null;
}

// ---------- screenshots ----------

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// Document-coordinate rectangle to capture, before padding and size caps.
// `context` adds whole rendered text lines above and below.
function frameRect(m, { frame, context }) {
  const { q, b, sec, lines } = m;
  let r = b; // paragraph (or table row)
  if (frame === 'quote') r = { x: b.x, y: q.y, width: b.width, height: q.height };
  else if (frame === 'section' && sec) r = sec;
  let top = r.y, bottom = r.y + r.height;
  if (context > 0) {
    const above = lines.filter(([, lb]) => lb <= top + 2).reverse();
    const below = lines.filter(([lt]) => lt >= bottom - 2);
    if (above.length) top = above[Math.min(context, above.length) - 1][0];
    if (below.length) bottom = below[Math.min(context, below.length) - 1][1];
  }
  return { x: r.x, y: top, width: r.width, height: bottom - top };
}

// Move a crop edge that slices through a text line to that line's boundary (shrinking the crop).
// Snap exactly to the boundary: line boxes already include ascenders/descenders, and lines in
// preformatted text touch each other, so any extra gap would land inside the neighbouring line.
function snapEdges(lines, top, bottom) {
  const crosses = (y, lt, lb) => lt < y - 0.5 && lb > y + 0.5;
  const t = lines.find(([lt, lb]) => crosses(top, lt, lb));
  const b = lines.find(([lt, lb]) => crosses(bottom, lt, lb));
  if (t) top = t[1];
  if (b) bottom = b[0];
  return [top, Math.max(bottom, top + 1)];
}

function clipFor(m, shot, vw, vh) {
  if (shot.frame === 'viewport') {
    const top = clamp(m.q.y + m.q.height / 2 - vh / 2, 0, m.docH - vh);
    return { x: 0, y: top, width: vw, height: Math.min(vh, m.docH) };
  }
  const padX = 16, padY = 8;
  const f = frameRect(m, shot);
  let r = { x: f.x - padX, y: f.y - padY, width: f.width + 2 * padX, height: f.height + 2 * padY };
  // Too tall: keep max_height around the quote, without slicing lines. Too wide (wide tables): keep
  // the viewport width around the quote.
  const maxH = Math.min(shot.max_height, vh - 40);
  if (r.height > maxH) {
    const top = clamp(m.q.y + m.q.height / 2 - maxH / 2, r.y, r.y + r.height - maxH);
    const [t, b] = snapEdges(m.lines.filter(([lt, lb]) => lb <= m.q.y + 1 || lt >= m.q.y + m.q.height - 1), top, top + maxH);
    r = { ...r, y: t, height: b - t };
  }
  if (r.width > vw) r = { ...r, x: clamp(m.q.x + m.q.width / 2 - vw / 2, r.x, r.x + r.width - vw), width: vw };
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return { x, y, width: r.width - (x - r.x), height: r.height - (y - r.y) };
}

const measure = () => window.__citeMeasure();

// Headless Chromium can stall a screenshot of a background page while other pages are busy
// (seen intermittently in parallel batches). Capture one page at a time, in front, with a retry.
let captureLock = Promise.resolve();
function captureExclusive(page, opts) {
  const run = captureLock.then(async () => {
    for (let attempt = 1; ; attempt++) {
      await page.bringToFront();
      try { return await page.screenshot({ ...opts, timeout: 10000 }); }
      catch (e) { if (attempt >= 2 || !/Timeout/.test(e.message)) throw e; }
    }
  });
  captureLock = run.catch(() => {});
  return run;
}

// Late-loading content (images, fonts, injected banners) keeps reflowing long pages after `load`.
// Poll until the quote stops moving, shoot, and re-shoot if it moved during the capture.
async function screenshotStable(page, out, shot) {
  const same = (a, b) => Math.abs(a.q.y - b.q.y) < 1 && Math.abs(a.b.height - b.b.height) < 1;
  const { width: vw, height: vh } = page.viewportSize();
  const deadline = Date.now() + 6000;
  for (let attempt = 0; attempt < 3; attempt++) {
    let m = await page.evaluate(measure);
    while (Date.now() < deadline) {
      await page.waitForTimeout(300);
      const cur = await page.evaluate(measure);
      if (same(m, cur)) break;
      m = cur;
    }
    // Capture from the viewport, not fullPage: fullPage resizes the window to the whole document
    // (~20k px on Wikipedia), which triggers lazy loading and intermittently stalls rendering.
    // Center the clip so sticky headers don't cover it.
    const c = clipFor(m, shot, vw, vh);
    const [sx, sy] = await page.evaluate(([x, y]) => { window.scrollTo(Math.max(0, x), Math.max(0, y)); return [window.scrollX, window.scrollY]; },
      [c.x - (vw - c.width) / 2, c.y - (vh - c.height) / 2]);
    // A full-width clip (wide tables) always spans the whole viewport, so a pinned first column
    // at the viewport's left edge is fully inside it even when scrolling stopped short.
    const full = c.width >= vw - 1;
    const x0 = full ? 0 : Math.max(0, c.x - sx), y0 = Math.max(0, c.y - sy);
    const x1 = full ? vw : Math.min(vw, c.x - sx + c.width), y1 = Math.min(vh, c.y - sy + c.height);
    const before = await page.evaluate(measure); // scrolling can shift lazy content; re-check below
    await captureExclusive(page, { path: out, clip: { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) } });
    if (same(before, await page.evaluate(measure))) return;
  }
}

// ---------- running ----------

function friendlyError(e, base, blockedBy) {
  let error = String(e.message || e).split('\n')[0];
  if (blockedBy && /ERR_BLOCKED_BY_CLIENT/.test(error)) error = `${blockedBy} (reached via redirect from ${base})`;
  else if (/Download is starting/.test(error) || /\.pdf($|\?)/i.test(base)) error = 'Not an HTML page (PDF or file download) - not supported; cite with a manual excerpt';
  return error;
}

// One page load per group (URL + rendering options); every quote in the group shares the page.
async function snapGroup(browser, base, items, timeout) {
  const shots = items.some((it) => it.out);
  const { width, theme, scale } = items[0].shot;
  const height = Math.min(2200, Math.max(900, ...items.map((it) => it.shot.max_height + 120)));
  // Own context per group: service workers can't bypass routing; popups are closed.
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: shots ? scale : 1, colorScheme: theme, serviceWorkers: 'block',
  });
  const page = await context.newPage();
  context.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
  let blockedBy = null; // why a navigation was refused, for a readable error instead of ERR_BLOCKED_BY_CLIENT
  const refuse = (r, why) => { blockedBy ??= why; return r.abort('blockedbyclient'); };
  try {
    const problem = await navProblem(base);
    if (problem) throw new Error(problem);
    await context.route('**/*', async (r) => {
      const req = r.request();
      const nav = req.isNavigationRequest();
      const why = nav ? await navProblem(req.url()) : urlProblem(req.url(), { subresource: true });
      if (why) return nav ? refuse(r, why) : r.abort('blockedbyclient');
      if (!shots && SLOW_TYPES.has(req.resourceType())) return r.abort();
      if (!nav) return r.continue();
      // Route handlers don't see redirect hops, so fetch without following redirects,
      // vet the Location, then hand the 3xx to the browser (its follow-up is routed again).
      // A failed fetch (refused, DNS, TLS) must fail this navigation, not crash the batch.
      let resp;
      try { resp = await r.fetch({ maxRedirects: 0 }); }
      catch (e) {
        const reason = /ECONNREFUSED/.test(e.message) ? 'connectionrefused' : /ENOTFOUND|EAI_AGAIN/.test(e.message) ? 'namenotresolved' : /timeout/i.test(e.message) ? 'timedout' : 'failed';
        return r.abort(reason).catch(() => {});
      }
      const loc = resp.headers()['location'];
      const locWhy = loc && (await navProblem(new URL(loc, req.url()).href));
      if (locWhy) return refuse(r, locWhy);
      return r.fulfill({ response: resp }).catch(() => {});
    });
    const resp = await page.goto(base, { waitUntil: 'domcontentloaded', timeout });
    const ctype = resp?.headers()['content-type'] || '';
    if (!ctype.includes('html')) throw new Error(`Unsupported content-type: ${ctype || 'unknown'}`);
    if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);
    // Classify where we actually landed (after redirects).
    const finalHost = hostOf(new URL(page.url()));
    const internal = isInternal(finalHost, await resolveHost(finalHost));

    const retrieved = new Date().toISOString().slice(0, 10);
    let waited = false;
    for (const it of items) {
      const base_ = { start: it.start, end: it.end, prefix: it.prefix, suffix: it.suffix, highlight: it.shot.highlight };
      // Visible text first; then hidden text (collapsed sections, tabs); fuzzy only as a last resort.
      const attempts = [{ includeHidden: false, allowFuzzy: false }, { includeHidden: true, allowFuzzy: false }, { includeHidden: false, allowFuzzy: true }];
      const locate = async () => {
        for (const a of attempts) {
          const f = await page.evaluate(locateInPage, { ...base_, ...a });
          if (f.match !== 'none') return [f, a];
          if (a.allowFuzzy) return [f, a];
        }
      };
      let [found, used] = await locate();
      // Client-rendered pages may not have the text yet: wait for the network once, then retry.
      if ((found.match === 'none' || found.match === 'fuzzy') && !waited) {
        waited = true;
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        [found, used] = await locate();
      }
      const result = { ok: found.match !== 'none', match: found.match, url: base, title: found.pageTitle || (await page.title()), retrieved };
      if (!result.ok) {
        if (found.signals?.challenge) result.error = 'Bot check (e.g. Cloudflare) blocked the page - the quote could not be checked; mark it UNVERIFIED';
        else if (found.signals?.password) result.error = 'Login wall: the page asks for a password and the quote is not visible - mark it UNVERIFIED';
        it.result = result;
        continue;
      }
      const notes = [];
      result.quote_on_page = found.quoteOnPage;
      const pin = found.occurrences > 1;
      result.fragment_url = buildFragmentUrl(base, found.quoteOnPage, {
        forceRange: found.domDiffers,
        lines: found.lines,
        prefix: pin ? found.before || null : null,
        suffix: pin ? found.after || null : null,
      });
      // Skip a section that just repeats the page title (e.g. MDN's h1).
      if (found.section && !result.title.toLowerCase().includes(found.section.toLowerCase())) result.section = found.section;
      result.excerpt = found.excerpt;
      if (found.match === 'fuzzy') notes.push(`Quote not on page verbatim; closest sentence (overlap ${found.score.toFixed(2)}). Use quote_on_page, not the original quote.`);
      if (found.occurrences > 1) {
        result.occurrences = found.occurrences;
        result.occurrence = found.occurrence;
        notes.push(it.prefix || it.suffix
          ? (found.contextMissed ? `prefix/suffix matched none of the ${found.occurrences} occurrences; used the first.` : `Picked occurrence ${found.occurrence} of ${found.occurrences} using prefix/suffix.`)
          : `Quote appears ${found.occurrences} times; matched the first. If you meant another, re-run with prefix/suffix (words just before/after it).`);
      }
      if (found.revealed) notes.push('Quote was inside collapsed content; it was expanded for the screenshot.');
      if (found.hidden) {
        result.hidden = true;
        notes.push('Quote is in hidden content (e.g. an inactive tab): no screenshot possible, and the link may not highlight it.');
      }
      if (it.out && it.shot.frame === 'section' && !found.section) notes.push('No heading above the quote; used the paragraph frame.');
      if (it.out && it.shot.theme === 'dark' && !found.darkPage) notes.push('Page has no dark mode; the screenshot uses its light theme.');
      if (internal) result.internal = true;
      if (it.out && !found.hidden) {
        // Re-locate so window.__citeMeasure points at this quote (several quotes may share a page).
        await page.evaluate(locateInPage, { ...base_, ...used });
        await screenshotStable(page, it.out, it.shot);
        result.screenshot = it.out;
      }
      if (notes.length) result.note = notes.join(' ');
      it.result = result;
    }
  } catch (e) {
    const error = friendlyError(e, base, blockedBy);
    for (const it of items) it.result ??= { ok: false, url: base, error };
  } finally {
    await context.close();
  }
}

async function run(input, timeout) {
  const { defaults = {}, cites } = Array.isArray(input) ? { cites: input } : input;
  if (!Array.isArray(cites)) throw new Error('Batch input must be an array or {"defaults": {...}, "cites": [...]}');
  const items = cites.map((c, idx) => {
    const r = { ...defaults, ...c };
    const { base, fragment } = parseTextFragment(r.url || '');
    const start = r.quote ?? fragment?.start;
    const [shot, optError] = screenshotOptions(r);
    const it = {
      idx, base, start, end: r.quote ? null : fragment?.end ?? null, out: r.out, shot,
      prefix: r.prefix ?? (r.quote ? null : fragment?.prefix) ?? null,
      suffix: r.suffix ?? (r.quote ? null : fragment?.suffix) ?? null,
    };
    if (!r.url || !start) it.result = { ok: false, url: r.url ?? null, error: 'Need url plus quote (or a #:~:text= URL)' };
    else if (optError) it.result = { ok: false, url: r.url, error: optError };
    return it;
  });
  const groups = new Map();
  for (const it of items) {
    if (it.result) continue;
    const key = [it.base, it.shot.width, it.shot.theme, it.out ? it.shot.scale : 1].join('|');
    groups.set(key, [...(groups.get(key) || []), it]);
  }
  if (groups.size) {
    const browser = await chromium.launch();
    try {
      const queue = [...groups.values()];
      const worker = async () => { for (let g; (g = queue.shift()); ) await snapGroup(browser, g[0].base, g, timeout); };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    } finally {
      await browser.close();
    }
  }
  return items.map((it) => it.result);
}

const exitCode = (results) => (results.some((r) => r.error) ? 2 : results.some((r) => !r.ok) ? 1 : 0);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.batch) {
    const text = args.batch === '-' ? readFileSync(0, 'utf8') : readFileSync(args.batch, 'utf8');
    const results = await run(JSON.parse(text), args.timeout);
    console.log(JSON.stringify(results, null, 2));
    process.exit(exitCode(results));
  }
  if (args.help || !args.url) {
    console.error('Usage: node snap.mjs <url[#:~:text=...]> [--quote "text"] [--out shot.png] [options]\n'
      + '       node snap.mjs --batch <cites.json | ->\n'
      + 'Options: --prefix --suffix --frame quote|paragraph|section|viewport --context N --width PX\n'
      + '         --max-height PX --highlight COLOR|none --theme light|dark --scale 1-3 --timeout MS');
    process.exit(2);
  }
  const { batch, help, url, timeout, ...rest } = args;
  const [result] = await run([{ url, ...rest }], timeout);
  console.log(JSON.stringify(result, null, 2));
  process.exit(exitCode([result]));
}

main();
