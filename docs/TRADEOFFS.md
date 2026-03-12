# Design Tradeoffs

**Status**: Living document
**Last updated**: 2026-03-12

OSS-specific design decisions for the w2agent core library and CLI.

---

## Audit Engine

### Check registry (not config file)

Checks are registered programmatically via `registerCheck()`, not loaded from a config file. Benefits: type-safe, tree-shakeable, no filesystem dependency. Tradeoff: adding a check requires code changes, not just config.

### Weighted categories (not flat scoring)

6 categories with different weights (0.10–0.20) reflect that some aspects of AI-readiness matter more than others. Bot accessibility and structured data (0.20 each) are weighted higher than technical foundations (0.10) because they have more direct impact on AI agent success.

### Grade thresholds: A=75, not A=90

Grades are intentionally generous compared to traditional scales. An "A" at 75+ reflects that AI-readiness is a new field — very few sites score above 80. Strict thresholds would make the grading feel punitive. As the ecosystem matures and more sites adopt AI-ready practices, thresholds may tighten.

### Top issues ranked by impact, not severity

`estimateImpact()` calculates how many overall score points would be gained by fixing each check. A high-weight check in a high-weight category that partially fails gets prioritized over a low-weight check that completely fails. This surfaces the most actionable improvements.

### No LLM dependency in core

All audit checks and generators use deterministic HTTP/HTML analysis. No API keys needed, no cost per run, fully reproducible results. LLM-powered features (chat, query) live in the platform only.

---

## Platform Adapters

### Compiled-in adapters (not plugins)

Adapters are imported at module load, not discovered via filesystem scanning or configuration. Benefits: simple, fast startup, full TypeScript checking, tree-shakeable. Tradeoff: adding a platform requires modifying source code. Given only 6 platforms, plugin overhead isn't justified.

### Detection by highest confidence wins

Each adapter's `detect()` returns a confidence score (0–1). Registry picks the highest. This handles ambiguous signals (e.g., a site using both Next.js and WordPress in different paths). Tie-breaking: first registered adapter.

### Generated files, not config fragments

`generateIntegration()` returns complete, ready-to-write `GeneratedFile[]`. No assembly, no merging, no config patching. Simpler pipeline — the generate engine just writes files to disk. Tradeoff: generated files may conflict with existing project files (e.g., Next.js `public/llms.txt` + `app/llms.txt/route.ts` conflict in dev mode — known bug).

---

## Scoring

### URL pattern scoring heuristic

`getUrlPatternScore()` gives bonus points to paths like `/docs`, `/api`, `/pricing`, `/about`. These are statistically more valuable for AI agents than paths like `/tag/`, `/page/2`. The heuristic is hand-tuned, not data-driven. Works well enough for page selection within budget.

### Crawl-delay capped at 10 seconds

Sites with `Crawl-delay: 60` in robots.txt would make a 20-page crawl take 20+ minutes. The 10s cap is a pragmatic violation of the robots.txt spec. Accepted for usability — a 20-page crawl at 10s delay takes ~3.5 minutes, which is already slow.

### Internal link counting from homepage only

Link popularity is counted from the homepage only because it's the only page fetched before discovery/scoring. Multi-page link analysis would require a two-pass crawl (crawl N pages → count links → re-score → crawl more), adding complexity and latency.

---

## Crawl Reuse

### Single crawl for audit + generate

`crawlSite()` is called once, and its results feed both audit checks and content generation. The generate pipeline imports `crawlSite` from the audit module — they share the same crawler. No separate crawl paths, no data duplication.

### Sitemap + links + robots.txt in parallel

Initial metadata fetches (`robots.txt`, `sitemap.xml`, `llms.txt`, OpenAPI probes) run in parallel. This reduces crawl latency significantly — a site with slow robots.txt doesn't block sitemap parsing.

---

## Generate Pipeline

### Format selection via `--format`

Each generator is independent — `--format llms-txt` runs only that generator. `--format all` runs everything including WebMCP. This keeps generation fast for users who only need one format, while `all` provides the comprehensive output.

### Standalone MCP server project

The `mcp-server` format generates a complete Node.js project (`package.json`, `index.ts`, tool definitions). Self-contained — `npm install && npm start` works. The alternative (a config file that a global MCP runner interprets) would be simpler but less portable.

### WebMCP follows Chrome 146 Canary behavior

The WebMCP format (`webmcp.html`) follows the W3C draft spec as implemented in Chrome 146 Canary. If the spec renames attributes (e.g., `toolname` → `tool-name`), the generator needs updating. Accepted risk for an emerging standard.
