---
id: content-quality
checks:
  - answer-first
  - content-length
  - list-and-table-usage
  - faq-content
  - citation-readiness
  - freshness-signals
  - author-attribution
fixBy: owner
---

# Fix guide: content the owner writes

## Passes when

Every check reads the visible text and markup of each audited page and scores the share of pages (or signals) that meet a rule. "Visible text" is the page body without `script`, `style`, `noscript` and `template` content, with white space collapsed.

- `answer-first`: a page is good when the first 500 characters of visible text hold at least 20 words and the page has a non-empty `<meta name="description">`. The score is the share of good pages. 70 or more passes, above 0 is `partial`, 0 is `fail`.
- `content-length`: a page is good when its visible text has at least 200 words. Same share scale: 70 or more passes, above 0 is `partial`, 0 is `fail`.
- `list-and-table-usage`: a page counts when it has at least one `<ul>`, `<ol>` or `<table>`. Navigation and footer lists count. 50 or more passes, above 0 is `partial`, 0 is `fail`.
- `faq-content`: a page counts when any one of these holds: an element with `itemtype` containing `FAQPage`, at least 2 `<details>`, at least 2 `<dt>`, the visible text contains "frequently asked", or the visible text has at least 3 occurrences of `?` followed by white space. One counting page passes (score 33 per page, capped at 100). No counting page is `fail`. JSON-LD is not read, so an `FAQPage` JSON-LD block alone does not pass.
- `citation-readiness`: each page earns 25 points for each of four signals: a number such as `5%` or `2.5` in the text; a `<blockquote>` or a straight double-quoted run of 20 or more characters; any of the words "source", "reference", "according to", "study" anywhere in the text; a `rel="author"` element or the text "by " or "author". The score is the average over pages. 50 or more passes, above 0 is `partial`, 0 is `fail`.
- `freshness-signals`: a page counts when it has a top-level JSON-LD block with a truthy `datePublished` or `dateModified`, a `<meta property="article:published_time">` or `article:modified_time`, or a `<time datetime>` element. A JSON-LD array or `@graph` wrapper is not searched. 50 or more passes, above 0 is `partial`, 0 is `fail`.
- `author-attribution`: a page counts when it has a top-level JSON-LD block with an `author` property, a `<meta name="author">`, or an element with `rel="author"`. 50 or more passes, above 0 is `partial`, 0 is `fail`.

## Who fixes it

The owner does (`fixBy: owner`). Each of these needs facts, wording or a decision that only the site's owner has: what the business says, what its numbers are, who wrote a page, when it was last reviewed, which questions customers ask. You never invent copy, FAQs, dates, authors, quotes, figures or sources, and you never move or rewrite existing page copy to move a score. A guess here is a false claim published under the owner's name.

## Fix (any framework)

You do not edit content for these checks. For the final report, per check:

1. Say which check did not pass and its score and message (for example "0/3 pages have 200+ words").
2. Name the pages that fall short. The audit message gives counts only, so read the page sources or fetch the pages and count.
3. State what the owner must supply, in plain terms: longer or more specific copy for the thin pages; the real questions and answers for an FAQ; real dates, and the real author or reviewer for each page; sources the page actually relies on.
4. Say what the markup change would be once the owner supplies the facts, for example "a visible `<time datetime>` next to the last-reviewed date". Do not apply it without the facts.

Where the site has no blog or articles, `freshness-signals` and `author-attribution` may not fit: report that the owner may choose to leave them failing.

## Next.js (App Router)

Nothing to generate. When the owner supplies the facts, the content belongs in the page components, and the dates and authors in the `metadata` export or in the page's own JSON-LD block. `integrate` writes none of this.

## Pitfalls

- Do not add filler to reach 200 words, or repeat the same text per page. The check counts words, a reader (or an agent) gets nothing from filler.
- Do not paste the `faq-content` fix snippet. It adds `FAQPage` JSON-LD, which this check ignores, and an FAQ block that the page does not show breaks the schema-org rule against marking up what the page lacks.
- Do not write a date, author or study the owner did not give you. Do not insert numbers, quotes or the words "source" or "study" to trip `citation-readiness`: the check matches the words anywhere, so it can pass without real citations.
- Do not convert prose to lists or tables to pass `list-and-table-usage`. Navigation lists already count on most sites.
- The first 500 characters decide `answer-first`. Navigation or a cookie banner that comes first in the document body counts against the page. Reordering page layout is a design choice: report it.
- A missing meta description is the owner's to word. Do not generate one from a guess.

## Verify

After the owner edits the pages, run `audit <local url> --json`. Expected: the named check moves to `pass` (or at least rises) for the pages that changed. Until then the final report keeps these as owner items with the numbers from the audit.
