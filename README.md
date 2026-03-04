# w2agent

**AI Readiness Audit for the Web** — Like Lighthouse, but for AI agents.

Score any website's readiness for AI crawlers, LLMs, and autonomous agents. 35+ checks across 6 categories, with actionable fix suggestions.

```bash
npx w2agent audit https://your-site.com
```

```
  w2agent audit — AI Readiness Report
  ────────────────────────────────────

  URL: https://your-site.com
  Pages scanned: 12
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

- **35+ checks** across 6 scoring categories
- **No API keys required** — pure HTTP/HTML analysis, no LLM dependency
- **Multi-page** — crawls your sitemap, scores site-wide
- **Actionable** — shows fix snippets and "points if fixed" ROI
- **CLI + Web UI** — developer CLI and hosted web interface
- **CI/CD ready** — `--ci --threshold 80` for automated quality gates

## Install & Use

### CLI (zero-install)

```bash
# Basic audit
npx w2agent audit https://example.com

# Options
npx w2agent audit https://example.com --depth 10 --verbose
npx w2agent audit https://example.com --format json --output report.json
npx w2agent audit https://example.com --category structured-data

# CI mode
npx w2agent audit https://example.com --ci --threshold 80
```

### Web UI

```bash
pnpm install && pnpm build
pnpm --filter @w2agent/web dev
# Open http://localhost:3000
```

### From source

```bash
git clone https://github.com/anthropics/w2agent
cd w2agent
pnpm install
pnpm build
node packages/cli/dist/index.js audit https://example.com
```

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

## Project Structure

```
packages/core     Shared audit engine — checks, crawler, scoring
packages/cli      CLI tool (npx w2agent audit)
apps/web          Next.js web UI — paste URL, see score
```

## Development

```bash
pnpm install
pnpm build          # Build all packages
pnpm test           # Run tests (63 tests across 7 files)
pnpm dev            # Dev mode (watch + Next.js dev server)
```

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
