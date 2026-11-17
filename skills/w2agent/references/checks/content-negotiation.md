---
id: content-negotiation
checks:
  - content-negotiation
fixBy: integrate
---

# Fix guide: markdown for agents (content negotiation)

## Passes when

`content-negotiation` probes the home page and, when a crawled page is a docs page (a path starting with `/docs` or `/documentation`, or a `docs.` host), that page too. For each page it makes two requests:

1. `GET` the page with `Accept: text/markdown`. One redirect is followed.
2. `GET` the `.md` URL: `/` becomes `/index.md`, and `/x` becomes `/x.md`. The query string is dropped.

A request is a hit when the status is 2xx, the `Content-Type` is `text/markdown` or `text/x-markdown`, the body is not empty, the body is not an HTML document, and the body is not identical to the crawled page. A `.md` hit is cancelled when a random `<uuid>.md` URL in the same directory also returns markdown (a catch-all).

The result is `pass` (100) when any `.md` URL hits, or when an `Accept` request hits and its response (or the redirect) has `Vary: Accept`. It is `partial` (50) when only `Accept` requests hit and none has `Vary: Accept`. It is `fail` (0) when nothing hits. One `.md` hit on the home page is enough to pass.

## Who fixes it

`integrate` does (`fixBy: integrate`). Run it. Do not hand-write the markdown file, route or middleware it generates, and never edit them to change the result. `integrate` only creates files. If a `/index.md` file or route already exists and the check fails, the owner owns the fix: report the path and the regenerated copy from `integrate --output <dir>`.

What `integrate` writes depends on the framework, and its plan lists it. If the plan has no markdown route or middleware for the framework, report the check as not covered. Do not hand-write one.

## Fix (any framework)

1. Run `integrate --dry-run`, then `--install` (with `--site-url <production origin>`), as the playbook says.
2. Confirm the plan lists a markdown twin of the home page. If it does not, stop and report.
3. Rebuild, serve, and re-run the audit.

## Next.js (App Router)

`integrate --install` writes `app/index.md/route.ts` (or under `src/app/`), which serves `/index.md` as `text/markdown; charset=utf-8` with `Vary: Accept`. The content is the home page's own content, from the seed `.w2agent/index.md`. If that seed is missing, the route serves the `llms.txt` content instead, which is only a link list. It also writes `middleware.ts` (`proxy.ts` on Next.js 16), which rewrites `/` to `/index.md` for requests that prefer `text/markdown` and to `/llms.txt` for plain text.

1. Run `integrate --install` once. The `.md` URL alone passes the check (`pass`, 100). The middleware is not needed for it.
2. Only the home page has a markdown twin. The docs-page probe, when it applies, misses on its own `.md` URL. That does not stop a pass.
3. `output: "export"`: Next.js runs no middleware in a static export, so `/` has no Accept negotiation, and the install says so in its warnings. `/index.md` is exported as a static `index.md` file at build time. The check can still pass through that file, but the host serves it with a content type chosen by its own rules. A host that sends `text/plain` or `application/octet-stream` for `.md` files leaves the check `fail`, and nothing in the project can change that. Report it to the owner as a hosting setting (serve `.md` as `text/markdown`).
4. If `public/index.md` or an `app/index.md` route already exists, the install skips the route. Treat it as an existing file (owner) and report it.
5. The home page HTML does not carry `Vary: Accept`, because Next.js overwrites that header for the page. This does not affect the `.md` hit.

## Pitfalls

- Never hand-write `index.md`, the route or the middleware. Never edit `.w2agent/*`.
- Never delete or replace the generated middleware to change a header. It does not cause a failure here.
- Do not make a catch-all route that returns markdown for every path. The check's control request detects it and cancels the hit.
- Do not return HTML with `Content-Type: text/markdown`. The check rejects an HTML body.
- Do not link `/index.md` from other pages as their twin. See the `markdown-alternate` guide.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `content-negotiation`: expected `pass`, score 100. Also fetch `/index.md` and confirm 200, `Content-Type: text/markdown`, and a body that is the home page's own text. Fetch `/` with `Accept: text/markdown` and confirm the same body (not available in a static export). If the result is `partial`, the `Accept` path works but no `.md` URL does: check that `/index.md` exists and serves markdown.
