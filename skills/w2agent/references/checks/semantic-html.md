---
id: semantic-html
checks:
  - semantic-html
  - heading-hierarchy
fixBy: agent
---

# Fix guide: semantic HTML and heading hierarchy

## Passes when

- `semantic-html` looks on every audited page for these five elements: `<article>`, `<section>`, `<nav>`, `<main>`, `<aside>`. A page scores the share it has (3 of 5 is 60). The check score is the average over pages. 60 or more passes, above 0 is `partial`, 0 is `fail`. `<header>`, `<footer>`, `<figure>` and `role` attributes do not count. In practice every page needs at least three of the five, for example `main`, `nav` and `section`.
- `heading-hierarchy` judges each page by its `h1`..`h6` elements in document order, layout included. A page is good when it has exactly one `<h1>` and no heading is more than one level deeper than the heading before it (`h1` then `h3` is a jump; `h3` then `h2`, or `h3` then `h1`, is fine). A page with no headings is not good. The score is the share of good pages. 80 or more passes, above 0 is `partial`, 0 is `fail`.

## Who fixes it

You do (`fixBy: agent`). `integrate` changes no page markup. The edit only changes which element wraps existing content. It never changes the words.

## Fix (any framework)

1. Read the page templates and layout first. Find what is missing: a `<main>`, a `<nav>`, `<section>` blocks, a single `<h1>`, skipped levels.
2. Change the element type of an existing wrapper. A `div` that holds the page's main content becomes `<main>`. A `div` or `ul` wrapper that holds the site navigation links becomes (or gets wrapped in) `<nav>`. A `div` that holds one topic with its own heading becomes `<section>`. Keep every class, id, attribute and child as it is.
3. Use one `<main>` per page. Use `<article>` only for a self-contained piece such as a post. Use `<aside>` only for side content that exists, such as a sidebar. Do not add elements to reach 5 of 5. 3 of 5 passes.
4. Headings: exactly one `<h1>`, the page's own title. Change the tag of an existing heading (for example `h4` to `h3`, or a second `h1` to `h2`) and keep its text and classes. A visual title built from a `div` or `p` may become the `<h1>` when the page has none.
5. Never move, reword, merge or delete page copy, and never add text. If a page shows no title to make into an `<h1>`, leave it and report it to the owner.

## Next.js (App Router)

`integrate` covers nothing for this check on Next.js. The layout is shared by every page, so check it first.

1. Search `app/` (or `src/app/`) for `<main`, `<nav`, `<h1`. A layout that wraps `{children}` in `<main>` means page components must not add another one.
2. If no `<main>` exists anywhere, wrap `{children}` in the root layout in `<main>`. Do this once and keep any `className` that the existing wrapper had:

```tsx
<body>
  <Header />
  <main>{children}</main>
  <Footer />
</body>
```

3. If pages already have their own outer `<div>`, change that `div` to `<main>` in each page instead, and leave the layout alone.
4. In the header component, make the element that holds the navigation links a `<nav>`. If the logo is also an `<h1>` there, change it to a `div` or `p` so that the page title is the only `<h1>`. Footer link headings that jump levels (`h4` after `h2`) become the next level.
5. In page components, change topic wrappers that have a heading to `<section>`.
6. Leave Client Components as they are unless the wrapper itself is in them. Element types in a Client Component still render in the HTML.

## Pitfalls

- Stylesheets may target element names (`div.card`, `main > div`). After you change an element, search the CSS for selectors that depend on it. Keep the look unchanged.
- Never wrap a page in `<main>` twice (layout and page). Never use two `<h1>` on a page, including one in the layout.
- Do not change heading level to fix visual size. Change the tag, and keep the classes that give the size.
- Do not rewrite headings, merge sections, add visible text or add hidden text.
- Do not add `<article>` or `<aside>` just for the check.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `semantic-html` and `heading-hierarchy`: expected `pass`. Fetch the home page and one inner page and confirm each has one `<main>`, a `<nav>`, at least one `<section>` and exactly one `<h1>`. Compare the page before and after: the text must be identical. If `heading-hierarchy` is `partial`, the message gives how many pages are good. Find the pages with no heading, two `<h1>` (check the layout), or a skipped level.
