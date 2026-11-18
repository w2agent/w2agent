---
id: schema-org
checks:
  - schema-org-present
  - schema-org-type
  - schema-org-completeness
  - schema-org-valid
fixBy: agent
---

# Fix guide: Schema.org JSON-LD

## Passes when

Each audited page is parsed for `<script type="application/ld+json">` blocks. One script is one block. A script that does not parse as JSON is ignored.

- `schema-org-present`: share of pages with at least one block. 100% passes. Above 0% and below 100% is `partial`. 0% is `fail`. Every audited page needs a block to pass.
- `schema-org-type`: share of pages where some block has a string `@type` that contains one of `WebPage`, `Article`, `BlogPosting`, `Product`, `LocalBusiness`, `Organization`, `Person`, `FAQPage`, `HowTo`, `Recipe`, `Event`, `Course`, `SoftwareApplication`, `WebSite`, `ItemList`, `BreadcrumbList`. 50% or more passes, more than 0% is `partial`. An array `@type`, or a subtype name alone (for example `Plumber`), does not match.
- `schema-org-completeness`: for each page with JSON-LD, only its first block counts. The fields are `name`, `description`, `author`, `datePublished`, `dateModified`, `image`, `url` (7). The score is the average share present. 70% or more (5 of 7 fields) passes. Above 0% is `partial`.
- `schema-org-valid`: among pages that have JSON-LD, share where some block has an `@context` containing `schema.org` and some block (possibly another) has a string `@type`. Put both in one block anyway. 100% passes, above 0% is `partial`. It is `skip` when no page has JSON-LD. A block that has `@graph` or a top-level array and no top-level `@type` is not valid for this check.

## Who fixes it

You do (`fixBy: agent`). `integrate` writes no JSON-LD for Next.js. Add it to the site's own pages.

## Fix (any framework)

1. Put one JSON-LD object in its own `<script type="application/ld+json">` on every page. The object has `@context: "https://schema.org"` and a string `@type`. No `@graph`, no top-level array.
2. Home page: the entity the site is. A business site uses `LocalBusiness` (or `Organization`). Other pages: `WebPage`, or the specific type the page really is (`Article`, `Product`, `FAQPage`).
3. Fill each field from what the site shows to visitors: name, description, URL, phone, address, opening hours. Copy wording from the page. Use real absolute URLs on the production origin.
4. Make the page's main block the first block on the page. Completeness reads only the first.
5. Leave a field out when the site does not show the value.

## Next.js (App Router)

`integrate` covers nothing for this check on Next.js. Add the script in each `page.tsx`, next to the content. Do not move the page's content or restructure the component.

```tsx
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: "Services | Example",
  description: "What this page says it is about.",
  url: "https://www.example.com/services",
};

export default function Services() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      {/* existing content, unchanged */}
    </>
  );
}
```

Use `LocalBusiness` for the home page of a local business, with `telephone`, `address` (`PostalAddress`) and `openingHoursSpecification` copied from the page and footer. Wrap an existing component return in a fragment only when it has no single root. Leave the rest as it is.

Put the script in the page, not in the root layout. A layout block repeats on every page and ends up first, so the home entity shows up on pages it does not describe.

## Pitfalls

- Use only real business data that the site shows. Never invent `aggregateRating`, `review`, `priceRange`, `geo`, `sameAs`, `image`, `author` or dates. A missing field is better than a made-up one.
- Do not mark up a feature the site lacks: no `SearchAction` without a search page, no `FAQPage` without visible questions and answers, no `Offer` or price the page does not show.
- Opening hours come from the stated hours only. "Emergency line available 24 hours" is not the business's opening hours.
- `@type` is one string. `["LocalBusiness", "Plumber"]` and `Plumber` alone do not match the type check.
- Do not use `@graph`. It leaves the block without a top-level `@type`.
- Escape `<` as `\u003c` in the serialized JSON, as in the snippet. Never build the string by hand.
- Do not rewrite or move page copy to feed the markup.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `schema-org-present`, `schema-org-type` and `schema-org-valid`: expected `pass`. Watch `schema-org-completeness`: it needs 5 of 7 fields on average. `name`, `description` and `url` are 3 of 7 (score 43, `partial`). The other fields (`image`, `author`, `datePublished`, `dateModified`) pass only when the site really shows them. If it does not, `partial` is the final state. Report it as an owner item and do not invent values.
