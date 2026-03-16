# w2agent

**Every website is already an agent.** w2agent audits, generates, and deploys
any website as a live MCP server — discoverable and queryable by Claude, GPT,
and any MCP-compatible AI tool.

<!-- gif: cli-audit — terminal running `npx w2agent audit https://stripe.com`, score output scrolling in -->

```bash
npx w2agent audit https://your-site.com     # score it
npx w2agent agentize https://your-site.com  # deploy it as an MCP server
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

## The Pipeline

Turn any website into a queryable AI agent in four steps:

| Step | Command | What happens |
|------|---------|-------------|
| **1. Audit** | `npx w2agent audit <url>` | Score AI-readiness across 47+ checks. Find what's blocking agents. |
| **2. Generate** | `npx w2agent generate <url>` | Generate llms.txt, agent-card.json, schema-org.json, and more. |
| **3. Integrate** | `npx w2agent integrate <url>` | Install platform-native files (WordPress plugin, Next.js middleware). |
| **4. Agentize** | `npx w2agent agentize <url>` | Host the site as a live MCP server at `<slug>.mcp.w2agent.dev`. |

For a complete step-by-step methodology — site analysis, agent architecture decisions, output verification, and quality validation — see [AGENTIZE.md](AGENTIZE.md).

## The Agent Network

Every agentized site joins a shared network — discoverable via the
[w2agent directory](https://w2agent.dev/directory) and the **Meta MCP** discovery
server.

<!-- gif: meta-mcp-discovery — Claude Desktop showing `search_websites` tool call, returning a list of 5 dev-tool agents -->

**Use any agent in Claude Desktop** by adding the Meta MCP endpoint:

```json
{
  "mcpServers": {
    "w2agent-meta": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.w2agent.dev/mcp"]
    }
  }
}
```

Once connected, Claude can discover and query any of the 100+ sites in the directory:

> "I'm building a SaaS app. What agents do you have for Next.js, Supabase, and Stripe?"

<!-- gif: env-synthesis — Claude synthesizing a .env.example from 3 different site-agents in one response -->

**Individual agents** are accessible directly:
- Hosted: `https://<slug>.mcp.w2agent.dev/mcp`
- Self-hosted: deploy the generated MCP server to Vercel or Cloudflare Workers

[Browse the directory →](https://w2agent.dev/directory)

## Features

- **60 checks** across 6 scoring categories (41 core + 19 platform-specific)
- **Platform detection** — auto-detects WordPress, Next.js, Shopify, Docusaurus
- **Platform integrations** — generates native plugins, middleware, Liquid snippets
- **Generate llms.txt + llms-full.txt** — auto-generate from any site
- **10 output formats** — llms.txt, llms-full.txt, robots.txt, schema-org.json, agent-card.json, faq.json, markdown, skill-md, webmcp, openclaw
- **No API keys required** — pure HTTP/HTML analysis, no LLM dependency for audit/generate
- **Multi-page** — crawls sitemap + discovers pages via internal links
- **Actionable** — shows fix snippets and "points if fixed" ROI
- **CI/CD ready** — `--ci --threshold 80` for automated quality gates
- **Agentize** — host any site as a live MCP server at `<slug>.mcp.w2agent.dev`
- **Meta MCP discovery** — Claude discovers 100+ agents via one endpoint

## Install & Use

### Audit, Generate, Integrate (no API key required)

```bash
# Audit a site's AI-readiness
npx w2agent audit https://example.com
npx w2agent audit https://example.com --depth 10 --verbose
npx w2agent audit https://example.com --ci --threshold 80  # CI gate

# Generate llms.txt + all AI-ready files
npx w2agent generate https://example.com
npx w2agent generate https://example.com --format llms-txt
npx w2agent generate https://example.com --max-pages 200 --output ./output/

# Generate platform-specific integration files
npx w2agent integrate https://example.com
npx w2agent integrate https://example.com --platform wordpress
npx w2agent integrate https://example.com --install        # install into project
```

### Agentize — hosted MCP on w2agent.dev

Host your site as a live MCP server (requires free API key):

```bash
npx w2agent login                             # one-time auth
npx w2agent agentize https://example.com      # deploys → example-com.mcp.w2agent.dev
npx w2agent agentize https://example.com --slug my-docs
```

Your MCP endpoint is live immediately. Add it to Claude Desktop:
```json
{
  "mcpServers": {
    "my-site": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://my-docs.mcp.w2agent.dev/mcp"]
    }
  }
}
```

### Self-host MCP (no API key, deploy to your own infra)

```bash
# Generate a deployable MCP server project
npx w2agent mcp deploy https://example.com --self-host vercel
npx w2agent mcp deploy https://example.com --self-host cf   # Cloudflare Workers

# Outputs a ready-to-deploy project in ./w2agent-output/
# vercel deploy ./w2agent-output/   or   wrangler deploy ./w2agent-output/
```

## Hosted vs Self-hosted

| | Hosted (`agentize`) | Self-hosted (`mcp deploy`) |
|---|---|---|
| **Setup** | `npx w2agent login` + one command | Generate + deploy to your infra |
| **Domain** | `<slug>.mcp.w2agent.dev` | Your domain |
| **Re-crawl** | Automatic (on-demand via dashboard) | Manual (`wrangler deploy` again) |
| **Directory listing** | Yes (opt-in) | No |
| **Auth required** | Free API key | None |
| **Best for** | Quick deploy, directory visibility | Custom domains, air-gapped, enterprise |

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
  -f, --format <format>    Output: llms-txt, full, markdown, robots-txt, schema-org, agent-card, faq, mcp-server, skill-md, webmcp, openclaw, all (default: all)
  -m, --max-pages <n>      Max pages to crawl (default: 100)
  -s, --sections <list>    Only include these URL sections (comma-separated)
  --from-audit             Run audit first, generate fixes for failed checks only
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

```
w2agent agentize <url> [options]

Options:
  --api-key <key>    API key (alternative to `w2agent login`)
  --slug <slug>      Custom slug (default: derived from domain)
```

```
w2agent mcp deploy <url> [options]

Options:
  --self-host <platform>   vercel | cf (Cloudflare Workers)
  -o, --output <dir>       Output directory (default: ./w2agent-output)
  -m, --max-pages <n>      Max pages to crawl (default: 50)
```

See [docs/GENERATE.md](docs/GENERATE.md) for detailed generation reference.

## Project Structure

```
packages/core     Audit engine, generators, MCP server builder, platform adapters
                  (published as w2agent-core)
packages/cli      CLI tool — audit, generate, integrate, agentize, mcp
                  (published as w2agent)
```

## Development

```bash
pnpm install
pnpm build          # Build all packages
pnpm test           # Unit tests
pnpm dev            # Dev mode (watch)

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
