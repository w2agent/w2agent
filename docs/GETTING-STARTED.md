# Getting Started with w2agent

## Quick Start

### CLI (zero-install)

```bash
npx w2agent audit https://your-site.com
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
pnpm --filter @w2agent/web dev
# Open http://localhost:3000
```

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

## CI/CD Integration

```yaml
# GitHub Actions
- run: npx w2agent audit ${{ env.SITE_URL }} --ci --threshold 80
```

## Project Structure

```
packages/core    - Shared audit engine (35+ checks, 6 categories)
packages/cli     - CLI tool (npx w2agent audit)
apps/web         - Next.js web UI
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
