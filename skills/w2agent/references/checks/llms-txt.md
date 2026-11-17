---
id: llms-txt
checks:
  - llms-txt-exists
  - llms-txt-valid
  - llms-txt-links-resolve
fixBy: integrate
---

# Fix guide: llms.txt

## Passes when

The audit fetches `<origin>/llms.txt` and keeps it when the response is HTTP 200, non-empty, and not an HTML document (a 200 labelled `text/html` whose body starts with `<` is rejected). When the root has none, it also tries `docs.`, `developers.` and `developer.` in front of the host (without `www.`), so a file on a docs subdomain counts.

- `llms-txt-exists`: passes (100) when a file was kept, otherwise fails (0). No partial.
- `llms-txt-valid`: scores the text: a line `# title` adds 30, a line `> description` adds 20, any absolute `http(s)://` URL adds 30, a line `## section` adds 20. 70 or more passes, above 0 is `partial`, 0 is `fail`. `skip` when there is no file. A file with a title and links but no description and no section scores 60, which is `partial`.
- `llms-txt-links-resolve`: takes the first 10 absolute URLs in the file (duplicates count, and a URL stops at whitespace, `)`, `>`, `]`, `,` or `:`). A URL with a port is cut at the colon, so `http://host:3000/x` is checked as `http://host`. Each URL is fetched with a 5 second timeout. A status from 200 to 399 resolves. The score is the share that resolves. 100 passes, above 0 is `partial`, 0 is `fail`. A file with no absolute URL is `fail`. `skip` when there is no file.

The links are fetched exactly as written. A file that names the production origin cannot resolve from a site that is not deployed yet.

## Who fixes it

`integrate` does (`fixBy: integrate`). Run it; never hand-write `llms.txt`. It crawls the site and writes the file with a title, a description, sections and absolute links.

`integrate` only creates files and skips paths that exist. It cannot repair a file that is already there. When `llms.txt` exists and a check fails, the owner owns the fix. Report the file path, the failing check and its message, and the regenerated copy from `integrate --output <dir>`. Do not overwrite or edit the existing file.

A `llms-txt-links-resolve` failure on a file that `integrate` wrote has two causes, and both are the owner's: the production site is not deployed yet, or the file lists a page that no longer exists.

## Fix (any framework)

1. Run `integrate --dry-run`, then `integrate --install` with `--site-url <production origin>`, as the playbook says. Without `--site-url` the file names the local server.
2. Check that the plan serves `/llms.txt` for your framework. If the plan does not, report it. Do not write the file yourself.
3. Re-run the audit on the running site.
4. If a file already exists and a check fails, use `integrate --output <dir>` to produce a fresh copy and report both paths to the owner.

## Next.js (App Router)

`integrate --install` writes `app/llms.txt/route.ts` (or under `src/app/`), `app/llms-full.txt/route.ts` and `.w2agent/llms.txt`. The route serves the file as `text/plain`. It also writes `w2agent-build.mjs`, which refreshes `.w2agent/` from the live site in a `prebuild` step. Wire it into `package.json` only as the playbook's step 7 says. When that step is skipped, the seed file still serves and the skipped step goes in the report.

1. Run `integrate --install` once. After it, `llms-txt-exists` and `llms-txt-valid` pass on the local server.
2. If `public/llms.txt` or an `app/llms.txt` route already exists, the install skips the route and the plan carries a `skip` (and for `public/llms.txt` a `manual` note). Next.js errors when a public file and a route share a path, and the install never deletes your file. Treat it as an existing file (owner): report it and do not remove or rename it.
3. With `--site-url <production origin>` the links name production. `llms-txt-links-resolve` then passes only after the owner deploys. Until then it is expected to stay `fail` or `partial` on a local audit, and the report says so. Do not edit the links to the local origin to force a pass.
4. With `output: "export"` the route is exported to a static `llms.txt` at build. The seed in `.w2agent/` is what it contains, so refresh it with the build script before an export.

## Pitfalls

- Never hand-write, edit, rename or delete `llms.txt`, `llms-full.txt` or anything under `.w2agent/`.
- Never overwrite an existing `llms.txt`. Report it.
- Never change links to a local origin to make `llms-txt-links-resolve` pass. A local origin is wrong for the owner.
- Do not add a link to a page the site does not serve.
- `llms-txt-valid` at 80 is a pass. Do not add a description or sections by hand to reach 100.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `llms-txt-exists` and `llms-txt-valid`: expected `pass`. Fetch `/llms.txt` and confirm that it is plain text with a `#` title and absolute links. `llms-txt-links-resolve` needs the production URLs to answer. When the site is not deployed, report it as pending the owner's deploy.
