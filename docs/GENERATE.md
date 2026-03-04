# w2agent generate — Reference

Generate llms.txt, llms-full.txt, and per-page markdown files for any website.

## Usage

```bash
npx w2agent generate <url> [options]
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <dir>` | `./w2agent-output` | Output directory |
| `-f, --format <fmt>` | `all` | Output format: `llms-txt`, `full`, `markdown`, `all` |
| `-m, --max-pages <n>` | `50` | Maximum pages to crawl |
| `-s, --sections <list>` | all | Only these URL path prefixes (comma-separated) |
| `--timeout <ms>` | `10000` | Per-request timeout |

## Output Files

### llms.txt

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

Pages are auto-categorized into sections by URL path:
- `/docs/*` → "Docs"
- `/blog/*` → "Blog"
- `/api/*` → "API"
- Other common prefixes are recognized (guides, tutorials, products, etc.)
- Unrecognized paths use the first URL segment as the section name

Descriptions are sourced from: meta description → first content sentence.

### llms-full.txt

Full site content concatenated with frontmatter separators:

```markdown
---
url: https://example.com/page
title: Page Title
---

[full page content as markdown]
```

### Per-page Markdown

Individual `.md` files for each page, written to `markdown/` subdirectory:

```
w2agent-output/
├── llms.txt
├── llms-full.txt
└── markdown/
    ├── index.md
    ├── docs-getting-started.md
    ├── docs-api.md
    └── blog-latest-post.md
```

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
```

## Web UI

Start the dev server and open http://localhost:3737:

```bash
pnpm dev:web
```

1. Paste a URL and click **Audit**
2. After results appear, click **"Generate Files"**
3. Preview the generated llms.txt / llms-full.txt inline
4. Copy to clipboard or download individual files

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

Returns a `GenerateResult` JSON with all generated files.

## Programmatic Use

```typescript
import { runGenerate } from "@w2agent/core";

const result = await runGenerate("https://example.com", {
  maxPages: 20,
  formats: ["llms-txt", "full"],
});

for (const file of result.files) {
  console.log(file.filename, file.size);
  // Write file.content to disk
}
```
