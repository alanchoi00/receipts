---
name: citing-sources-with-excerpts
description: Use when citing web pages as evidence, either in a markdown file (specs, design notes, RFCs, READMEs) or in a chat answer where the user asks for sources, references, citations, quotes, or proof they can check, or when a reader needs to see what a linked source actually says without opening it.
---

# Citing Sources with Excerpts

## Overview

Every cited claim carries its proof inline: the verbatim passage, a link that jumps to and highlights that passage, and optionally a screenshot. Readers verify without clicking; clicking lands exactly on the text. Works for markdown files and for answers in chat.

**Every quote must come from `snap.mjs` output, never from memory, a search result's summary, or a summarizing fetch tool.** Search summaries and WebFetch-style tools paraphrase pages; only the script checks the rendered text verbatim.

**Check claims, not just quotes.** A matching quote proves the page says *that*. It proves nothing about what the page doesn't say. Two kinds of claim always go through the script as their own batch entries, including when you are only "verifying a draft":

- **Absence:** before writing that a page doesn't say, mention, or require something, add the sentence that would be there if it did (e.g. `Responses with the 429 status code MUST NOT be stored by a cache.`). Only `match: none` supports the absence, and then write "not found on <page>", never "the spec says nothing about X".
- **Disagreement:** when memory, a search summary, a draft you already wrote, or this skill's examples disagree about what a page says, add the disputed sentence. The script's result settles it, whichever side it favours. (Every quote in this skill's examples was verified with the script.)

## Setup (once per machine)

```bash
npm install --prefix <skill-dir>/scripts && npx --prefix <skill-dir>/scripts playwright install chromium
```

`<skill-dir>` is the directory containing this SKILL.md.

## The script

Draft the doc or answer first, collect every citation, then verify them **all in one batch call**:

```bash
node <skill-dir>/scripts/snap.mjs --batch - <<'EOF'
[
  {"url": "https://www.rfc-editor.org/rfc/rfc6585.html", "quote": "Responses with the 429 status code MUST NOT be stored by a cache."},
  {"url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After", "quote": "A non-negative decimal integer", "out": "/abs/path/docs/refs/delay.png"}
]
EOF
```

One browser for the batch; quotes on the same URL share a page load. Use absolute paths for `out`. Input may also be `{"defaults": {...}, "cites": [...]}` to apply screenshot options to every entry. Batch output is a JSON array in input order (single mode, `snap.mjs "<url>" --quote "..."`, prints one object). Each entry:

| Field | Use |
|---|---|
| `ok` / `match` | `exact`/`loose` = verbatim. `fuzzy` = your quote was wrong; **use `quote_on_page` instead** and re-check the claim still holds. `none` = not on page. |
| `quote_on_page` | The text to put in the blockquote. Never your original `--quote`. |
| `fragment_url` | The link to use (has `#:~:text=`, highlights in Chrome/Safari/Firefox). |
| `excerpt` | Surrounding paragraph, for checking context (negations, caveats, "except when…"). Want to quote more of it? Re-run with that longer passage as `--quote` so link and screenshot match. |
| `title`, `section`, `retrieved` | The attribution line: `[<title> — <section>](fragment_url) · retrieved <date>`, or `[<title>](fragment_url)` when `section` is absent. Use these fields; don't add section numbers from memory. |
| `occurrences` / `occurrence` | Present when the quote appears more than once. Check `excerpt` is the one you meant; if not, re-run with `prefix`/`suffix` (the words just before/after it on the page). |
| `hidden` | Quote is in content the page hides (e.g. an inactive tab): verified, but no screenshot. |
| `note` | Anything else worth knowing (fuzzy match, expanded collapsed section, frame fallback). Read it. |
| `internal` | The page is on an internal network. Its content may be confidential; don't quote more than the claim needs. |

Exit 0 = all found, 1 = some not found, 2 = some errored (PDF, 4xx, login wall, bot check, timeout). Expect one follow-up batch: put every entry that needs another pass (failed, fuzzy, wrong occurrence, or a longer passage wanted) into it together.

## Screenshot options

Optional fields on any entry (or in `defaults`). Map the user's wording; with no wording, leave them out.

| User says | Field |
|---|---|
| "tight screenshots", "just the quote" | `"frame": "quote"` (default `paragraph`) |
| "show the whole section" | `"frame": "section"` (height cap rises to 1200 automatically) |
| "full-screen", "show the page around it" | `"frame": "viewport"` |
| "a couple of lines around it" | `"context": 2` (whole text lines above and below) |
| "mobile-sized" | `"width": 390` (default 1100) |
| "keep them short" | `"max_height": 150` (default 500; crop centers on the quote) |
| "highlight in yellow", "no highlight" | `"highlight": "#fff3a0"` / `"none"` |
| "dark mode" | `"theme": "dark"` (only sites with a dark theme; `note` says otherwise) |
| "smaller images" | `"scale": 1` (default 2) |

These only shape screenshots. Context wanted in the text itself (or with no screenshots) → quote a longer passage taken from `excerpt`, re-run in the follow-up batch. Quotes in table cells automatically frame the row plus the header row. Every option, with its screenshot, is in the repo's `examples/README.md`.

## Output format

Pick the format by where the text goes.

**Markdown file:** claim in the prose, footnote with the proof:

```md
Clients should not cache rate-limit responses.[^429-cache]

[^429-cache]: > Responses with the 429 status code MUST NOT be stored by a cache.
    >
    > — [Additional HTTP Status Codes — 4. 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585.html#:~:text=Responses%20with%20the%20429%20status%20code%20MUST%20NOT%20be%20stored%20by%20a%20cache.) · retrieved 2026-11-08
    >
    > ![RFC 6585: 429 must not be cached](refs/429-cache.png)
```

- Footnote IDs are short descriptive slugs, not numbers. Reuse the same `[^id]` when the same passage backs two claims.
- Save screenshots to `refs/` next to the markdown file; filename = footnote slug. Delete PNGs for citations you dropped.

**Chat answer:** no footnotes (terminals show them as raw text). Put the proof directly under the claim it supports:

```md
Clients should not cache rate-limit responses:

> Responses with the 429 status code MUST NOT be stored by a cache.
> — [Additional HTTP Status Codes — 4. 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585.html#:~:text=Responses%20with%20the%20429%20status%20code%20MUST%20NOT%20be%20stored%20by%20a%20cache.)
```

- No `retrieved` date (the answer is the retrieval).
- Save chat screenshots under the system temp directory (e.g. `$TMPDIR/receipts/<slug>.png`), never into the user's project. If your host has a tool for showing the user a file or image, show each screenshot with it; otherwise give each one's full absolute path on its own line after the quote.
- No screenshots requested → end the answer with a one-line offer, e.g. "Want screenshots of these passages?"

**Both:**
- Your own reasoning or recommendation gets no quote; say it is your (or the team's) reasoning, not the source's. A factual claim about the outside world (how libraries, browsers, or standards behave) needs a citation or must be phrased as an expectation.
- Screenshots are **opt-in**: they're cheap (about half a second per page) but add image files the user has to keep or delete. Add `"out"` only when the user asks for screenshots, or, in a markdown file, the evidence is visual (a table, figure, code layout) where the text alone loses meaning. Include an image or path only for entries with `screenshot` in the result.
- Quote the shortest passage that fully supports the claim (one sentence is typical).

## When the script fails

| Result | Do |
|---|---|
| `match: fuzzy` | Use `quote_on_page` (the screenshot already highlights it). If it no longer supports your claim, change the claim. |
| `match: none` | Search the page another way (different passage, different section URL). Still none → drop the claim or mark it `**UNVERIFIED:**` with a plain link. Never present an unverified quote as a blockquote. |
| `ok: false` + error (PDF, login wall, bot check, 403) | Plain link + `**UNVERIFIED (could not load: <error>)**`. Do not fabricate the quote from memory or WebFetch. |
| `occurrences` > 1 and `excerpt` is the wrong one | Re-run with `"prefix"` or `"suffix"` set to the neighbouring words of the one you meant. |

## Common Mistakes

- Quoting what the page "basically says" → blockquotes are verbatim only; paraphrase goes in the prose.
- Using a section anchor (`#section-4`) instead of `fragment_url` → reader still has to hunt.
- Citing a passage whose `excerpt` contradicts the claim (e.g. the next sentence says "this does not apply to…").
- Running WebFetch to "verify" → it summarizes; it cannot confirm verbatim text. Use the script.
- Trusting a search tool's answer summary about what a page says or omits → it paraphrases like WebFetch, and often misplaces which section says what. Put the disputed sentence through the script.
- "Verifying" a draft by checking only the quotes already in it → its absence claims and disputed claims go untested, so a false answer looks fully verified.
