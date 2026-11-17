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

Try the hosted version at [w2agent.dev](https://w2agent.dev) — audit a site and generate files directly in the browser with preview, copy, and download.

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
  --json                   One JSON document on stdout (report or error envelope)
```

Platform-specific checks run automatically when WordPress, Next.js, Shopify, or Docusaurus is detected.

### `generate` — Create AI-ready files

```bash
w2agent generate <url> [options]

Options:
  -o, --output <dir>       Output directory (default: ./w2agent-output)
  -f, --format <format>    Comma-separated or repeated: llms-txt, full, markdown, robots-txt, schema-org, agent-card, faq, webmcp, all (default: all); opt-in: mcp-server, skill-md, openclaw, agents-md
  --no-platform            Do not write platform integration files (nextjs/, nuxt/, ...)
  --from-audit             Run audit first, generate fixes for failed checks only
  -m, --max-pages <n>      Max pages to crawl (default: 100)
  -s, --sections <list>    Only these URL sections (comma-separated)
  --timeout <ms>           Request timeout (default: 10000)
```

When a platform is detected, integration files are automatically included in the output unless you pass `--no-platform`.

### `integrate` — Platform-specific integration

```bash
w2agent integrate <url> [options]

Options:
  -o, --output <dir>       Output directory (default: ./w2agent-output)
  -p, --platform <name>    Force platform: wordpress, nextjs, shopify, docusaurus
  -m, --max-pages <n>      Max pages to crawl (default: 100)
  --timeout <ms>           Request timeout (default: 10000)
  --install                Install files directly into your project
  --project-dir <dir>      Project root for --install (default: .)
  --dry-run                Show what --install would do; never writes files
  --site-url <url>         Production origin to write into generated content when crawling another origin
  --json                   One JSON document on stdout (result or error envelope)
```

Focused command that generates only platform-specific files with deployment instructions.

### `login` / `logout` / `whoami` — Authentication

```bash
w2agent login            # Authenticate with w2agent.dev (required for agentize)
w2agent logout           # Clear stored credentials
w2agent whoami           # Show current authenticated user
w2agent login --api-key <key> [--json]   # Required when AI_AGENT, CLAUDECODE or CODEX_CI is set, or stdin is not a TTY
```

### `schema` — Machine-readable command reference

```bash
w2agent schema           # Print every command and option as JSON
```

Scripts and AI agents: `--json` on `audit`, `integrate` and `login` prints one JSON document on stdout. For `audit`, `integrate`, `login` and `schema`, exit codes are 0 (success), 1 (operational error), 2 (usage error). See [CLI-AGENT-MODE.md](CLI-AGENT-MODE.md).

### `mcp` — Generate and deploy agent servers

```bash
# Generate a standalone agent server
w2agent agent deploy <url>

# Generate a Vercel-deployable agent server
w2agent agent deploy <url> --self-host vercel

# Generate a Cloudflare Worker agent server
w2agent agent deploy <url> --self-host cf

# Check hosted deployment status
w2agent agent status <slug>

# Re-crawl and update hosted deployment
w2agent agent update <slug>

Options:
  --self-host <platform>   Self-host platform: vercel, cf
  -o, --output <dir>       Output directory (default: ./w2agent-output)
  -m, --max-pages <n>      Max pages to crawl (default: 100)
  --timeout <ms>           Request timeout (default: 10000)
```

Auto-detects tools from crawled content: page listing, search, FAQ, site-search (via SearchAction), and form submission.

## Workflow

The typical workflow is: audit → see issues → generate fixes → deploy.

```bash
# 1. Audit your site
npx w2agent audit https://your-site.com

# 2. Generate llms.txt and llms-full.txt into the served dir (--no-platform skips the platform integration tree)
npx w2agent generate https://your-site.com --format llms-txt,full --no-platform --output ./public/

# 2b. Generate the platform integration files that step 3 deploys (WordPress, Next.js, Shopify, Docusaurus)
npx w2agent integrate https://your-site.com

# 3. Deploy the generated files to your site
#    - WordPress: upload plugin to /wp-content/plugins/
#    - Next.js: copy route handlers + middleware
#    - Shopify: paste Liquid snippets into theme
#    - Docusaurus: add build plugin to config
#    - Any site: copy files to site root

# 4. Generate an agent server so agents can search/read your site
npx w2agent agent deploy https://your-site.com

# 5. Re-audit to confirm score improvement
npx w2agent audit https://your-site.com
```

See [GENERATE.md](GENERATE.md) for detailed reference.

## Platform Adapters

| Platform | What gets generated | How it stays fresh |
|----------|--------------------|--------------------|
| **WordPress** | PHP plugin with admin page | Dynamically generates llms.txt from WP database on each request |
| **Next.js** | Route handlers + middleware | Routes revalidate hourly (ISR) but re-read the same deployed file, so new content arrives only with the next build; a `prebuild` script refreshes the content from the live site before each build (the previous deploy; the first deploy serves the install-time seed) |
| **Nuxt** | Nitro server routes + middleware | Server routes generate llms.txt dynamically per request |
| **Astro** | Static files + middleware | Static output at build time, middleware for content negotiation |
| **Shopify** | Liquid snippets + robots.txt.liquid | Liquid templates use live store data (product titles, prices) |
| **Docusaurus** | Build plugin | Reads the built docs content, generates llms.txt with real URLs; an existing `static/llms.txt` is served as is unless `overwrite: true` |

## CI/CD Integration

```yaml
# GitHub Actions
- run: npx w2agent audit ${{ env.SITE_URL }} --ci --threshold 80
```

## Project Structure

```
packages/core    - Shared engine (audit + generate + platform adapters)
packages/cli     - CLI tool (audit + generate + integrate commands)
```

## Scoring

Rubric 3.1: 57 checks, 50 scored and 7 tracked (weight 0). See [CHECKS.md](CHECKS.md).

| Category | Weight |
|----------|--------|
| Bot Accessibility | 15% |
| Structured Data | 15% |
| Content Quality | 15% |
| Agent Discovery | 12% |
| Agent Protocols | 13% |
| Technical Foundations | 10% |
| Auth & Access | 20% |

Grades are assigned on the unrounded score: A ≥ 75, B ≥ 60, C ≥ 45, D ≥ 30, F < 30. The printed score is rounded, so 74.6 shows as `75/100 (B)`.
