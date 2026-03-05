# w2agent generate — Reference

Generate llms.txt, llms-full.txt, and per-page markdown files for any website. Auto-detects platform and generates native integration files.

## Usage

```bash
npx w2agent generate <url> [options]
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <dir>` | `./w2agent-output` | Output directory |
| `-f, --format <fmt>` | `all` | Output format: `llms-txt`, `full`, `markdown`, `robots-txt`, `schema-org`, `agent-card`, `faq`, `mcp-server`, `all` |
| `-m, --max-pages <n>` | `100` | Maximum pages to crawl |
| `-s, --sections <list>` | all | Only these URL path prefixes (comma-separated) |
| `--timeout <ms>` | `10000` | Per-request timeout |

## Output Files

### Core Files (always generated)

#### llms.txt

Structured index following the [llmstxt.org](https://llmstxt.org) spec:

```markdown
# Site Name

> One-line description

## Docs

- [Getting Started](/docs/getting-started): How to set up the project
- [API Reference](/docs/api): Complete API documentation

## Blog

- [Latest Post](/blog/latest): Description of the post
```

Pages are auto-categorized into sections by URL path.

#### llms-full.txt

Full site content concatenated with frontmatter separators:

```markdown
---
url: https://example.com/page
title: Page Title
---

[full page content as markdown]
```

#### robots.txt

AI-friendly robots.txt with rules for known AI crawlers.

#### schema-org.json

Auto-detected Schema.org JSON-LD for the site.

#### agent-card.json

Agent discovery card at `/.well-known/agent-card.json`.

#### faq.json

Extracted FAQ content in FAQPage schema format.

#### Per-page Markdown

Individual `.md` files for each page, written to `markdown/` subdirectory.

#### MCP Server (`mcp-server`)

A standalone MCP server project generated from crawled site content. Output to `mcp-server/`:

| File | Description |
|------|-------------|
| `server.ts` | MCP server with auto-detected tools, Express + Streamable HTTP |
| `data/pages.json` | All crawled pages as PageMarkdown[] |
| `data/faq.json` | FAQ entries (if detected) |
| `package.json` | Dependencies: @modelcontextprotocol/sdk, express, zod, tsx |
| `tsconfig.json` | Node ESM TypeScript config |
| `README.md` | Tool list, setup instructions, Claude Desktop config |

Auto-detected tools:

| Tool | Condition | Description |
|------|-----------|-------------|
| `list-pages` | Always | List all page titles + URLs |
| `get-page` | Always | Get markdown content by URL or slug |
| `search-site` | Always | Keyword search with weighted scoring (title 3x, description 2x, content 1x) |
| `search-faq` | FAQ content found | Search FAQ question/answer pairs |
| `site-search` | SearchAction in JSON-LD | Site's native search URL |
| `submit-form-N` | Forms with action + named inputs | One tool per detected form |

Also available via `w2agent mcp deploy`:

```bash
w2agent mcp deploy <url>                     # Standalone MCP server
w2agent mcp deploy <url> --self-host vercel  # Vercel-deployable project
w2agent mcp deploy <url> --self-host cf      # Cloudflare Worker project
w2agent mcp status <slug>                    # Check hosted deployment
w2agent mcp update <slug>                    # Re-crawl hosted deployment
```

### Platform Integration Files (auto-detected)

When a platform is detected, additional integration files are generated:

| Platform | Files Generated |
|----------|----------------|
| **WordPress** | `wordpress/w2agent-plugin.php` — PHP plugin with dynamic llms.txt generation, admin page, robots.txt filter, `wordpress/data/` seed files, `wordpress/INSTALL.md` |
| **Next.js** | `nextjs/app/llms.txt/route.ts` — ISR route handler, `nextjs/middleware.ts` — content negotiation, `nextjs/w2agent-build.mjs` — CI/CD build script, `nextjs/INSTALL.md` |
| **Nuxt** | `nuxt/server/routes/llms.txt.ts` — Nitro server route, `nuxt/server/middleware/content-negotiation.ts`, `nuxt/INSTALL.md` |
| **Astro** | `astro/public/llms.txt` — static file, `astro/public/.well-known/agent-card.json`, `astro/src/middleware.ts` — content negotiation, `astro/INSTALL.md` |
| **Shopify** | `shopify/snippets/w2agent-head.liquid` — head snippet with Product JSON-LD, `shopify/templates/robots.txt.liquid`, `shopify/INSTALL.md` |
| **Docusaurus** | `docusaurus/w2agent-plugin.js` — build plugin that generates llms.txt from docs directory, `docusaurus/INSTALL.md` |

## Platform Detection

Detection runs against already-crawled pages (zero extra HTTP requests):

| Platform | Signal | Confidence |
|----------|--------|-----------|
| WordPress | `<meta name="generator" content="WordPress">` | 100% |
| WordPress | `/wp-content/` or `/wp-includes/` in HTML | 95% |
| Next.js | `__NEXT_DATA__` script tag | 100% |
| Next.js | `/_next/static/` in asset paths | 95% |
| Nuxt | `__NUXT` in HTML or Nuxt meta tags | 95% |
| Astro | `<meta name="generator" content="Astro">` | 100% |
| Shopify | `cdn.shopify.com` in assets | 95% |
| Docusaurus | `<meta name="generator" content="Docusaurus">` | 100% |

## `integrate` Command

Focused command for platform-specific output only:

```bash
npx w2agent integrate <url> [--platform wordpress|nextjs|nuxt|astro|shopify|docusaurus]
```

Auto-detects platform (or use `--platform` to force), generates only integration files, and shows deployment instructions.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <dir>` | `./w2agent-output` | Output directory (default mode) |
| `-p, --platform <platform>` | auto-detect | Force platform |
| `-m, --max-pages <n>` | `100` | Maximum pages to crawl |
| `--timeout <ms>` | `10000` | Per-request timeout |
| `--install` | off | Install files directly into your project |
| `--project-dir <dir>` | `.` | Project root for `--install` |
| `--dry-run` | off | Show what `--install` would do without writing files |

### `--install` Mode

With `--install`, files are copied directly into your project instead of an output directory:

```bash
npx w2agent integrate https://my-site.com --install
npx w2agent integrate https://my-site.com --install --project-dir ../my-app
npx w2agent integrate https://my-site.com --install --dry-run  # preview only
```

Each platform has a dedicated install resolver that detects your project layout and handles conflicts:

- **Next.js** — detects `src/app/` vs `app/`, Pages Router vs App Router, existing middleware/routes
- **Nuxt** — detects Nuxt 2 vs 3, existing server routes and middleware
- **Astro** — detects static vs SSR/hybrid output mode, installs SSR endpoints only when applicable
- **Docusaurus** — detects existing plugin config, checks for `gray-matter` dependency
- **WordPress** — detects WP root, custom plugin dir, installs to `wp-content/plugins/w2agent/`
- **Shopify** — detects theme directory, never overwrites existing `robots.txt.liquid`

Behavior:
- Skips non-project files (`INSTALL.md`)
- Detects existing files and skips with warnings instead of overwriting
- Existing middleware with w2agent code → skipped; without → saved as `.w2agent.ts` for manual merge
- Prints post-install steps (e.g., "add postbuild script", "activate plugin")
- Use `--dry-run` to preview the install plan without writing anything

## Page Discovery

Pages are discovered in two ways:

1. **Sitemap** — If `sitemap.xml` exists, URLs are extracted and crawled (up to `--max-pages`)
2. **Link fallback** — If the sitemap yields no extra pages, internal links from fetched pages are extracted and crawled

This means `w2agent generate` works on any site, even SPAs or sites without sitemaps.

## Content Extraction

The HTML → Markdown converter:

1. **Strips boilerplate** — nav, header, footer, sidebar, ads are removed using content density scoring
2. **Finds main content** — via `<main>`, `<article>`, `role="main"`, or highest text-density node
3. **Preserves structure** — headings, lists, tables, code blocks (with language hints), images (with alt text), links
4. **Inline formatting** — bold, italic, inline code, links converted to markdown syntax

## Examples

```bash
# Generate everything for a site
npx w2agent generate https://docs.example.com

# Only generate llms.txt
npx w2agent generate https://example.com --format llms-txt

# Only docs and blog sections, output to public/
npx w2agent generate https://example.com --sections docs,blog --output ./public/

# Crawl up to 100 pages
npx w2agent generate https://large-site.com --max-pages 100

# Generate platform integration files only
npx w2agent integrate https://your-wp-site.com
npx w2agent integrate https://your-site.com --platform nextjs
```

## Web UI

Start the dev server and open http://localhost:3737:

```bash
pnpm dev:web
```

1. Paste a URL and click **Audit**
2. After results appear, click **"Generate Files"**
3. Preview generated files inline — core files and platform integration files are grouped separately
4. Copy to clipboard or download individual files
5. Platform detection badge shows which platform was detected

## Web API

`POST /api/generate` with JSON body:

```json
{
  "url": "https://example.com",
  "options": {
    "maxPages": 20,
    "formats": ["llms-txt", "full"]
  }
}
```

Returns a `GenerateResult` JSON with all generated files and `platform` detection result.

## Programmatic Use

```typescript
import { runGenerate } from "w2agent-core";

const result = await runGenerate("https://example.com", {
  maxPages: 20,
  formats: ["llms-txt", "full"],
});

// Platform detection result
if (result.platform) {
  console.log(`Detected: ${result.platform.platform} (${result.platform.confidence})`);
}

for (const file of result.files) {
  console.log(file.filename, file.size);
}
```
