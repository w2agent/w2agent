[English](README.md) | [中文](README_CN.md)

# w2agent

**Every website is already an agent.** w2agent audits, generates, and deploys
any website as a live agent server — discoverable and queryable by Claude, GPT,
and any MCP-compatible AI tool.

<!-- gif: cli-audit — terminal running `npx w2agent audit https://stripe.com`, score output scrolling in -->

```bash
npx w2agent audit https://your-site.com     # score it
npx w2agent agentize https://your-site.com  # deploy it as an agent server
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

## Why w2agent?

Most websites are invisible to AI agents. Agents can't find your docs, hallucinate your pricing, and skip your site entirely — because there's no machine-readable contract between your content and the tools trying to use it. w2agent closes that gap.

| Without w2agent | With w2agent |
|----------------|-------------|
| Agents hallucinate your docs — trained on stale crawl data | `agentize` serves live content; agents always query the current site |
| No way to know you're agent-inaccessible until users complain | `audit` scores 60 checks in seconds and shows exactly what's blocking agents |
| AI can't find your menu, hours, or booking page | Structured data + `agentize` exposes them as queryable tools |

## The Pipeline

Turn any website into a queryable AI agent in four steps:

| Step | Command | What happens |
|------|---------|-------------|
| **1. Audit** | `npx w2agent audit <url>` | Score AI-readiness across 47+ checks. Find what's blocking agents. |
| **2. Generate** | `npx w2agent generate <url>` | Generate llms.txt, agent-card.json, schema-org.json, and more. |
| **3. Integrate** | `npx w2agent integrate <url>` | Install platform-native files (WordPress plugin, Next.js middleware). |
| **4. Agentize** | `npx w2agent agentize <url>` | Host the site as a live agent server at `<slug>.agent.w2agent.dev`. |

For a complete step-by-step methodology — site analysis, agent architecture decisions, output verification, and quality validation — see [AGENTIZE.md](AGENTIZE.md).

## The Agent Network

Every agentized site joins a shared network — discoverable via the
[w2agent directory](https://w2agent.dev/directory) and the **Meta Agent** discovery
server.

<!-- gif: meta-agent-discovery — Claude Desktop showing `search_websites` tool call, returning a list of 5 dev-tool agents -->

**Use any agent in Claude Desktop** by adding the Meta Agent endpoint:

```json
{
  "mcpServers": {
    "w2agent-meta": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://agent.w2agent.dev"]
    }
  }
}
```

Once connected, Claude can discover and query any of the 100+ sites in the directory:

> "I'm building a SaaS app. What agents do you have for Next.js, Supabase, and Stripe?"

<!-- gif: env-synthesis — Claude synthesizing a .env.example from 3 different site-agents in one response -->

**Individual agents** are accessible directly:
- Hosted: `https://<slug>.agent.w2agent.dev`
- Self-hosted: deploy the generated agent server to Vercel or Cloudflare Workers

A sample of 18 agentized sites across 6 categories (March 2026):

| Site | Category | Tools | Knowledge Pages | Score |
|------|----------|-------|----------------|-------|
| [vercel.com](https://w2agent.dev/sites/vercel-com) | Dev Tools | 3 | 1,999 | B 63 |
| [sentry.io](https://w2agent.dev/sites/sentry-io) | Dev Tools | 3 | 50 | B 62 |
| [linear.app](https://w2agent.dev/sites/linear-app) | Dev Tools | 3 | 805 | B 60 |
| [launchdarkly.com](https://w2agent.dev/sites/launchdarkly-com) | Dev Tools | 3 | 67 | B 63 |
| [heroku.com](https://w2agent.dev/sites/heroku-com) | SaaS | 3 | 36 | B 73 |
| [twilio.com](https://w2agent.dev/sites/twilio-com) | SaaS | 4 | 128 | B 69 |
| [plaid.com](https://w2agent.dev/sites/plaid-com) | SaaS | 3 | 1,085 | B 68 |
| [mailchimp.com](https://w2agent.dev/sites/mailchimp-com) | SaaS | 4 | 82 | B 69 |
| [nextjs.org](https://w2agent.dev/sites/nextjs-org) | Docs | 3 | 612 | B 64 |
| [nuxt.com](https://w2agent.dev/sites/nuxt-com) | Docs | 3 | 291 | C 52 |
| [fastapi.tiangolo.com](https://w2agent.dev/sites/fastapi-tiangolo-com) | Docs | 3 | 153 | C 53 |
| [kotlinlang.org](https://w2agent.dev/sites/kotlinlang-org) | Docs | 3 | 439 | B 62 |
| [ikea.com](https://w2agent.dev/sites/ikea-com) | E-commerce | 4 | 142 | C 58 |
| [zappos.com](https://w2agent.dev/sites/zappos-com) | E-commerce | 4 | 62 | C 50 |
| [bbc.com](https://w2agent.dev/sites/bbc-com) | Content | 4 | 189 | C 52 |
| [techcrunch.com](https://w2agent.dev/sites/techcrunch-com) | Content | 4 | 128 | C 51 |
| [panerabread.com](https://w2agent.dev/sites/panerabread-com) | Local Biz | 3 | 17 | C 52 |
| [subway.com](https://w2agent.dev/sites/subway-com) | Local Biz | 3 | 72 | C 48 |

_Standard tools: `list-pages`, `get-page`, `search-site`. Sites with native search add `site-search` (shown as 4 tools)._

[Browse the directory →](https://w2agent.dev/directory)

## When to Agentize

w2agent works for any public website. If a human can browse it, an agent can use it.

| Category | Example Sites | What agents unlock |
|---|---|---|
| Developer Tools | vercel.com, sentry.io, linear.app, launchdarkly.com | Answer setup questions, fetch changelogs, search issues |
| SaaS Platforms | hubspot.com, mailchimp.com, asana.com, zendesk.com | Look up pricing, query help docs, navigate feature flags |
| Documentation | nextjs.org, kotlinlang.org, nuxt.com, fastapi.tiangolo.com | Answer API questions, fetch code examples, resolve versions |
| E-commerce | ikea.com, amazon.com, target.com, zappos.com | Check availability, compare specs, find return policies |
| Restaurants & Food | starbucks.com, mcdonalds.com, chipotle.com | Get menus, hours, nutritional info, find locations |
| News & Media | bbc.com, techcrunch.com, arstechnica.com | Summarize coverage, search archives, pull headlines |
| Travel & Hospitality | marriott.com, hilton.com | Fetch amenities, policies, availability by property |
| Healthcare | webmd.com, zocdoc.com | Find providers, explain conditions, surface clinic hours |
| Real Estate | zillow.com, redfin.com | Pull listings, neighborhood stats, estimate details |
| Finance & Fintech | plaid.com, twilio.com, gusto.com | Answer API docs questions, explain pricing, navigate guides |
| Nonprofits | habitat.org, charitywater.org, doctorswithoutborders.org | Describe programs, locate offices, explain donation impact |
| Local Services | angi.com, thumbtack.com | Find providers by category, surface reviews, get quotes |

## Features

| Without w2agent | With w2agent |
|----------------|-------------|
| Agents hallucinate your docs — trained on stale snapshots | `agentize` serves live content; agents always query the current site |
| No way to know you're agent-inaccessible until users complain | `audit` scores 60 checks in seconds and shows exactly what's blocking agents |
| Every platform needs different integration files | Auto-detected platform generates the right native files (WordPress plugin, Next.js middleware, Shopify Liquid) in one command |
| Writing llms.txt by hand is tedious and error-prone | `generate` produces llms.txt, agent-card.json, schema-org.json, and 7 more formats automatically |
| Deploying an agent server requires infrastructure setup | `npx w2agent agentize` hosts your site as an agent server — no servers to manage |
| CI/CD pipelines can't gate on AI-readiness | `--ci --threshold 80` returns exit code 1 when scores drop — blocks the build |
| AI frameworks expect different formats (llms.txt, OpenClaw, WebMCP, Skill.md) | 10 output formats from one crawl — generate all or just what you need |

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

### Agentize — hosted agent on w2agent.dev

Host your site as a live agent server (requires free API key):

```bash
npx w2agent login                             # one-time auth
npx w2agent agentize https://example.com      # deploys → example-com.agent.w2agent.dev
npx w2agent agentize https://example.com --slug my-docs
```

Your agent endpoint is live immediately. Add it to Claude Desktop:
```json
{
  "mcpServers": {
    "my-site": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://my-docs.agent.w2agent.dev"]
    }
  }
}
```

### Self-host agent server (no API key, deploy to your own infra)

```bash
# Generate a deployable MCP server project
npx w2agent agent deploy https://example.com --self-host vercel
npx w2agent agent deploy https://example.com --self-host cf   # Cloudflare Workers

# Outputs a ready-to-deploy project in ./w2agent-output/
# vercel deploy ./w2agent-output/   or   wrangler deploy ./w2agent-output/
```

## Hosted vs Self-hosted

| | Hosted (`agentize`) | Self-hosted (`mcp deploy`) |
|---|---|---|
| **Setup** | `npx w2agent login` + one command | Generate + deploy to your infra |
| **Domain** | `<slug>.agent.w2agent.dev` | Your domain |
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
| **Shopify** | cdn.shopify.com, Shopify headers | Liquid snippets, robots.txt.liquid, Product JSON-LD · **Shopify App** (`packages/shopify-app`) with OAuth + App Proxy | Syntax + structure |
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
  --a2a-endpoint <url>     Live A2A agent endpoint (agent-card is skipped without it)
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
  --a2a-endpoint <url>     Live A2A agent endpoint (no agent card is integrated without it)
```

```
w2agent agentize <url> [options]

Options:
  --api-key <key>    API key (alternative to `w2agent login`)
  --slug <slug>      Custom slug (default: derived from domain)
```

```
w2agent agent deploy <url> [options]

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
packages/nuxt      Installable Nuxt module — auto-serves llms.txt, agent-card.json, webhook
                   (published as @w2agent/nuxt)
packages/docusaurus  Installable Docusaurus plugin — generates llms.txt at build time from docs/
                     (published as @w2agent/docusaurus)
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
