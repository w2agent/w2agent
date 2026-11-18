---
id: server-html
checks:
  - no-js-dependency
  - token-efficiency
  - nextjs-static-generation
fixBy: owner
---

# Fix guide: content in the server HTML

## Passes when

The first two checks read the HTML the server returns, without running JavaScript. `nextjs-static-generation` (Next.js adapter check, added only when the site is detected as Next.js) reads the response headers and the `__NEXT_DATA__` flags of the same pages.

- `no-js-dependency` judges each page. A page is a JS-only shell, and not good, when all three hold: it has an empty mount element (`<div id="__next">`, `root`, `app` or `__nuxt`, or an empty `data-reactroot` div); it has fewer than 5 `<a href>` links; and its visible words plus `<noscript>` words, at 5 characters per word, are under 20% of the size of all its `<script>` tags. Any other page is good when its visible words plus `<noscript>` words reach 100 if the HTML contains a framework marker (`__NEXT_DATA__`, `window.__nuxt__`, `ng-app`, `ng-version`, `data-reactroot`, `data-v-app`, `__svelte`, `ember-application`), or 50 when it contains none. The score is the share of good pages. 70 or more passes, above 0 is `partial`, 0 is `fail`. When a marker matched, `details` lists "Detected JS frameworks". App Router pages normally carry none of these markers (`__NEXT_DATA__` belongs to the Pages Router), so they get the 50-word threshold.
- `token-efficiency`: for each page, the length of the visible text divided by the length of the whole HTML document, scripts and styles included. The score uses the average over pages: 25% or more is 100, 15% or more is 80, 10% or more is 60, 5% or more is 30, lower is 0. 60 or more passes (so about 10% or more), 30 is `partial`, 0 is `fail` (under 5%).
- `nextjs-static-generation`: each page is `dynamic` when `cache-control` has `private` or `no-store`, or its `__NEXT_DATA__` flags `gssp` or `gip` (without `nextExport`), or `appGip` (without `gsp` or `nextExport`). Otherwise it is `static` when it has an `x-nextjs-prerender` header, an `x-nextjs-cache` or `x-vercel-cache` of `HIT`, `STALE`, `PRERENDER` or `REVALIDATED`, `s-maxage` or `public` in `cache-control`, or the flags `gsp`, `nextExport` or `autoExport`. A page with none of these is unknown and not counted. It passes (100) when static pages are at least half of the pages with evidence. Otherwise it is `partial` (60), also when no page has evidence. It is never `fail`.

## Who fixes it

The owner does (`fixBy: owner`). Three different causes give the same result, and none is an additive edit you can make safely:

- Thin pages: the pages have little text. That is a content decision (see the `content-quality` guide).
- Client rendering: the content is drawn in the browser, so the server HTML is a shell or lacks text. Moving to server rendering changes how the site is built.
- Heavy markup: inline scripts, inline CSS, large SVG or framework payloads dominate the HTML, so the text share is low. Cutting it is engineering work with trade-offs.

`nextjs-static-generation` has the same owner rule: a route is dynamic because the code reads `headers()`, `cookies()` or `searchParams`, or sets `dynamic = "force-dynamic"` or a no-store fetch. That is a product decision. Name the file and the cause in the report; do not change it. A local `next dev` audit gives no evidence, so audit a production build.

You do not rewrite page copy, convert a page to server rendering, or strip scripts to move a ratio.

## Fix (any framework)

For the final report:

1. Name the checks and the scores. For `no-js-dependency` give `x/y pages` and the shell count from the message.
2. Say which cause applies, from evidence: fetch a page and read the HTML. Few words in the body with a normal-sized document means thin pages. An empty mount `<div>` and big `<script>` blocks mean client rendering. Plenty of text but a very large document means heavy markup.
3. State what the owner decides: write more text; render these pages on the server or pre-render them at build time; remove or defer the heavy markup.

The audit also emits a `js-heavy-site` warning when `no-js-dependency` scores 30 or less, or 50 or less with `token-efficiency` at 30 or less. Report it with these checks.

## Next.js (App Router)

App Router pages render on the server by default, so a shell here means something opted out: a page or layout made a Client Component that renders its content after mount, or content loads through `next/dynamic` with `ssr: false`, or data loads in an effect. Name the file and the mechanism in the report. Do not change it yourself. Next.js also writes the page data into the HTML in `self.__next_f.push(...)` script tags. They count in the document length of `token-efficiency` and not in its text, so they lower the ratio on every page.

## Pitfalls

- Do not paste text into `<noscript>` to pass `no-js-dependency`. The check counts it, but it is a second copy that drifts from the page.
- Do not hide or remove scripts, styles or the framework payload to raise `token-efficiency`. That can break the site.
- Do not read a local `next dev` audit as the production result. A dev server returns different HTML from production. Audit a production build served with `next start`, or the exported files.
- A low `token-efficiency` on a three-page site with short copy is normal. Report it with the content-quality items, not as a rendering fault.

## Verify

After the owner changes the pages, build for production, serve it, and run `audit <local url> --json`. Expected: `no-js-dependency` at `pass` (70 or more) and `token-efficiency` at `pass` (60 or more). Until then the final report keeps both as owner items with the cause you found.
