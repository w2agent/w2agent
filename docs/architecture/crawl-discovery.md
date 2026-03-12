# Crawl Discovery Architecture

**Status**: Implemented
**Last updated**: 2026-03-12

## Overview

The crawl discovery system finds and prioritizes pages to crawl from a website. It combines multiple URL sources — sitemaps, internal links, and robots.txt signals — then scores and selects the most valuable pages within the `maxPages` budget. Used by both the audit engine and generate pipeline via `crawlSite()`.

Key files: `packages/core/src/crawl/discovery.ts`, `packages/core/src/crawl/scoring.ts`, `packages/core/src/crawl/strategy.ts`, `packages/core/src/audit/crawler.ts`

## Design Decisions

- **Multi-source discovery** — sitemaps and internal links are complementary. Sitemaps provide the authoritative page list; links catch pages missing from sitemaps and add link-popularity signal.
- **Smart scoring** — pages scored on 5 signals (URL pattern, depth, sitemap priority, lastmod recency, internal link count) before selection. Better pages get crawled within budget.
- **Crawl-delay respect** — honors `Crawl-delay` from robots.txt, capped at 10 seconds max to prevent extremely slow crawls.
- **Homepage always crawled** — homepage is fetched first (before discovery) and always included. Discovery selects additional pages.

## How It Works

```
crawlSite(url, options)
        │
        ▼
  Fetch homepage (always first)
        │
        ▼
  Parallel fetches:
  ├── robots.txt
  ├── sitemap.xml
  ├── llms.txt
  ├── .well-known/* files
  └── OpenAPI probes
        │
        ▼
  discoverPages({sitemapXml, homepage, baseUrl})
  ├── parseSitemapWithMetadata(xml) → sitemap pages
  ├── discoverInternalLinks(html)  → link counts
  └── merge: sitemap pages + link-only pages
        │
        ▼
  selectPages(discovered, maxPages - 1, visited)
  ├── scorePage() each page
  ├── sortPagesByScore() descending
  └── take top N (budget - already visited)
        │
        ▼
  Fetch selected pages (batched, with delay)
        │
        ▼
  CrawlResult { pages, metadata, totalUrlsFound }
```

### Discovery (`discovery.ts`)

**`parseSitemapWithMetadata(xml, baseUrl)`**: Parses XML sitemap, extracts `<loc>`, `<priority>`, `<lastmod>` per URL. Filters to same origin. Returns `DiscoveredPage[]` with source "sitemap".

**`discoverInternalLinks(html, baseUrl)`**: Parses homepage HTML, finds all `<a href>` links on same origin. Returns `Map<string, number>` — URL → link count. Normalizes URLs (strips hash, trailing slash).

**`discoverPages(options)`**: Merges sitemap pages with link-discovered pages. For URLs found in both sitemap and links, the sitemap entry is enriched with the link count. Link-only pages get source "link".

### Scoring (`scoring.ts`)

`scorePage(page)` computes a composite score from 5 signals:

| Signal | Max Points | Logic |
|--------|-----------|-------|
| URL pattern | ~15 | `/docs`, `/api`, `/pricing` etc. get bonus via `getUrlPatternScore()` |
| Depth penalty | 5 | `max(0, 5 - depth)` — shallower pages score higher |
| Sitemap priority | 10 | `priority × 10` (0.0–1.0 → 0–10) |
| Lastmod recency | 5 | ≤1mo: 5, ≤3mo: 4, ≤6mo: 3, ≤12mo: 2, ≤24mo: 1, else: 0 |
| Internal link count | 5 | `min(5, floor(linkCount / 3))` |

Homepage always gets 20 points (special case).

### Strategy (`strategy.ts`)

`selectPages(discovered, budget, visited)`: Scores all discovered pages, sorts descending, takes top `budget` pages not already in `visited` set.

### Crawling (`crawler.ts`)

After page selection, `crawlSite()` fetches pages in configurable batches with rate limiting:

- Concurrency: `options.concurrency` (default: 3)
- Delay: `max(options.requestDelay, robotsCrawlDelay)`, capped at 10,000ms
- Progress callback on each batch

## Data Model

```typescript
interface DiscoveredPage {
  url: string;
  source: "sitemap" | "link" | "homepage";
  sitemapPriority?: number;    // 0.0–1.0 from sitemap XML
  sitemapLastmod?: string;     // ISO date from sitemap XML
  internalLinkCount: number;   // links pointing to this page from homepage
  depth: number;               // URL path segments count
}
```

## Error Handling

| Scenario | Behavior | Recovery |
|----------|----------|----------|
| Sitemap 404 | `sitemapXml` undefined, only link discovery | Homepage links used |
| Sitemap malformed | Regex parser skips invalid entries | Valid entries still extracted |
| No internal links on homepage | `linkCounts` empty | Sitemap-only discovery |
| Both sitemap and links empty | Only homepage crawled | 1-page audit/generate |

## Anti-Patterns

❌ **WRONG**: Fetching all discovered pages regardless of budget.
✅ **CORRECT**: Score and select top N pages within `maxPages` budget. Don't waste crawl capacity on low-value pages.

❌ **WRONG**: Trusting sitemap priority as sole ranking signal.
✅ **CORRECT**: Sitemap priority is just one of 5 scoring signals. Many sites set all priorities to 0.5 or omit them entirely.

## Known Limitations

- **No `<sitemapindex>` support** — only flat `<urlset>` sitemaps parsed. Sites with sitemap index files (pointing to sub-sitemaps) get only link discovery.
- **Homepage-only link analysis** — internal link counts are from the homepage only. A page heavily linked from other pages but not the homepage gets `internalLinkCount: 0`.
- **URL normalization mismatch** — sitemap URLs are not normalized (may have trailing slashes), link-discovered URLs have trailing slashes stripped. URLs found in both may not merge, causing split link counts.
- **No robots.txt allow/disallow filtering** — pages blocked by robots.txt are discovered and selected but may fail to fetch. The fetch layer handles the 403/robots block.
