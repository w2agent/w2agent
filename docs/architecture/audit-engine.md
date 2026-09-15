# Audit Engine Architecture

**Status**: Implemented
**Last updated**: 2026-03-12

## Overview

The audit engine evaluates websites for AI-agent readiness by crawling pages, running checks against the crawled data, and producing a scored report with actionable recommendations. It's the core pipeline behind `w2agent audit <url>` and the platform's `/api/audit` endpoint.

The engine is intentionally LLM-free — all analysis is pure HTTP/HTML inspection. This keeps audits fast, deterministic, and free of API costs.

## Design Decisions

- **Check registry pattern** — checks registered dynamically via `registerCheck()`, not hardcoded. Allows platform to inject additional checks without forking core.
- **Crawl-once reuse** — the same `crawlSite()` output feeds both audit checks and generate pipeline. No redundant fetching.
- **Weighted category scoring** — 7 categories with different weights reflect the relative importance of each aspect of AI-readiness.
- **Platform adapter merging** — platform-specific checks (e.g., WordPress PHP checks) are appended to core checks at runtime, not pre-registered.
- **Top issues ranked by impact** — failed checks sorted by estimated overall score impact, not just severity. A low-weight check that fails contributes less than a high-weight one.

## How It Works

```
URL
 │
 ▼
┌─────────────┐    ┌──────────────────┐    ┌───────────────┐
│  crawlSite  │───▶│  detectPlatform  │───▶│  Merge Checks │
│  (crawler)  │    │  (adapter reg.)  │    │  core + plat. │
└─────────────┘    └──────────────────┘    └───────┬───────┘
                                                    │
                                                    ▼
                                           ┌────────────────┐
                                           │  Run All Checks│
                                           │  (parallel)    │
                                           └────────┬───────┘
                                                    │
                                                    ▼
                                           ┌────────────────┐
                                           │ Score & Grade  │
                                           │ + Top Issues   │
                                           └────────────────┘
                                                    │
                                                    ▼
                                              AuditReport
```

### Step-by-step

1. **Crawl** (`packages/core/src/audit/crawler.ts`): Fetches homepage, robots.txt, sitemap.xml, llms.txt, .well-known files, and OpenAPI probes in parallel. Then discovers and selects additional pages using smart scoring (`discoverPages()` + `selectPages()`). Respects `Crawl-delay` from robots.txt (capped at 10s).

2. **Detect Platform** (`packages/core/src/adapters/registry.ts`): Iterates all registered adapters, each running `detect(pages, metadata)`. Highest confidence result wins. Returns platform ID, confidence score, and version if detectable.

3. **Merge Checks**: Core checks from `packages/core/src/audit/checks/` are combined with platform-specific checks from the detected adapter. If `checksOverride` is provided (used by platform for custom check sets), it replaces the registry entirely.

4. **Run Checks** (`engine.ts:70`): All checks execute in parallel via `Promise.all()`. Each check receives the full `pages` array and `metadata` object, returning a `CheckResult` with id, score (0-100), weight, category, status, and optional fix snippet.

5. **Score** (`engine.ts:75-83`): Results grouped by category. Per-category score = weighted average of check scores. Overall score = weighted sum of category scores. Grade derived from overall score. **Tracked checks** (`Check.tracked: true`; the engine stamps `tracked: true` on the result) stay in `category.checks` but are excluded from the weighted average and category renormalization, top issues, warnings, and generate-format mapping; a category whose only applicable checks are tracked scores `null`. Renderers list them under "Tracked (not scored)".

6. **Top Issues** (`engine.ts:143-163`): Failed checks sorted by `estimateImpact()` — how many overall points would be gained by fixing this check. Impact = `(100 - checkScore) × (checkWeight / totalCategoryWeight) × categoryWeight`. Top 5 returned.

## Data Model

### Check

```typescript
// packages/core/src/audit/types.ts
interface Check {
  id: string;              // e.g., "llms-txt-exists"
  name: string;
  category: CategoryId;
  weight: number;          // relative importance within category
  tracked?: boolean;       // reported, not scored
  run(pages: FetchedPage[], metadata: SiteMetadata): Promise<CheckResult>;
}
```

### CheckResult

```typescript
interface CheckResult {
  id: string;
  name: string;
  category: CategoryId;
  status: "pass" | "fail" | "partial" | "skip" | "error"; // error = unmeasured, excluded from scoring
  score: number;           // 0-100
  maxScore: number;        // always 100
  weight: number;
  message: string;
  details?: string;
  fixSnippet?: string;     // code suggestion for fixing
  severity: "error" | "warning" | "info";
  tracked?: boolean;       // stamped from Check.tracked
}
```

### Category Weights

| Category | ID | Weight |
|----------|----|--------|
| Bot Accessibility | `bot-accessibility` | 0.15 |
| Structured Data | `structured-data` | 0.15 |
| Content Quality | `content-quality` | 0.15 |
| Agent Discovery | `agent-discovery` | 0.12 |
| Agent Protocols | `agent-protocols` | 0.13 |
| Technical Foundations | `technical` | 0.10 |
| Auth & Access | `agent-auth` | 0.20 |

### Grading Scale

| Grade | Score Range |
|-------|------------|
| A | 75–100 |
| B | 60–74 |
| C | 45–59 |
| D | 30–44 |
| F | 0–29 |

## Check Inventory

56 core checks (`allChecks`) across 10 files in `packages/core/src/audit/checks/`:

| File | Category | Example Checks |
|------|----------|---------------|
| `bot-accessibility.ts` | Bot Accessibility | robots.txt exists, sitemap exists, response time, content negotiation |
| `structured-data.ts` | Structured Data | Schema.org, JSON-LD, OpenGraph, semantic HTML |
| `content-quality.ts` | Content Quality | Token efficiency, answer-first structure, FAQ format, freshness |
| `discovery.ts` | Agent Discovery | llms.txt exists/valid, agent-card.json, .well-known endpoints |
| `protocols.ts` | Agent Protocols | MCP server, OpenAPI spec, forms, action schemas |
| `technical.ts` | Technical | HTTPS, security headers, canonical URLs, JavaScript-free content |
| `agent-auth.ts` | Auth & Access | Public API, OpenAPI spec, OAuth discovery, PKCE, MCP authorization |
| `reach.ts` | Agent Protocols | Homepage reachable under documented user-initiated agent UAs |
| `preferences.ts` | Bot Accessibility | Declared AI usage preferences (Content-Signal, AIPREF `Content-Usage`, RSL `License:`, TDMRep) |
| `edge.ts` | Bot Accessibility | Edge treatment of agent user-agents vs our declared crawler (tracked) |

Plus 2–4 platform-specific checks per adapter (e.g., WordPress PHP syntax, Next.js content negotiation).

## Platform Check Merging

When a platform is detected, its adapter's `checks` array is appended to the core check list:

```
core checks (56) + adapter.checks (2-4) = all checks (58-60, plus up to 3 site-type checks when a site type is detected)
```

Platform checks run in the same `Promise.all()` pass — no separate phase. They have the same `CheckResult` interface and participate in category scoring identically.

The `checksOverride` parameter (used by the platform for testing) bypasses both registry and adapter checks entirely.

## Error Handling

| Scenario | Behavior | Recovery |
|----------|----------|----------|
| Homepage fetch fails | Audit continues with empty pages array | Checks that need HTML will score 0 |
| Sitemap 404 | `metadata.sitemapXml` is undefined | Only homepage crawled; link fallback may discover more pages |
| Individual check throws | `Promise.all` rejects, audit fails | Caller handles error (CLI shows message, API returns 500) |
| Robots.txt blocks crawl | Respected — `Crawl-delay` honored | Pages that would be blocked are skipped |
| Timeout on page fetch | Page omitted from results | Other pages still analyzed |

## Anti-Patterns

❌ **WRONG**: Adding checks directly to `engine.ts` instead of the check registry.
✅ **CORRECT**: Create a check in `packages/core/src/audit/checks/`, export it from `index.ts`, and register it in the auto-registration module.

❌ **WRONG**: Making checks depend on other checks' results.
✅ **CORRECT**: Each check is independent — receives raw `pages` and `metadata`, returns its own result. No inter-check dependencies.

❌ **WRONG**: Using LLM calls inside checks for content analysis.
✅ **CORRECT**: All checks use deterministic HTTP/HTML analysis. Keep the core library LLM-free.

## Known Limitations

- **No JavaScript rendering** — the legacy HTML crawler can't execute JS. SPA sites get minimal page content. Spider.cloud (platform-only) mitigates this but isn't available in OSS.
- **Sitemap index files not supported** — only flat `<urlset>` sitemaps parsed. Large sites using `<sitemapindex>` get only homepage links + URL pattern scoring.
- **Homepage-only link counting** — internal link counts are from homepage only (the only page fetched before scoring). Sites with thin homepages get less link signal.
- **Check parallelism** — all checks run in a single `Promise.all()`. A slow check blocks the entire audit. No individual check timeout.
