# Generate Pipeline Architecture

**Status**: Implemented
**Last updated**: 2026-03-12

## Overview

The generate pipeline converts a website into AI-ready files — `llms.txt`, agent cards, FAQ schemas, markdown exports, standalone MCP servers, and more. It powers both `w2agent generate <url>` and the platform's `/api/generate` endpoint.

Like the audit engine, the generate pipeline is LLM-free. All output is derived from crawled HTML through deterministic transformations.

## Design Decisions

- **Crawl-once reuse** — uses the same `crawlSite()` from the audit engine. No redundant fetching if both audit and generate run on the same site.
- **Generator inventory** — 10+ output formats, each in its own module. Formats are independent — generating `llms.txt` doesn't require generating `agent-card.json`.
- **Platform integration hooks** — after core generators run, the detected platform adapter's `generateIntegration()` adds platform-native files (e.g., Next.js route handlers, WordPress plugins).
- **Format selection** — `--format` flag filters which generators run. `--format all` includes everything including WebMCP.

## How It Works

```
URL
 │
 ▼
┌────────────┐     ┌───────────────────┐
│ crawlSite  │────▶│ Convert to        │
│ (reused)   │     │ PageMarkdown[]    │
└────────────┘     └─────────┬─────────┘
                             │
                    ┌────────▼──────────┐
                    │ Run generators    │
                    │ (per format)      │
                    │ • llms-txt        │
                    │ • llms-full-txt   │
                    │ • agent-card      │
                    │ • faq             │
                    │ • schema-org      │
                    │ • robots-txt      │
                    │ • markdown        │
                    │ • mcp-server      │
                    │ • skill-md        │
                    │ • openclaw        │
                    │ • webmcp          │
                    └────────┬──────────┘
                             │
                    ┌────────▼──────────┐
                    │ detectPlatform()  │
                    │ + generateInteg() │
                    └────────┬──────────┘
                             │
                             ▼
                      GenerateResult
                      { files[], pages[] }
```

### Step-by-step

1. **Crawl** (`packages/core/src/audit/crawler.ts`): Same crawler as audit — fetches homepage, robots.txt, sitemap, .well-known files. Discovers and selects pages using smart scoring.

2. **Link fallback** (`engine.ts:54-79`): If sitemap yields ≤1 page and `maxPages > 1`, extracts internal links from homepage HTML, ranks by URL score, and fetches in batches of 5.

3. **Convert to markdown** (`engine.ts:82-94`): Each fetched page with status 200 is converted via `htmlToMarkdown()`. Deduplicated by normalized URL (trailing slash stripped).

4. **Section filtering** (`engine.ts:97-110`): If `options.sections` specified, pages are filtered by URL path prefix.

5. **Build context** (`engine.ts:112+`): `GenerateContext` assembled with site info extracted from homepage + pages.

6. **Run generators**: Each enabled format produces `GeneratedFile[]`:

| Generator | Output | Key File |
|-----------|--------|----------|
| `llms-txt` | `llms.txt` — structured page index per llmstxt.org spec | `llms-txt.ts` |
| `llms-full-txt` | `llms-full.txt` — full markdown content concatenated | `llms-full-txt.ts` |
| `agent-card` | `agent-card.json` — A2A-compliant agent discovery | `agent-card.ts` |
| `faq` | `faq.json` — FAQPage schema from detected Q&A content | `faq.ts` |
| `schema-org` | `schema-org.json` — extracted JSON-LD from pages | `schema-org.ts` |
| `robots-txt` | `robots.txt` — AI-friendly crawl rules | `robots-txt.ts` |
| `markdown` | `markdown/*.md` — per-page markdown exports | (inline in engine) |
| `mcp-server` | `mcp-server/` — standalone MCP server project with tool annotations | `mcp-server.ts` |
| `skill-md` | `skills/<name>/SKILL.md` — Agent Skills file (`<name>` from `skillName()`) | `skill-md.ts` |
| `openclaw` | `openclaw/skills/<name>/SKILL.md` — OpenClaw format skill | `skill-md-openclaw.ts` |
| `webmcp` | `webmcp.html` — WebMCP declarations (W3C draft) | `webmcp.ts` |

7. **Platform integration**: If a platform was detected, `adapter.generateIntegration(ctx, coreFiles)` produces platform-specific files (route handlers, plugins, etc.).

## Data Model

### GenerateContext

```typescript
// packages/core/src/generate/types.ts
interface GenerateContext {
  url: string;
  siteInfo: SiteInfo;       // name, description, baseUrl
  pages: PageMarkdown[];     // converted markdown pages
  metadata: SiteMetadata;    // robots.txt, sitemap, llms.txt, etc.
}
```

### GeneratedFile

```typescript
interface GeneratedFile {
  path: string;              // relative path (e.g., "llms.txt", "mcp-server/index.ts")
  content: string;           // file content
  format: string;            // generator that produced it
}
```

### GenerateResult

```typescript
interface GenerateResult {
  files: GeneratedFile[];
  pages: PageMarkdown[];     // for consumers that need page data
  duration: number;
  platform?: PlatformDetectionResult;
}
```

## Platform Integration Hooks

After core generators run, the detected platform adapter adds platform-native implementations:

| Platform | Generated Files |
|----------|----------------|
| Next.js | `app/llms.txt/route.ts`, `app/.well-known/agent-card.json/route.ts`, middleware |
| Nuxt | `server/routes/llms.txt.ts`, Nitro middleware |
| Astro | `public/llms.txt`, `public/.well-known/agent-card.json`, middleware |
| WordPress | `w2agent-plugin.php` with admin page, robots.txt filter, Schema.org |
| Shopify | Liquid snippets, JSON-LD templates |
| Docusaurus | Build plugin, static files |

Platform files override core files when they serve the same purpose (e.g., Next.js route handler replaces static `llms.txt`).

## Error Handling

| Scenario | Behavior | Recovery |
|----------|----------|----------|
| Site unreachable | Crawl fails, generate fails | CLI/API returns error |
| No pages found | Empty `pages[]`, minimal output | llms.txt still generated (with site info only) |
| Platform detection fails | No platform integration files | Core files still generated |
| Individual generator throws | That format's files missing | Other formats unaffected |

## Tradeoffs & Alternatives

**Why deterministic generation (no LLM)?**
Keeps core dependency-free, fast, and reproducible. The same URL always produces the same output. LLM-powered generation (e.g., better descriptions) could be added as an optional enhancement without breaking the core pipeline.

**Why per-page markdown (not a single concatenated output)?**
Per-page markdown preserves URL attribution and enables selective page serving (the `get-page` MCP tool). `llms-full.txt` provides the concatenated version for clients that want everything in one file.

**Why standalone MCP server project (not just config)?**
The generated `mcp-server/` is a complete Node.js project with `package.json`, ready to `npm install && npm start`. Self-contained deployability — users don't need to understand MCP internals. Includes tool annotations for AI client hints.

## Anti-Patterns

❌ **WRONG**: Adding generator logic directly to `engine.ts`.
✅ **CORRECT**: Each generator is a separate module in `packages/core/src/generate/`. Engine orchestrates; generators produce.

❌ **WRONG**: Generators depending on other generators' output.
✅ **CORRECT**: All generators receive the same `GenerateContext`. No ordering dependencies.

❌ **WRONG**: Hardcoding platform-specific paths in core generators.
✅ **CORRECT**: Core generators produce generic files. Platform adapters produce platform-specific versions.

## Known Limitations

- **`--format all` includes everything** — WebMCP is included in `all`. If a format should be excluded from `all`, add it to the exclusion list in `parseFormats()`.
- **OpenClaw SKILL.md has no `version`** — OpenClaw does not document that key, so it is not emitted. The generated skills carry no version at all.
- **WebMCP spec is draft** — follows the CG draft of 2026-09-10 (`document.modelContext`, `navigator.modelContext` fallback; attributes `toolname`/`tooldescription`/`toolautosubmit`/`toolparamdescription`). May need updating if the spec renames attributes or moves the API again.
- **No incremental generation** — full crawl + full generation every time. No diffing against previous output.
