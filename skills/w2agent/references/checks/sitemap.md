---
id: sitemap
checks:
  - sitemap-exists
fixBy: agent
---

# Fix guide: XML sitemap

## Passes when

`sitemap-exists` fetches `<origin>/sitemap.xml`. It passes (score 100) when the response is HTTP 200 and the body contains `<urlset` or `<sitemapindex`. Otherwise it fails (score 0). There is no partial. The check does not read the listed URLs, but the file must list the site's real pages.

## Who fixes it

You do (`fixBy: agent`). `integrate` does not create a sitemap on any framework, and on Next.js it does not write a `Sitemap:` line either. Its staged robots rules (`.w2agent/robots.txt`) only repeat the `Sitemap:` line the site already has. Write the sitemap yourself, then leave `robots.txt` alone except for the case below.

## Fix (any framework)

1. List every public page the site really serves. Take the list from the site's own source: route files, the CMS or content directory, the navigation. Skip `noindex` pages, paths that `robots.txt` disallows, API routes and error pages.
2. Use absolute URLs on the production origin, not the local server. Find the origin the way the playbook does: the value you pass as `--site-url`, `metadataBase`, an existing `Sitemap:` line, or the framework config. Never use `127.0.0.1` or `localhost` URLs.
3. Serve it at `/sitemap.xml` on the site root (or a `<sitemapindex>` at that path).
4. If `robots.txt` has no `Sitemap:` line, add `Sitemap: <origin>/sitemap.xml`. If it already has one, leave it.

Shape (one `<url>` per real page):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.example.com/</loc></url>
  <url><loc>https://www.example.com/services</loc></url>
</urlset>
```

Add `<lastmod>` only when you know the real date of the last change.

## Next.js (App Router)

`integrate` covers nothing for this check on Next.js. Create the route yourself.

1. Look first. If `app/sitemap.ts` (or `.js`), `src/app/sitemap.*` or `public/sitemap.xml` already exists, extend it. Next.js errors when a file under `public/` and a route share the path.
2. Create `app/sitemap.ts` (`src/app/sitemap.ts` when the project uses `src/`). List one entry per page route you found under `app/`. For dynamic routes, call the same data source the pages use.

```ts
import type { MetadataRoute } from "next";

const origin = "https://www.example.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/services", "/contact"].map((path) => ({ url: `${origin}${path}` }));
}
```

Replace `origin` and the paths with the site's real values.

3. If `next.config` sets `output: "export"`, add `export const dynamic = "force-static";` to the file. The build fails without it.
4. Do not list w2agent's generated routes (`/llms.txt`, `/llms-full.txt`, `/index.md`). They are not pages.

## Pitfalls

- Never write placeholder URLs. Every `<loc>` is a real page on the production origin.
- Do not copy the local server origin into the file. A sitemap with local URLs is wrong for the owner and the audit ignores it.
- Do not hand-write `llms.txt` or other files `integrate` generates. A sitemap is a different file.
- Do not edit or replace an existing `robots.txt`. Add a missing `Sitemap:` line only.
- Do not move or rewrite page code to make routes easier to list.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `sitemap-exists`: expected `pass`, score 100. Also fetch `/sitemap.xml` and confirm it lists every real page on the production origin. If it still fails, check that the response is 200 and that the body contains `<urlset`.
