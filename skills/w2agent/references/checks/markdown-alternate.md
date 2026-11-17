---
id: markdown-alternate
checks:
  - markdown-alternate
fixBy: integrate
---

# Fix guide: markdown alternate link

## Passes when

`markdown-alternate` counts audited pages whose HTML has a `<link rel="alternate" type="..." href="...">` where `type` contains `markdown` (for example `text/markdown`). One page is enough to pass. The score is 25 per page, up to 100. 0 pages is `fail`.

## Who fixes it

Two steps, two owners.

1. On frameworks whose section below says so, `integrate` writes the markdown twin of the home page. Run it first. Never hand-write `/index.md`, `llms.txt` or the middleware. If no twin exists after `integrate`, do not hand-write one and do not add the link: report it to the owner.
2. The `<link>` in the page's `<head>` is an additive edit to an existing user file. `integrate` does not make it. You do.

On Next.js, `integrate` writes `app/index.md/route.ts`, which serves `/index.md`. It writes no markdown file for any inner page. Only the home page has a twin.

## Fix (any framework)

1. Run `integrate`. Confirm the markdown file or route exists and serves `text/markdown`. If it does not exist, stop here and report it to the owner.
2. On each page that has a real markdown twin, add `<link rel="alternate" type="text/markdown" href="<twin url>">` to `<head>` through the framework's metadata mechanism.
3. A page without a twin gets no link. Do not point other pages at the home twin.

## Next.js (App Router)

`integrate` covers the `/index.md` route. The link needs your edit. Do it in the home page, not the root layout.

1. In `app/page.tsx` (or `src/app/page.tsx`), add `types` under `alternates` in the page's `metadata`. If the page has no `metadata`, add one. If the page is a Client Component (`"use client"`), put the metadata in a Server Component `layout` for that route segment instead:

```ts
import type { Metadata } from "next";

export const metadata: Metadata = {
  alternates: { types: { "text/markdown": "/index.md" } },
};
```

2. If the page already exports `alternates` (for example `canonical`), add `types` inside it. Do not make a second `alternates` key.
3. If `next.config` sets `basePath`, include it in the `href` (`/<basePath>/index.md`): Next.js does not apply `basePath` to metadata URLs, and the generated route serves `<basePath>/index.md`. Next.js resolves the relative `href` against `metadataBase`. The root layout needs `metadataBase`; add the production origin if it is missing.
4. Do not leave `alternates` for `/index.md` in the root layout. Next.js replaces `alternates` as a whole, so a page that sets its own `alternates` (for a canonical) loses the layout's `types`. A layout-level link would also tell every other page that `/index.md` is its twin.

## Pitfalls

- Next.js replaces `alternates` when a page or nested layout sets its own. It does not merge. After any later metadata edit (canonical, languages), re-check that the link is still in the built HTML.
- Do not delete or edit the generated middleware or `app/index.md/route.ts` to make the link work.
- Do not link a page to a markdown URL that does not exist or returns 404.
- Do not use `type="text/html"` or a `.md` URL under another type. The type must contain `markdown`.
- Do not add the link to pages in bulk to raise the score. 25 on the one page with a twin is the honest result.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `markdown-alternate`: expected `pass`. The score is 25 when only the home page has a twin. That is the final state; do not chase 100. Fetch the home page HTML and confirm `<link rel="alternate" type="text/markdown" href=".../index.md">` is there. Fetch the `/index.md` URL and confirm it returns `text/markdown`. Re-check it after you edit canonical or other metadata. If `integrate` has not run yet, the check stays `fail` until it has.
