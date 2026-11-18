[English](README.md) | [中文](README_CN.md)

# w2agent

**w2agent audits a website for AI-agent readiness and generates the files that make it discoverable by Claude, GPT, and other MCP-compatible tools** (llms.txt, agent-card.json, Schema.org JSON-LD, WebMCP, and more).

## Site owners: let your coding agent do it

Ask your coding agent:

> use w2agent to make my site agent-ready

It follows [docs/AGENT-PLAYBOOK.md](docs/AGENT-PLAYBOOK.md) (also packaged as the [w2agent skill](skills/w2agent/SKILL.md)). The flow it runs, pinned to `w2agent@0.1.0`:

```bash
npx w2agent@0.1.0 audit <local url> --json                 # baseline score (<local url> = your local server)
npx w2agent@0.1.0 integrate <local url> --dry-run --json \
  --project-dir . --site-url <production origin>            # plan, writes nothing
npx w2agent@0.1.0 integrate <local url> --install --json \
  --project-dir . --site-url <production origin>            # apply
# then: do the postInstallSteps, rebuild and restart the local server
npx w2agent@0.1.0 audit <local url> --json                 # re-audit
```

The agent shows the plan to the user before applying. Flags, JSON documents and exit codes: [docs/CLI-AGENT-MODE.md](docs/CLI-AGENT-MODE.md).

The agent checks `npm view w2agent@0.1.0 version` before the first `npx`. If npm answers 404: if a w2agent checkout is available locally (for example cloned next to the site), build it from source (`pnpm install && pnpm --filter w2agent... build`) and run `node <checkout>/packages/cli/dist/index.js`. Otherwise stop and tell the owner. Never try other package names.

Install the playbook for your agent:

```bash
npx skills add interskh/w2agent                       # any agent that supports skills
claude plugin marketplace add interskh/w2agent        # Claude Code
claude plugin install w2agent@w2agent
```

## What an audit looks like

```
  w2agent audit — AI Readiness Report
  ────────────────────────────────────

  URL: https://your-site.com
  Pages scanned: 12
  Platform: WordPress (95% confidence)
  Time: 4.2s

  Overall Score: 58/100 (C)

  Bot Accessibility        ████████░░  82/100
  Structured Data          ██████░░░░  64/100
  Content Quality          ████████░░  78/100
  Agent Discovery          ███░░░░░░░  35/100
  Agent Protocols          ██░░░░░░░░  22/100
  Technical Foundations    █████████░  91/100
  Auth & Access            ████░░░░░░  40/100

  Top Issues:
  ✗ No /.well-known/agent-card.json         (+4 points if fixed)
  ✗ No Schema.org JSON-LD on 8/12 pages     (+3 points if fixed)
  ✗ No llms.txt found                       (+2 points if fixed)
```

## Why w2agent?

Most websites are invisible to AI agents. Agents can't find your docs, hallucinate your pricing, and skip your site entirely — because there's no machine-readable contract between your content and the tools trying to use it. w2agent closes that gap.

| Without w2agent | With w2agent |
|----------------|-------------|
| Agents hallucinate your docs — trained on stale crawl data | `agentize` serves live content; agents always query the current site |
| No way to know you're agent-inaccessible until users complain | `audit` runs 57 checks in seconds and shows exactly what's blocking agents |
| AI can't find your menu, hours, or booking page | Structured data + `agentize` exposes them as queryable tools |

## The Pipeline

Turn any website into a queryable AI agent in four steps:

| Step | Command | What happens |
|------|---------|-------------|
| **1. Audit** | `npx w2agent@0.1.0 audit <url>` | Score AI-readiness across 57 checks (50 scored). Find what's blocking agents. |
| **2. Generate** | `npx w2agent@0.1.0 generate <url>` | Generate llms.txt, agent-card.json, schema-org.json, and more. |
| **3. Integrate** | `npx w2agent@0.1.0 integrate <url>` | Install platform-native files (WordPress plugin, Next.js middleware). |
| **4. Agentize (optional, hosted)** | `npx w2agent@0.1.0 agentize <url>` | Host the site as a live agent server at `<slug>.agent.w2agent.dev`. |

For a complete step-by-step methodology — site analysis, agent architecture decisions, output verification, and quality validation — see [AGENTIZE.md](docs/AGENTIZE.md).

## Features

| Without w2agent | With w2agent |
|----------------|-------------|
| Agents hallucinate your docs — trained on stale snapshots | `agentize` serves live content; agents always query the current site |
| No way to know you're agent-inaccessible until users complain | `audit` runs 57 checks in seconds and shows exactly what's blocking agents |
| Every platform needs different integration files | Auto-detected platform generates the right native files (WordPress plugin, Next.js middleware, Shopify Liquid) in one command |
| Writing llms.txt by hand is tedious and error-prone | `generate` produces llms.txt, agent-card.json, schema-org.json, and 7 more formats automatically |
| Deploying an agent server requires infrastructure setup | `npx w2agent@0.1.0 agentize` hosts your site as an agent server — no servers to manage |
| CI/CD pipelines can't gate on AI-readiness | `--ci --threshold 80` returns exit code 1 when scores drop — blocks the build |
| AI frameworks expect different formats (llms.txt, OpenClaw, WebMCP, Skill.md) | 10 output formats from one crawl — generate all or just what you need |

## Install & Use

### Audit, Generate, Integrate (no API key required)

```bash
# Audit a site's AI-readiness
npx w2agent@0.1.0 audit https://example.com
npx w2agent@0.1.0 audit https://example.com --depth 10 --verbose
npx w2agent@0.1.0 audit https://example.com --ci --threshold 80  # CI gate

# Generate llms.txt + all AI-ready files
npx w2agent@0.1.0 generate https://example.com
npx w2agent@0.1.0 generate https://example.com --format llms-txt
npx w2agent@0.1.0 generate https://example.com --max-pages 200 --output ./output/

# Generate platform-specific integration files
npx w2agent@0.1.0 integrate https://example.com
npx w2agent@0.1.0 integrate https://example.com --platform wordpress
npx w2agent@0.1.0 integrate https://example.com --install        # install into project
```

### Agentize (optional) — hosted agent on w2agent.dev

Host your site as a live agent server (requires free API key):

```bash
npx w2agent@0.1.0 login                             # one-time auth
npx w2agent@0.1.0 agentize https://example.com      # deploys → example-com.agent.w2agent.dev
npx w2agent@0.1.0 agentize https://example.com --slug my-docs
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
npx w2agent@0.1.0 agent deploy https://example.com --self-host vercel
npx w2agent@0.1.0 agent deploy https://example.com --self-host cf   # Cloudflare Workers

# Outputs a project in ./w2agent-output/mcp-server/ (see its README.md)
cd w2agent-output/mcp-server && npm install
# Vercel:  npx vercel --prod
# Cloudflare: npx wrangler kv namespace create MCP_DATA   # put the id in wrangler.toml
#             bash setup.sh && npx wrangler deploy
```

## Hosted vs Self-hosted

| | Hosted (`agentize`) | Self-hosted (`mcp deploy`) |
|---|---|---|
| **Setup** | `npx w2agent@0.1.0 login` + one command | Generate + deploy to your infra |
| **Domain** | `<slug>.agent.w2agent.dev` | Your domain |
| **Re-crawl** | Automatic (on-demand via dashboard) | Manual (regenerate; on Cloudflare set the same KV namespace id in the rewritten `wrangler.toml`, rerun `bash setup.sh`, then deploy) |
| **Directory listing** | Yes (opt-in) | No |
| **Auth required** | Free API key | None |
| **Best for** | Quick deploy, directory visibility | Custom domains, air-gapped, enterprise |

## Optional: hosted agents with `agentize`

Everything below is optional. `agentize` hosts a site as a live agent server on w2agent.dev. It needs `npx w2agent@0.1.0 login` and is not part of the local flow above.

### The Agent Network

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

### When to Agentize

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

## Platform Adapters

w2agent auto-detects your platform and generates native integration code:

| Platform | Detection | Integration Generated | Tested |
|----------|-----------|----------------------|--------|
| **WordPress** | Generator meta, same-host wp-content assets, REST API link | PHP plugin with dynamic llms.txt from WP database, admin page, robots.txt filter | Syntax + structure |
| **Next.js** | `__NEXT_DATA__`, `_next/static` | Route handlers with ISR, middleware for content negotiation, build script | Build + live audit |
| **Nuxt** | `__NUXT`, Nuxt meta tags | Nitro server routes, auto-imported middleware | Build + live audit |
| **Astro** | Generator meta, astro assets | Static files + middleware for content negotiation | Build + live audit |
| **Shopify** | cdn.shopify.com, Shopify headers | Liquid snippets, robots.txt additions, Product JSON-LD when the theme lacks it · experimental, unreleased Shopify App (`packages/shopify-app`, App Proxy) | Syntax + structure |
| **Docusaurus** | Generator meta, html class | Build plugin that generates llms.txt from the built docs content (serves an existing `static/llms.txt` as is unless `overwrite: true`) | Build + live audit |

Platform-specific checks run automatically during audit:

- **WordPress** (4 checks): REST API, security plugin blocking, robots.txt AI rules, page builder markup
- **Next.js** (3 checks): .well-known serving, static generation, metadata API usage
- **Nuxt** (4 checks): SEO module, LLMs module, Schema.org coverage, SSR rendering
- **Astro** (3 checks): sitemap integration, robots.txt AI access, rendering mode
- **Shopify** (3 checks): robots.txt customization, product schema, theme app blocks
- **Docusaurus** (2 checks): sidebar coverage, versioned docs discovery

## Scoring

Rubric 3.2: 57 checks in seven weighted categories. 50 are scored; 7 are tracked (reported with weight 0, never scored). A detected `ecommerce` or `local-business` site adds 3 site-type checks, and a detected platform adds its checks above.

| Category | Weight | What it measures |
|----------|--------|-----------------|
| **Bot Accessibility** | 15% | Can AI crawlers reach your content? (robots.txt agent access, sitemap, response time) |
| **Structured Data** | 15% | Is content machine-readable? (Schema.org, OpenGraph, semantic HTML) |
| **Content Quality** | 15% | Is content optimized for AI? (token efficiency, citations, freshness) |
| **Agent Discovery** | 12% | Can agents find your capabilities? (llms.txt, agent cards, markdown alternates) |
| **Agent Protocols** | 13% | Does the site support agent standards? (MCP, UCP, action schemas, reachability under agent user-agents) |
| **Technical Foundations** | 10% | Basics: HTTPS, security headers, canonical URLs, no-JS content |
| **Auth & Access** | 20% | Can agents authenticate? (public API, OpenAPI, OAuth discovery, PKCE, MCP auth) |

A check that is not applicable (`skip`) or could not be measured (`error`) is left out of its category score, and a category with no remaining checks is left out of the overall score, with the other weights re-normalized.

**Grades** (on the unrounded score): A ≥ 75 · B ≥ 60 · C ≥ 45 · D ≥ 30 · F < 30. The printed score is rounded, so 74.6 shows as `75/100 (B)`.

**When a site can't be scored**, `audit` names the reason instead of scoring an error page: `unreachable`, `blocked` (a fingerprinted anti-bot challenge, vendor named), `auth_gated`, `rate_limited`, `timeout` or `unknown_failure`. It exits non-zero and, when the agent user-agent probe ran, prints one line on how the documented agent user-agents were answered on the same homepage.

See [docs/CHECKS.md](docs/CHECKS.md) for the full check reference and [docs/RUBRIC-CHANGELOG.md](docs/RUBRIC-CHANGELOG.md) for what changed between rubric versions.

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
  --json                   One JSON document on stdout (report or error envelope)
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
  --install                Install files directly into your project
  --project-dir <dir>      Project root for --install (default: .)
  --dry-run                Show what --install would do; never writes files
  --site-url <url>         Production origin to write into generated content when crawling another origin (e.g. localhost)
  --json                   One JSON document on stdout (result or error envelope)
```

```
w2agent agentize <url> [options]

Options:
  --api-key <key>    API key (alternative to `w2agent login`)
  --slug <slug>      Custom slug (default: derived from domain)
```

```
w2agent guide <guide-id> [options]

Options:
  -p, --platform <platform>  Add the framework section: wordpress, nextjs, shopify, docusaurus, nuxt, astro
  --json                     One JSON document on stdout (the guide, or an error envelope)
```

```
w2agent login [options]

Options:
  --api-key <key>    Authenticate with an API key (required in agent and non-interactive environments)
  --force            Re-authenticate even if already logged in
  --json             One JSON document on stdout (result or error envelope)
```

```
w2agent schema      Print all commands and options as JSON
```

Exit codes for `audit`, `integrate`, `guide`, `login` and `schema`: 0 success, 1 operational error (including `--ci` below threshold), 2 usage error. See [docs/CLI-AGENT-MODE.md](docs/CLI-AGENT-MODE.md) for the `--json` contract.

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
packages/cli      CLI tool — audit, generate, integrate, guide, agentize, mcp
                  (published as w2agent)
packages/nuxt      Installable Nuxt module — auto-serves llms.txt, agent-card.json, webhook
                   (published as @w2agent/nuxt)
packages/docusaurus  Installable Docusaurus plugin — generates llms.txt at build time from the built docs content
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
  - run: npx w2agent@0.1.0 audit ${{ vars.SITE_URL }} --ci --threshold 80
```

## License

MIT
