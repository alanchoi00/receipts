---
name: citing-sources-with-excerpts
description: Use when writing or editing markdown (specs, design notes, RFCs, READMEs, research answers) that cites web pages as evidence, or when a reader needs to check what a linked source actually says without opening it.
---

# Citing Sources with Excerpts

## Overview

Every cited claim carries its proof inline: the verbatim passage, a link that jumps to and highlights that passage, and optionally a screenshot. Readers verify without clicking; clicking lands exactly on the text.

**Every quote must come from `snap.mjs` output, never from memory or a summarizing fetch tool.** WebFetch-style tools paraphrase pages; only the script checks the rendered text verbatim.

## Setup (once per machine)

```bash
npm install --prefix <skill-dir>/scripts && npx --prefix <skill-dir>/scripts playwright install chromium
```

`<skill-dir>` is the directory containing this SKILL.md.

## The script

Draft the doc first, collect every citation, then verify them **all in one batch call**:

```bash
node <skill-dir>/scripts/snap.mjs --batch - <<'EOF'
[
  {"url": "https://www.rfc-editor.org/rfc/rfc6585.html", "quote": "Responses with the 429 status code MUST NOT be stored by a cache."},
  {"url": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After", "quote": "A non-negative decimal integer", "out": "docs/refs/delay.png"}
]
EOF
```

One browser for the batch; quotes on the same URL share a page load. Use absolute paths for `out`. Batch output is a JSON array in input order (single mode, `snap.mjs "<url>" --quote "..."`, prints one object). Each entry:

| Field | Use |
|---|---|
| `ok` / `match` | `exact`/`loose` = verbatim. `fuzzy` = your quote was wrong; **use `quote_on_page` instead** and re-check the claim still holds. `none` = not on page. |
| `quote_on_page` | The text to put in the blockquote. Never your original `--quote`. |
| `fragment_url` | The link to use (has `#:~:text=`, highlights in Chrome/Safari/Firefox). |
| `excerpt` | Surrounding paragraph, for checking context (negations, caveats, "except when…"). Want to quote more of it? Re-run with that longer passage as `--quote` so link and screenshot match. |
| `title`, `section`, `retrieved` | The attribution line: `[<title> — <section>](fragment_url) · retrieved <date>`, or `[<title>](fragment_url)` when `section` is absent. Use these fields; don't add section numbers from memory. |

Exit 0 = all found, 1 = some not found, 2 = some errored (PDF, 4xx, login wall, timeout). Expect one follow-up batch: put every entry that needs another pass (failed, fuzzy, or a longer passage wanted) into it together.

## Output format

Claim in the prose, footnote with the proof:

```md
Clients should not cache rate-limit responses.[^429-cache]

[^429-cache]: > Responses with the 429 status code MUST NOT be stored by a cache.
    >
    > — [Additional HTTP Status Codes — 4. 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585.html#:~:text=Responses%20with%20the%20429%20status%20code%20MUST%20NOT%20be%20stored%20by%20a%20cache.) · retrieved 2026-11-08
    >
    > ![RFC 6585: 429 must not be cached](refs/429-cache.png)
```

- Footnote IDs are short descriptive slugs, not numbers. Reuse the same `[^id]` when the same passage backs two claims.
- Your own reasoning or recommendation gets no footnote; say in the prose that it is the team's reasoning, not the source's. A factual claim about the outside world (how libraries, browsers, or standards behave) needs a citation or must be phrased as the team's expectation.
- Screenshots are **opt-in** (they roughly double run time). Add `"out"` only when the user asks for screenshots, or the evidence is visual (a table, figure, code layout) where the text alone loses meaning. Include the image line only for entries with `screenshot` in the result.
- Save screenshots to `refs/` next to the markdown file; filename = footnote slug. Delete PNGs for citations you dropped.
- Quote the shortest passage that fully supports the claim (one sentence is typical).

## When the script fails

| Result | Do |
|---|---|
| `match: fuzzy` | Use `quote_on_page` (the screenshot already highlights it). If it no longer supports your claim, change the claim. |
| `match: none` | Search the page another way (different passage, different section URL). Still none → drop the claim or mark it `**UNVERIFIED:**` with a plain link. Never keep an unverified quote in a blockquote. |
| `ok: false` + error (PDF, login, 403) | Plain link + `**UNVERIFIED (could not load: <error>)**`. Do not fabricate the quote from memory or WebFetch. |

## Common Mistakes

- Quoting what the page "basically says" → blockquotes are verbatim only; paraphrase goes in the prose.
- Using a section anchor (`#section-4`) instead of `fragment_url` → reader still has to hunt.
- Citing a passage whose `excerpt` contradicts the claim (e.g. the next sentence says "this does not apply to…").
- Running WebFetch to "verify" → it summarizes; it cannot confirm verbatim text. Use the script.
