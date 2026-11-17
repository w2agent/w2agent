---
id: canonical
checks:
  - canonical-urls
fixBy: agent
---

# Fix guide: canonical URLs

## Passes when

`canonical-urls` counts the audited pages whose HTML has a `<link rel="canonical" href="...">`. The score is the share of pages with one. 80% or more passes. More than 0% and less than 80% is `partial`. None is `fail`. The check tests that the tag exists; it does not compare the value. The value must still be the page's own URL.

## Who fixes it

You do (`fixBy: agent`). `integrate` does not write canonical tags on Next.js or any other framework. The edit goes into the site's own page or layout metadata.

## Fix (any framework)

1. Every page gets one canonical tag that points at its own preferred URL: absolute, on the production origin, same path, no tracking query string.
2. Set it per page. Never set one canonical for the whole site.
3. Use the framework's metadata mechanism, in the project's existing style. Do not add the tag by hand to generated HTML.

## Next.js (App Router)

`integrate` covers nothing for this check on Next.js.

1. Check that the root layout sets `metadataBase` to the production origin. If it does not, add it as a `new URL("https://...")`. Next.js resolves relative canonical paths against it.
2. In each `page.tsx` that exports `metadata`, add `alternates: { canonical: "/that-page" }` inside the existing object. In a page that exports none, add `export const metadata = { alternates: { canonical: "/that-page" } };`. The home page uses `"/"`. A page's metadata is merged over the layout's by top-level key, so title and description from the layout stay.
3. For dynamic routes, return the canonical from `generateMetadata`, built from the route params.

```ts
export const metadata = {
  title: "Services | Example",
  alternates: { canonical: "/services" },
};
```

4. If a page already has an `alternates` object, add the `canonical` key to it. Keep any other keys (see the markdown alternate guide).

## Pitfalls

- Never put one `canonical` in the root layout metadata. Every page without its own `alternates` inherits it and points at the home page. That tells crawlers all pages are duplicates of home.
- Next.js replaces `alternates` as a whole. A page that sets its own `alternates` loses every `alternates` key from its layout. Re-check `types` (markdown alternate) after you edit.
- Do not canonicalize to the local server or to a staging host.
- Do not strip or rewrite page content to place the tag. Edit the metadata export only.
- Make the smallest additive edit in each file and match its existing style.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `canonical-urls`: expected `pass`, score 100. Fetch the home page and one inner page, and confirm each one's `<link rel="canonical">` names its own URL. If the score is below 100, find the page without the tag.
