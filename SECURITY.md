# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through GitHub instead:

**[Report a vulnerability](https://github.com/alanchoi00/receipts/security/advisories/new)**

Include what you ran (the prompt, or the `snap.mjs` command and input), what happened, and what you expected. A minimal page or URL that reproduces it helps a lot.

You'll get a reply as soon as possible, usually within a week. Once a fix is out, the advisory will credit you, unless you'd rather stay anonymous.

## Supported versions

Only the latest commit on `main` is supported. The plugin has no release branches, and installs track `main`.

## What counts as a vulnerability

The script loads web pages in a headless browser, chosen by Claude, so the boundaries that matter most are:

- **Local file access:** a way to make the script read or quote local files (`file://` URLs and other non-web schemes are blocked).
- **Cloud metadata access:** a way to reach cloud metadata endpoints such as `169.254.169.254`, directly, through redirects, DNS names, or alternative IP notations (these are blocked).
- **Writing outside the requested path:** a way for page content or input to make the script write files anywhere other than the screenshot path it was given.
- **Code execution** on the user's machine beyond the browser's normal sandboxed page scripts.
- **Prompt injection** that makes the skill misrepresent what a page says, for example presenting a quote as verified when the script didn't verify it.

## By design, not vulnerabilities

- **Internal hosts are reachable.** Pages on `localhost` and private networks can be cited on purpose, so internal docs work. Results from them are flagged `internal`.
- **The script isn't a sandbox.** It runs as the user, who can already reach any host from their shell. Organisations that need hard network limits should enforce them at the network level or through Claude Code's managed settings.
- **Third-party websites' content** is shown as found. Disputes about what a site says belong with that site.
