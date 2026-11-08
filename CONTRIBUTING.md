# Contributing

Thanks for helping. Bug reports, new edge cases and fixes are all welcome.

## Set up

You need Node 18 or later.

```bash
git clone https://github.com/alanchoi00/receipts.git
cd receipts
npm install --prefix skills/citing-sources-with-excerpts/scripts
npx --prefix skills/citing-sources-with-excerpts/scripts playwright install chromium
```

To try your changes in Claude Code, load the plugin from your clone:

```bash
claude --plugin-dir .
```

## How it's laid out

| Path | What it is |
|---|---|
| `skills/citing-sources-with-excerpts/SKILL.md` | Instructions Claude reads: when to cite, how to call the script, how to format the result |
| `skills/citing-sources-with-excerpts/scripts/snap.mjs` | The script: loads pages, finds quotes, builds links, takes screenshots |
| `examples/cases.json` | Every edge case: input and expected result |
| `examples/fixtures/` | Small local pages for cases a live site can't reliably show |
| `examples/build.mjs` | Runs every case, checks it, and regenerates `examples/README.md` |

## Test your change

Every change to the script must keep all example cases passing:

```bash
node examples/build.mjs --check      # verify everything, write nothing
node examples/build.mjs --offline    # skip the cases that need live websites
```

If you changed behavior, regenerate the examples page and look at the screenshots it produced:

```bash
node examples/build.mjs              # rewrites examples/README.md and examples/refs/
```

## Add an edge case

Fixing a bug or adding a feature? Add a case that would have failed before, so it stays fixed.

1. If a live site can't show the case reliably, add a small page to `examples/fixtures/`.
2. Add an entry to `examples/cases.json`:

   ```json
   {
     "id": "short-kebab-id",
     "group": "matching",
     "title": "What it tests, in a few words",
     "why": "One or two sentences on why it matters and what should happen.",
     "cite": { "url": "{{base}}/your-fixture.html", "quote": "text to find", "out": true },
     "expect": { "ok": true, "match": "exact", "screenshot": true }
   }
   ```

   `{{base}}` is the local fixture server. Add `"live": true` for cases that use real websites. `expect` can check `ok`, `match`, `hidden`, `internal`, `occurrence`, `occurrences`, `screenshot`, and substrings of `error`, `note` and the link (`fragment`).
3. Run `node examples/build.mjs` and check the new screenshot by eye.

## Change the skill instructions

`SKILL.md` is read by Claude every time the skill runs, so keep it short and concrete. When you change how Claude should behave, test it the way users will use it: give a fresh Claude session a few realistic prompts and check what it actually does, not just what you expect it to do.

## Pull requests

- Keep each PR to one change.
- Describe what changed and why, and how you tested it.
- Don't include secrets, tokens or private URLs in code, fixtures or screenshots.

Found a security problem? Please follow [SECURITY.md](SECURITY.md) instead of opening an issue.
