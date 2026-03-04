# Getting Started with w2agent

## Quick Start

### CLI (zero-install)

```bash
# Audit a site
npx w2agent audit https://your-site.com

# Generate llms.txt and all AI-ready files
npx w2agent generate https://your-site.com

# Generate platform-specific integration files
npx w2agent integrate https://your-site.com
```

### From source

```bash
# Clone and install
pnpm install
pnpm build

# Run audit
node packages/cli/dist/index.js audit https://your-site.com
```

### Web UI

```bash
pnpm dev:web
# Open http://localhost:3737
```

The web UI lets you audit a site and then generate files directly in the browser — with preview, copy, and download. Platform detection is shown as a badge in the results.

## CLI Commands

### `audit` — Score AI readiness

```bash
w2agent audit <url> [options]

Options:
  -d, --depth <number>     Max pages to scan (default: 20)
  -f, --format <format>    Output: terminal, json (default: terminal)
  -o, --output <file>      Write report to file
  -c, --category <cat>     Audit specific category only
  -v, --verbose            Show all checks
  --ci                     CI mode: exit code based on threshold
  --threshold <score>      Min score for CI mode (default: 70)
  --timeout <ms>           Request timeout (default: 10000)
```

Platform-specific checks run automatically when WordPress, Next.js, Shopify, or Docusaurus is detected.

### `generate` — Create AI-ready files

```bash
w2agent generate <url> [options]

Options:
  -o, --output <dir>       Output directory (default: ./w2agent-output)
  -f, --format <format>    Output: llms-txt, full, markdown, robots-txt, schema-org, agent-card, faq, all (default: all)
  -m, --max-pages <n>      Max pages to crawl (default: 50)
  -s, --sections <list>    Only these URL sections (comma-separated)
  --timeout <ms>           Request timeout (default: 10000)
```

When a platform is detected, integration files are automatically included in the output.

### `integrate` — Platform-specific integration

```bash
w2agent integrate <url> [options]

Options:
  -o, --output <dir>       Output directory (default: ./w2agent-output)
  -p, --platform <name>    Force platform: wordpress, nextjs, shopify, docusaurus
  -m, --max-pages <n>      Max pages to crawl (default: 50)
  --timeout <ms>           Request timeout (default: 10000)
```

Focused command that generates only platform-specific files with deployment instructions.

### `mcp` — Generate and deploy MCP servers

```bash
# Generate a standalone MCP server
w2agent mcp deploy <url>

# Generate a Vercel-deployable MCP server
w2agent mcp deploy <url> --self-host vercel

# Generate a Cloudflare Worker MCP server
w2agent mcp deploy <url> --self-host cf

# Check hosted deployment status
w2agent mcp status <slug>

# Re-crawl and update hosted deployment
w2agent mcp update <slug>

Options:
  --self-host <platform>   Self-host platform: vercel, cf
  -o, --output <dir>       Output directory (default: ./w2agent-output)
  -m, --max-pages <n>      Max pages to crawl (default: 50)
  --timeout <ms>           Request timeout (default: 10000)
```

Auto-detects tools from crawled content: page listing, search, FAQ, site-search (via SearchAction), and form submission.

## Workflow

The typical workflow is: audit → see issues → generate fixes → deploy.

```bash
# 1. Audit your site
npx w2agent audit https://your-site.com

# 2. Generate llms.txt and friends (platform integration files auto-included)
npx w2agent generate https://your-site.com --output ./public/

# 3. Deploy the generated files to your site
#    - WordPress: upload plugin to /wp-content/plugins/
#    - Next.js: copy route handlers + middleware
#    - Shopify: paste Liquid snippets into theme
#    - Docusaurus: add build plugin to config
#    - Any site: copy files to site root

# 4. Generate an MCP server so agents can search/read your site
npx w2agent mcp deploy https://your-site.com

# 5. Re-audit to confirm score improvement
npx w2agent audit https://your-site.com
```

See [GENERATE.md](GENERATE.md) for detailed reference.

## Platform Adapters

| Platform | What gets generated | How it stays fresh |
|----------|--------------------|--------------------|
| **WordPress** | PHP plugin with admin page | Dynamically generates llms.txt from WP database on each request |
| **Next.js** | Route handlers + middleware | ISR revalidation (1h) + build script for CI/CD |
| **Shopify** | Liquid snippets + robots.txt.liquid | Liquid templates use live store data (product titles, prices) |
| **Docusaurus** | Build plugin | Reads docs/ directory at build time, generates fresh llms.txt |

## CI/CD Integration

```yaml
# GitHub Actions
- run: npx w2agent audit ${{ env.SITE_URL }} --ci --threshold 80
```

## Project Structure

```
packages/core    - Shared engine (audit + generate + platform adapters)
packages/cli     - CLI tool (audit + generate + integrate commands)
apps/web         - Next.js web UI (audit + generate)
```

## Scoring

| Category | Weight |
|----------|--------|
| Bot Accessibility | 20% |
| Structured Data | 20% |
| Content Quality | 20% |
| Agent Discovery | 15% |
| Agent Protocols | 15% |
| Technical Foundations | 10% |

Grades: A (90-100), B (80-89), C (70-79), D (60-69), F (0-59)
