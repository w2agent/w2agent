# w2agent

**AI Readiness Audit for the Web** — Like Lighthouse, but for AI agents.

Score any website's readiness for AI crawlers, LLMs, and autonomous agents. 47+ checks across 6 categories, with actionable fix suggestions. Then **generate** the files to fix them — with platform-native integrations for WordPress, Next.js, Shopify, and Docusaurus.

```bash
npx w2agent audit https://your-site.com
npx w2agent generate https://your-site.com
npx w2agent integrate https://your-site.com
```

```
  w2agent audit — AI Readiness Report
  ────────────────────────────────────

  URL: https://your-site.com
  Pages scanned: 12
  Platform: WordPress (95% confidence)
  Time: 4.2s

  Overall Score: 72/100 (C)

  Bot Accessibility        ████████░░  82/100
  Structured Data          ██████░░░░  64/100
  Content Quality          ████████░░  78/100
  Agent Discovery          ███░░░░░░░  35/100
  Agent Protocols          ██░░░░░░░░  22/100
  Technical Foundations    █████████░  91/100

  Top Issues:
  ✗ No llms.txt found                       (+15 points if fixed)
  ✗ No Schema.org JSON-LD on 8/12 pages     (+12 points if fixed)
  ✗ No /.well-known/agent-card.json         (+8 points if fixed)
```

## Features

- **47+ checks** across 6 scoring categories (35 core + 12 platform-specific)
- **Platform detection** — auto-detects WordPress, Next.js, Shopify, Docusaurus
- **Platform integrations** — generates native plugins, middleware, Liquid snippets
- **Generate llms.txt + llms-full.txt** — auto-generate from any site
- **7 output formats** — llms.txt, llms-full.txt, robots.txt, schema-org.json, agent-card.json, faq.json, markdown
- **No API keys required** — pure HTTP/HTML analysis, no LLM dependency
- **Multi-page** — crawls sitemap + discovers pages via internal links
- **Actionable** — shows fix snippets and "points if fixed" ROI
- **CLI + Web UI** — developer CLI and hosted web interface with preview/download
- **CI/CD ready** — `--ci --threshold 80` for automated quality gates

## Install & Use

### CLI (zero-install)

```bash
# Audit a site
npx w2agent audit https://example.com
npx w2agent audit https://example.com --depth 10 --verbose
npx w2agent audit https://example.com --ci --threshold 80

# Generate llms.txt + llms-full.txt + all AI-ready files
npx w2agent generate https://example.com
npx w2agent generate https://example.com --format llms-txt
npx w2agent generate https://example.com --max-pages 200 --output ./output/

# Generate platform-specific integration files
npx w2agent integrate https://example.com
npx w2agent integrate https://example.com --platform wordpress

# Install integration files directly into your project
npx w2agent integrate https://example.com --install
npx w2agent integrate https://example.com --install --dry-run  # preview only
```

### Web UI

```bash
pnpm install && pnpm build
pnpm dev:web
# Open http://localhost:3737
```

Paste a URL → audit → click **"Generate Files"** → preview, copy, or download the results.

### From source

```bash
git clone https://github.com/anthropics/w2agent
cd w2agent
pnpm install
pnpm build
node packages/cli/dist/index.js audit https://example.com
node packages/cli/dist/index.js generate https://example.com
node packages/cli/dist/index.js integrate https://example.com
```

## Platform Adapters

w2agent auto-detects your platform and generates native integration code:

| Platform | Detection | Integration Generated | Tested |
|----------|-----------|----------------------|--------|
| **WordPress** | Generator meta, wp-content, wp-json | PHP plugin with dynamic llms.txt from WP database, admin page, robots.txt filter | Syntax + structure |
| **Next.js** | `__NEXT_DATA__`, `_next/static` | Route handlers with ISR, middleware for content negotiation, build script | Build + live audit |
| **Nuxt** | `__NUXT`, Nuxt meta tags | Nitro server routes, auto-imported middleware | Build + live audit |
| **Astro** | Generator meta, astro assets | Static files + middleware for content negotiation | Build + live audit |
| **Shopify** | cdn.shopify.com, Shopify headers | Liquid snippets, robots.txt.liquid, Product JSON-LD | Syntax + structure |
| **Docusaurus** | Generator meta, html class | Build plugin that generates llms.txt from docs directory | Build + live audit |

Platform-specific checks run automatically during audit:

- **WordPress** (4 checks): REST API, security plugin blocking, robots.txt AI rules, page builder markup
- **Next.js** (3 checks): .well-known serving, static generation, metadata API usage
- **Nuxt** (3 checks): Nitro compatibility, server route serving, middleware integration
- **Astro** (3 checks): static output structure, middleware support, build integration
- **Shopify** (3 checks): robots.txt customization, product schema, theme app blocks
- **Docusaurus** (2 checks): sidebar coverage, versioned docs discovery

## Scoring

Six categories with weighted scoring:

| Category | Weight | What it measures |
|----------|--------|-----------------|
| **Bot Accessibility** | 20% | Can AI crawlers reach your content? (robots.txt, sitemap, response time) |
| **Structured Data** | 20% | Is content machine-readable? (Schema.org, OpenGraph, semantic HTML) |
| **Content Quality** | 20% | Is content optimized for AI? (token efficiency, citations, freshness) |
| **Agent Discovery** | 15% | Can agents find your capabilities? (llms.txt, agent cards, .well-known) |
| **Agent Protocols** | 15% | Does the site support agent standards? (MCP, forms, action schemas) |
| **Technical Foundations** | 10% | Basics: HTTPS, security headers, canonical URLs, no-JS content |

**Grades:** A (90-100) · B (80-89) · C (70-79) · D (60-69) · F (0-59)

See [docs/CHECKS.md](docs/CHECKS.md) for the full check reference.

## CLI Options

```
w2agent audit <url> [options]

Options:
  -d, --depth <number>     Max pages to scan (default: 20)
  -f, --format <format>    Output format: terminal, json (default: terminal)
  -o, --output <file>      Write report to file
  -c, --category <cat>     Audit single category
  -v, --verbose            Show all checks with details
  --ci                     CI mode: exit code 1 if below threshold
  --threshold <score>      Minimum score for CI mode (default: 70)
  --timeout <ms>           Request timeout in ms (default: 10000)
```

```
w2agent generate <url> [options]

Options:
  -o, --output <dir>       Output directory (default: ./w2agent-output)
  -f, --format <format>    Output: llms-txt, full, markdown, robots-txt, schema-org, agent-card, faq, all (default: all)
  -m, --max-pages <n>      Max pages to crawl (default: 100)
  -s, --sections <list>    Only include these URL sections (comma-separated)
  --timeout <ms>           Request timeout in ms (default: 10000)
```

```
w2agent integrate <url> [options]

Options:
  -o, --output <dir>       Output directory (default: ./w2agent-output)
  -p, --platform <name>    Force platform: wordpress, nextjs, shopify, docusaurus
  -m, --max-pages <n>      Max pages to crawl (default: 100)
  --timeout <ms>           Request timeout in ms (default: 10000)
```

See [docs/GENERATE.md](docs/GENERATE.md) for detailed generation reference.

## Project Structure

```
packages/core     Shared engine — audit checks, generate, crawler, platform adapters
packages/cli      CLI tool (npx w2agent audit/generate/integrate)
apps/web          Next.js web UI — audit + generate with platform detection
```

## Development

```bash
pnpm install
pnpm build          # Build all packages
pnpm test           # Unit tests (216 tests across 10 files)
pnpm dev            # Dev mode (watch + Next.js dev server)

# Integration tests — builds real platform projects and audits them
pnpm --filter w2agent-core test:integration
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full developer guide, testing architecture, and how to add new platforms.

## CI/CD Integration

```yaml
# GitHub Actions
steps:
  - uses: actions/setup-node@v4
    with:
      node-version: 18
  - run: npx w2agent audit ${{ vars.SITE_URL }} --ci --threshold 80
```

## License

MIT
