#!/usr/bin/env node
// Find a quote on a web page, return the surrounding excerpt + a text-fragment URL,
// and optionally save a cropped screenshot with the quote highlighted.
//
// Usage:
//   node snap.mjs <url> [--quote "text"] [--out shot.png] [--timeout 30000]
//   node snap.mjs --batch cites.json        (or --batch - to read stdin)
// <url> may already contain a text fragment (#:~:text=...); --quote overrides it.
// Batch input: [{"url": "...", "quote": "...", "out": "optional.png"}, ...]
// Single mode prints one JSON object; batch prints an array in input order.
// Exit 0 = all found, 1 = some not found, 2 = some error.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

function parseArgs(argv) {
  const args = { timeout: 30000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quote') args.quote = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--batch') args.batch = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else rest.push(a);
  }
  args.url = rest[0];
  return args;
}

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

// encodeURIComponent leaves '-' alone, but '-' , '&' are syntax inside text fragments.
const encFrag = (s) => encodeURIComponent(s).replace(/-/g, '%2D').replace(/,/g, '%2C');

function buildFragmentUrl(base, text) {
  const words = text.trim().split(/\s+/);
  if (text.length <= 160 || words.length <= 12) return `${base}#:~:text=${encFrag(text.trim())}`;
  return `${base}#:~:text=${encFrag(words.slice(0, 5).join(' '))},${encFrag(words.slice(-5).join(' '))}`;
}

// Runs inside the page. Builds a normalized text index over visible text nodes,
// locates the quote (exact -> loose -> fuzzy), highlights it, returns geometry + excerpt.
function locateInPage({ start, end }) {
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

  const nodes = []; // {node, rawStart}
  let raw = '';
  let lastBlock = null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || !n.nodeValue) return NodeFilter.FILTER_REJECT;
      for (let e = p; e; e = e.parentElement) if (SKIP.has(e.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
      if (p.checkVisibility && !p.checkVisibility()) return NodeFilter.FILTER_REJECT;
      if (isRefMarker(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n; (n = walker.nextNode()); ) {
    const b = blockOf(n.parentElement);
    // U+2029 marks block boundaries; literal newlines inside a text node are just wrapping.
    if (lastBlock && b !== lastBlock) raw += '\u2029';
    lastBlock = b;
    nodes.push({ node: n, rawStart: raw.length });
    raw += n.nodeValue;
  }

  const CHARMAP = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' ' };
  // mode 'norm': lowercase, unify quotes/dashes, collapse whitespace. mode 'loose': alphanumerics only.
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

  function find(mode) {
    const page = normalize(raw, mode);
    const q1 = normalize(start, mode).text.trim();
    if (!q1) return null;
    const i = page.text.indexOf(q1);
    if (i === -1) return null;
    let j = i + q1.length;
    if (end) {
      const q2 = normalize(end, mode).text.trim();
      const k = page.text.indexOf(q2, j);
      if (k === -1 || k - j > 5000) return null;
      j = k + q2.length;
    }
    return { rawStart: page.map[i], rawEnd: page.map[j - 1] + 1 };
  }

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

  let match = 'exact';
  let hit = find('norm');
  if (!hit) { match = 'loose'; hit = find('loose'); }
  if (!hit) { match = 'fuzzy'; hit = fuzzy(); }
  if (!hit) return { match: 'none' };

  const pos = (r) => {
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid].rawStart <= r) lo = mid; else hi = mid - 1; }
    const { node, rawStart } = nodes[lo];
    return [node, Math.min(Math.max(r - rawStart, 0), node.nodeValue.length)];
  };
  const range = document.createRange();
  range.setStart(...pos(hit.rawStart));
  range.setEnd(...pos(hit.rawEnd));

  // Highlight without mutating the DOM (CSS Custom Highlight API).
  const style = document.createElement('style');
  style.textContent = '::highlight(cite-snap){background:#f8d9b8;color:inherit}';
  document.head.appendChild(style);
  CSS.highlights.set('cite-snap', new Highlight(range));

  const startEl = range.startContainer.parentElement;
  const block = startEl.closest('p,li,blockquote,dd,td,th,pre,figcaption,h1,h2,h3,h4,h5,h6') || blockOf(startEl);
  block.scrollIntoView({ block: 'center' });
  const r = range.getBoundingClientRect();
  // Measure the block's text, not its box: floats (infoboxes) can overlap a paragraph's box.
  const textRange = document.createRange();
  textRange.selectNodeContents(block);
  const b = textRange.getBoundingClientRect();
  window.__citeSnap = { range, textRange }; // re-measured cheaply by measureStored()

  const quoteOnPage = raw.slice(hit.rawStart, hit.rawEnd).replace(/\s+/g, ' ').trim();

  // Nearest heading before the quote (real <hN> or RFC-style span.hN).
  const flatText = (e) => e.textContent.replace(/\s+/g, ' ').replace(/\s*[¶#]\s*$/, '').trim();
  let section = null;
  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6,.h1,.h2,.h3,.h4,.h5,.h6')) {
    if (h.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING) section = h;
    else break;
  }
  const firstH1 = document.querySelector('h1,.h1');
  const pageTitle = document.title.trim()
    || document.querySelector('meta[property="og:title"]')?.content?.trim()
    || (firstH1 ? flatText(firstH1) : '');
  let text = block.innerText;
  if (block.tagName === 'PRE') {
    // Plain-text documents (RFCs): use the blank-line-separated paragraph(s) around the quote.
    const paras = text.split(/\n\s*\n/);
    const flat = (s) => s.replace(/\s+/g, ' ').trim();
    const k = paras.findIndex((p) => flat(p).includes(quoteOnPage.slice(0, 40)));
    if (k !== -1) text = (k > 0 && flat(paras[k]).length < 200 ? paras[k - 1] + ' ' : '') + paras[k];
  }
  let excerpt = text.replace(/\[[^\]]{1,8}\]/g, '').replace(/\s+/g, ' ').trim();
  if (excerpt.length > 700) {
    const k = Math.max(0, excerpt.indexOf(quoteOnPage.slice(0, 40)));
    excerpt = (k > 250 ? '…' : '') + excerpt.slice(Math.max(0, k - 250), k + quoteOnPage.length + 250) + '…';
  }
  return {
    match,
    score: hit.score,
    quoteOnPage,
    excerpt,
    pageTitle,
    section: section ? flatText(section) : null,
    rangeRect: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height },
    blockRect: { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height },
  };
}

const CONCURRENCY = 4;
const SLOW_TYPES = new Set(['image', 'font', 'media']);

// Only web pages may be cited: no file://, chrome://, etc. (a prompt-injected "citation" must not
// read local files). Cloud metadata endpoints are blocked too. localhost/private networks stay
// allowed on purpose: internal docs on a VPN are a core use case.
const BLOCKED_HOSTS = /^(169\.254\.\d+\.\d+|\[fe80:[0-9a-f:]*\]|metadata\.google\.internal|metadata)$/i;
function urlProblem(raw, { subresource = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { return 'Invalid URL'; }
  const okSchemes = subresource ? ['http:', 'https:', 'data:', 'blob:'] : ['http:', 'https:'];
  if (!okSchemes.includes(u.protocol)) return `Blocked URL scheme ${u.protocol} (only http/https pages can be cited)`;
  if (BLOCKED_HOSTS.test(u.hostname)) return `Blocked host ${u.hostname} (cloud metadata / link-local)`;
  return null;
}

function cropFor({ rangeRect: q, blockRect: b }) {
  const padX = 16, padY = 8;
  // Crop to the containing block's text; if the block is very tall, crop around the quote instead.
  let top = b.y, bottom = b.y + b.height;
  if (b.height > 500) { top = Math.max(b.y, q.y - 160); bottom = Math.min(b.y + b.height, q.y + q.height + 8); }
  return { x: Math.max(0, b.x - padX), y: Math.max(0, top - padY), width: Math.min(b.width + padX * 2, 1100), height: bottom - top + padY * 2 };
}

// Current document-coordinate rects of the last located quote (see window.__citeSnap).
function measureStored() {
  const { range, textRange } = window.__citeSnap;
  const doc = (r) => ({ x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height });
  return { rangeRect: doc(range.getBoundingClientRect()), blockRect: doc(textRange.getBoundingClientRect()) };
}

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
async function screenshotStable(page, out) {
  const same = (a, b) => Math.abs(a.rangeRect.y - b.rangeRect.y) < 1 && Math.abs(a.blockRect.height - b.blockRect.height) < 1;
  const deadline = Date.now() + 6000;
  for (let attempt = 0; attempt < 3; attempt++) {
    let prev = await page.evaluate(measureStored);
    while (Date.now() < deadline) {
      await page.waitForTimeout(300);
      const cur = await page.evaluate(measureStored);
      if (same(prev, cur)) break;
      prev = cur;
    }
    // Capture from the viewport, not fullPage: fullPage resizes the window to the whole document
    // (~20k px on Wikipedia), which triggers lazy loading and intermittently stalls rendering.
    // Center the crop so sticky headers don't cover it.
    const clip = cropFor(prev);
    const vh = page.viewportSize().height;
    clip.height = Math.min(clip.height, vh - 40);
    const sy = await page.evaluate((y) => { window.scrollTo(0, Math.max(0, y)); return window.scrollY; }, clip.y - (vh - clip.height) / 2);
    prev = await page.evaluate(measureStored); // scrolling can shift lazy content; re-check below
    await captureExclusive(page, { path: out, clip: { ...clip, y: clip.y - sy } });
    if (same(prev, await page.evaluate(measureStored))) return;
  }
}

function friendlyError(e, base) {
  let error = String(e.message || e).split('\n')[0];
  if (/Download is starting/.test(error) || /\.pdf($|\?)/i.test(base)) error = 'Not an HTML page (PDF or file download) - not supported; cite with a manual excerpt';
  return error;
}

// One page load per URL; every quote for that URL is located on the same page.
async function snapUrl(browser, base, items, timeout) {
  const shots = items.some((it) => it.out);
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: shots ? 2 : 1 });
  try {
    const problem = urlProblem(base);
    if (problem) throw new Error(problem);
    // Applies to every request, not just the initial URL.
    await page.route('**/*', async (r) => {
      const req = r.request();
      if (urlProblem(req.url(), { subresource: !req.isNavigationRequest() })) return r.abort('blockedbyclient');
      if (!shots && SLOW_TYPES.has(req.resourceType())) return r.abort();
      if (req.isNavigationRequest()) {
        // Route handlers don't see redirect hops, so fetch without following redirects,
        // vet the Location, then hand the 3xx to the browser (its follow-up is routed again).
        const resp = await r.fetch({ maxRedirects: 0 });
        const loc = resp.headers()['location'];
        if (loc && urlProblem(new URL(loc, req.url()).href)) return r.abort('blockedbyclient');
        return r.fulfill({ response: resp });
      }
      return r.continue();
    });
    const resp = await page.goto(base, { waitUntil: 'domcontentloaded', timeout });
    const ctype = resp?.headers()['content-type'] || '';
    if (!ctype.includes('html')) throw new Error(`Unsupported content-type: ${ctype || 'unknown'}`);
    if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);

    const retrieved = new Date().toISOString().slice(0, 10);
    let waited = false;
    for (const it of items) {
      let found = await page.evaluate(locateInPage, { start: it.start, end: it.end });
      // Client-rendered pages may not have the text yet: wait for the network once, then retry.
      if ((found.match === 'none' || found.match === 'fuzzy') && !waited) {
        waited = true;
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        found = await page.evaluate(locateInPage, { start: it.start, end: it.end });
      }
      const result = { ok: found.match !== 'none', match: found.match, url: base, title: found.pageTitle || (await page.title()), retrieved };
      if (result.ok) {
        result.quote_on_page = found.quoteOnPage;
        result.fragment_url = buildFragmentUrl(base, found.quoteOnPage);
        // Skip a section that just repeats the page title (e.g. MDN's h1).
      if (found.section && !result.title.toLowerCase().includes(found.section.toLowerCase())) result.section = found.section;
        result.excerpt = found.excerpt;
        if (found.match === 'fuzzy') result.note = `Quote not on page verbatim; closest sentence (overlap ${found.score.toFixed(2)}). Use quote_on_page, not the original quote.`;
        if (it.out) {
          // Re-locate so window.__citeSnap points at this quote (several quotes may share a page).
          await page.evaluate(locateInPage, { start: it.start, end: it.end });
          await screenshotStable(page, it.out);
          result.screenshot = it.out;
        }
      }
      it.result = result;
    }
  } catch (e) {
    const error = friendlyError(e, base);
    for (const it of items) it.result ??= { ok: false, url: base, error };
  } finally {
    await page.close();
  }
}

async function run(requests, timeout) {
  const items = requests.map((r, idx) => {
    const { base, fragment } = parseTextFragment(r.url || '');
    const start = r.quote ?? fragment?.start;
    const it = { idx, base, start, end: r.quote ? null : fragment?.end ?? null, out: r.out };
    if (!r.url || !start) it.result = { ok: false, url: r.url ?? null, error: 'Need url plus quote (or a #:~:text= URL)' };
    return it;
  });
  const groups = new Map();
  for (const it of items) if (!it.result) groups.set(it.base, [...(groups.get(it.base) || []), it]);

  if (groups.size) {
    const browser = await chromium.launch();
    try {
      const queue = [...groups.entries()];
      const worker = async () => { for (let g; (g = queue.shift()); ) await snapUrl(browser, g[0], g[1], timeout); };
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
    console.error('Usage: node snap.mjs <url[#:~:text=...]> [--quote "text"] [--out shot.png] [--timeout ms]\n       node snap.mjs --batch <cites.json | ->');
    process.exit(2);
  }
  const [result] = await run([{ url: args.url, quote: args.quote, out: args.out }], args.timeout);
  console.log(JSON.stringify(result, null, 2));
  process.exit(exitCode([result]));
}

main();
