# Getting Started with w2agent

## Quick Start

### CLI (zero-install)

```bash
# Audit a site
npx w2agent audit https://your-site.com

# Generate llms.txt and llms-full.txt
npx w2agent generate https://your-site.com
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

The web UI lets you audit a site and then generate files directly in the browser — with preview, copy, and download.

## CLI Options

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

```bash
w2agent generate <url> [options]

Options:
  -o, --output <dir>       Output directory (default: ./w2agent-output)
  -f, --format <format>    Output: llms-txt, full, markdown, all (default: all)
  -m, --max-pages <n>      Max pages to crawl (default: 50)
  -s, --sections <list>    Only these URL sections (comma-separated)
  --timeout <ms>           Request timeout (default: 10000)
```

## Generate Workflow

The typical workflow is: audit → see issues → generate fixes.

```bash
# 1. Audit your site
npx w2agent audit https://your-site.com

# 2. Generate llms.txt and friends
npx w2agent generate https://your-site.com --output ./public/

# 3. Deploy the generated files to your site root
# 4. Re-audit to confirm score improvement
npx w2agent audit https://your-site.com
```

See [GENERATE.md](GENERATE.md) for detailed reference.

## CI/CD Integration

```yaml
# GitHub Actions
- run: npx w2agent audit ${{ env.SITE_URL }} --ci --threshold 80
```

## Project Structure

```
packages/core    - Shared engine (audit + generate)
packages/cli     - CLI tool (audit + generate commands)
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
