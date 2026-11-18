---
id: og-meta-tags
checks:
  - og-meta-tags
  - nextjs-metadata-api
fixBy: agent
---

# Fix guide: OpenGraph meta tags

## Passes when

`og-meta-tags` looks on every audited page for `<meta property="og:title" content="...">`, `og:description` and `og:image`. A tag counts only when it uses the `property` attribute and its `content` is not empty. A page scores the share of the three it has (3 of 3 is 100, 2 of 3 is 67, 1 of 3 is 33). The check score is the average over all audited pages. 80 or more passes, above 0 is `partial`, 0 is `fail`.

Two of three tags on every page is 67, so it stays `partial`. A site needs `og:image` on nearly every page to pass.

`nextjs-metadata-api` (Next.js adapter check, added only when the site is detected as Next.js) reads each audited page's HTML. A page counts as complete when it has a non-empty `<title>`, a `<meta name="description">` and at least one `<meta property="og:...">` tag (any `og:` property, not all three). The score is the share of complete pages. 80 or more passes, 50 or more is `partial`, lower is `fail`. Fixing the `og-meta-tags` steps below fixes this check too; the page `title` and `description` come from the same `metadata` export.

## Who fixes it

You do (`fixBy: agent`). `integrate` writes no OpenGraph tags on any framework. The edit goes into the site's own metadata. The image must be one the site already has.

## Fix (any framework)

1. Set `og:title` and `og:description` on every page from that page's own title and description. Use the wording the page already has.
2. Set `og:image` to an image the site really has: a hero, a logo or an existing social image. Use an absolute URL on the production origin.
3. Use the framework's metadata mechanism, in the project's existing style, so that the tags are in the server-rendered `<head>`.
4. If the site has no image at all, leave `og:image` out and report it as an owner item. `partial` (67) is then the final state. Do not generate, download or link a stock or placeholder image.

## Next.js (App Router)

`integrate` covers nothing for this check on Next.js. Use the `openGraph` field of `metadata`.

1. Check that the root layout sets `metadataBase` to the production origin, so that a relative image path becomes an absolute URL. Add it when it is missing.
2. In the root layout, add a site-wide default with all three fields. Pages that set no `openGraph` of their own inherit all three:

```ts
export const metadata: Metadata = {
  metadataBase: new URL("https://www.example.com"),
  openGraph: {
    title: "Example",
    description: "What the site says it is.",
    images: ["/og.png"],
  },
};
```

3. A page that sets its own `openGraph` replaces the layout's `openGraph` as a whole. It does not merge. Such a page must repeat all three fields, `images` included, or it loses the image:

```ts
export const metadata: Metadata = {
  title: "Services",
  description: "What this page offers.",
  openGraph: {
    title: "Services",
    description: "What this page offers.",
    images: ["/og.png"],
  },
};
```

4. `title` and `description` alone do not produce `og:image`. Setting `openGraph` for a page without `images` leaves that page with 2 of 3.
5. Put the image in `public/` (or point to the one that is already there). Do not add `app/opengraph-image.*` unless the site already has such a file for the owner.

## Pitfalls

- Never invent an image, a URL or marketing copy. Copy the page's own title and description.
- `<meta name="og:...">` does not count. The attribute must be `property` (Next.js writes it correctly).
- An empty `content` does not count.
- Do not set `openGraph` in a page and forget `images`. That page then drops below the layout default.
- Do not put per-page titles into the layout. The layout holds only the site-wide default.
- A tag in client-only code is not in the HTML the audit reads. Use `metadata` in a Server Component. For a Client Component page, put it in a Server Component `layout` for that segment.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `og-meta-tags`: expected `pass` (80 or more). Fetch two pages, one with its own `openGraph`, and confirm each has `og:title`, `og:description` and `og:image` in `<head>`. If the score is 67, the images are missing: add the image, or report it as an owner item when the site has none.
