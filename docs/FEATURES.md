# w2agent — Feature Specification

> Full categorized feature list across 10 categories + 8 website-type modules

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Platform Adapters (WordPress, Shopify, Next.js...) │
├─────────────────────────────────────────────────────┤
│  Website-Type Modules (commerce, docs, local...)    │
├─────────────────────────────────────────────────────┤
│  Feature Modules (chat, ads, GEO, analytics...)     │
├─────────────────────────────────────────────────────┤
│  Agent Discovery Layer (agent cards, registries)    │
├─────────────────────────────────────────────────────┤
│  Core Engine (crawl, convert, serve)                │
└─────────────────────────────────────────────────────┘
```

---

## 1. CORE — Content Conversion & Serving

| # | Feature | Description |
|---|---------|-------------|
| 1.1 | **HTML → Markdown conversion** | Clean markdown from any page, stripping nav/footer/ads. Boilerplate removal via heuristics + optional LLM | ✅ Shipped |
| 1.2 | **llms.txt generation** | Auto-generate `/llms.txt` — structured index of site's key pages with descriptions | ✅ Shipped |
| 1.3 | **llms-full.txt generation** | Auto-generate `/llms-full.txt` — full site content in single markdown file | ✅ Shipped |
| 1.4 | **Content negotiation** | Detect AI user-agents or `Accept: text/markdown` header and serve markdown instead of HTML |
| 1.5 | **Incremental updates** | Watch for site changes, regenerate only affected markdown/llms.txt sections |
| 1.6 | **Versioned content** | Serve different llms.txt per version (e.g., `/v2/llms.txt`) for docs sites |
| 1.7 | **Content chunking** | Break content into self-contained 75-300 word chunks optimized for RAG retrieval |
| 1.8 | **Media handling** | Extract alt text, captions, transcripts for images/video/audio |
| 1.9 | **Table preservation** | Convert complex HTML tables to markdown tables or structured JSON |
| 1.10 | **Code block extraction** | Identify and properly format code samples with language tags |
| 1.11 | **`<link rel="alternate" type="text/markdown">` tags** | Auto-discovery tags so agents know markdown is available at each URL |

---

## 2. AGENT DISCOVERY — Making Sites Findable by Agents

Agents use 5 discovery mechanisms: search APIs, .well-known endpoints, MCP registries, direct configuration, and crawling. Sites need to support all of them.

| # | Feature | Description |
|---|---------|-------------|
| 2.1 | **A2A Agent Card** | Generate `/.well-known/agent-card.json` — declares site's agent capabilities, skills, auth methods per Google's A2A spec |
| 2.2 | **agents.json** | Generate `/.well-known/agents.json` — describes multi-step API flows (Wildcard spec) |
| 2.3 | **ARA manifest** | Generate Agent-Ready Architecture manifest — identity, content maps, action schemas, policies |
| 2.4 | **MCP registry publishing** | Publish site's MCP server to registries (official MCP registry, Smithery, Glama, GitHub) |
| 2.5 | **Agent SEO** | Optimize for agent discovery: clean HTML, schema.org, llms.txt, fast response times, accessible robots.txt |
| 2.6 | **Agent sitemap** | Machine-readable map of all agent-accessible endpoints, tools, and content — like sitemap.xml but for agents |
| 2.7 | **Search API optimization** | Ensure site content is indexed by Brave Search API and other agent-facing search indexes |
| 2.8 | **Discovery health check** | Verify all discovery endpoints are accessible, valid, and up to date |

---

## 3. AGENT INTERFACE — Making Sites Actionable

| # | Feature | Description |
|---|---------|-------------|
| 3.1 | **MCP server generation** | Auto-generate agent server from site's API/forms/actions. Streamable HTTP transport. Standalone, Vercel, and Cloudflare Workers templates. Hosted at `<slug>.agent.w2agent.dev` with webhook re-crawl. | ✅ Shipped |
| 3.2 | **SKILL.md generation** | Generate SKILL.md files from site capabilities for coding agent discovery | ✅ Shipped |
| 3.3 | **OpenAPI → agent actions** | Convert existing OpenAPI specs to MCP tools, GPT Actions, and agents.json flows |
| 3.4 | **Form → tool conversion** | Detect HTML forms and convert them to structured agent-callable MCP tools |
| 3.5 | **Action consequence signaling** | Metadata on each action: reversible/irreversible, cost, side effects |
| 3.6 | **Permission scoping** | Granular agent permissions: read-only, write with approval, full autonomy |
| 3.7 | **Rate limiting config** | Configurable rate limits per agent, with tiered access levels |
| 3.8 | **Agent-to-agent delegation** | Site's MCP server can act as a sub-agent (e.g., restaurant booking agent called by travel planner) |
| 3.9 | **Webhook/push notifications** | Agents can subscribe to events (price drops, availability changes, content updates) |

---

## 4. CHAT — Conversational Interface

| # | Feature | Description |
|---|---------|-------------|
| 4.1 | **Chat with website** | Embeddable chat widget powered by site's content (RAG-based) | ✅ Shipped |
| 4.2 | **Vector index builder** | Build and maintain vector embeddings of site content for retrieval |
| 4.3 | **Multi-model support** | Plug in OpenAI, Claude, Gemini, Ollama, or any OpenAI-compatible API |
| 4.4 | **Source citation** | Every chat response cites specific pages/sections from the site |
| 4.5 | **Conversation context** | Maintain conversation history, handle follow-up questions |
| 4.6 | **Custom system prompts** | Site owners define personality, scope, and guardrails |
| 4.7 | **Handoff to human** | Escalation path when chat can't answer |
| 4.8 | **Multi-language chat** | Respond in user's language regardless of content language |
| 4.9 | **Widget customization** | Theming, placement, trigger conditions, mobile responsive |
| 4.10 | **Chat analytics** | Track questions asked, satisfaction, gaps in content coverage |

---

## 5. GEO — Generative Engine Optimization

| # | Feature | Description |
|---|---------|-------------|
| 5.1 | **AI readiness audit** | "Lighthouse for AI" — score a site's agent-readiness across all dimensions |
| 5.2 | **Schema.org injection** | Auto-detect content type and inject appropriate JSON-LD (FAQPage, HowTo, Article, Product, LocalBusiness, Person) |
| 5.3 | **Content restructuring suggestions** | Analyze pages and suggest answer-first format, chunking, FAQ extraction |
| 5.4 | **Citation optimization** | Suggest authoritative citations, statistics, expert quotes |
| 5.5 | **FAQ extraction** | Auto-extract Q&A pairs from content for FAQPage schema and llms.txt |
| 5.6 | **AI crawler access check** | Verify robots.txt isn't blocking GPTBot, ClaudeBot, PerplexityBot, etc. |
| 5.7 | **Speakable markup** | Add Speakable schema for voice/audio extraction |
| 5.8 | **Content freshness signals** | Add dateModified, update frequency metadata |
| 5.9 | **Entity markup** | Mark up named entities for knowledge graph inclusion |
| 5.10 | **Competitor visibility comparison** | Compare AI visibility against competitors across ChatGPT, Perplexity, Gemini |

---

## 6. MONETIZATION — LLM Ads & Agent Commerce

| # | Feature | Description |
|---|---------|-------------|
| 6.1 | **Pay-per-crawl (HTTP 402)** | Self-hosted pay-per-crawl with price negotiation headers (Cloudflare-compatible protocol) |
| 6.2 | **Tiered access control** | Free tier (summary), paid tier (full content), premium tier (structured data + API) |
| 6.3 | **LLM ads — site-owned** | Serve sponsored content in agent-consumable format via `bazaar_content` pattern, clearly labeled |
| 6.4 | **LLM ads — network** | Integration with emerging ad networks (AdCP, Koah, Aryel) for site owners to earn from agent traffic |
| 6.5 | **adagents.json** | Generate AdCP-compatible `/.well-known/adagents.json` for programmatic ad discovery |
| 6.6 | **Agent commerce (UCP)** | Generate `/.well-known/ucp` manifest for product discovery → checkout (Google/Shopify protocol) |
| 6.7 | **Agent commerce (ACP)** | Generate ACP product feeds (.jsonl.gz) + checkout endpoints (OpenAI/Stripe protocol) |
| 6.8 | **Content licensing manifest** | Machine-readable terms: what's free, what requires licensing, pricing tiers |
| 6.9 | **Attribution tracking** | Track when AI models cite your content, which pages get cited, sentiment |
| 6.10 | **Agent wallet integration** | Support AP2, Visa Trusted Agent Protocol, Mastercard Agent Pay |
| 6.11 | **Revenue dashboard** | Track AI-sourced revenue: pay-per-crawl, ad impressions, commerce transactions |
| 6.12 | **Dynamic pricing** | Price content by freshness, exclusivity, content type, bot identity |

---

## 7. GEO-LOCATION — Locale-Aware Agent Serving

| # | Feature | Description |
|---|---------|-------------|
| 7.1 | **Locale-aware content serving** | Serve localized llms.txt / markdown based on agent's locale hints |
| 7.2 | **hreflang for AI** | Map existing hreflang setup to locale-specific llms.txt variants |
| 7.3 | **Local business structured data** | NAP, hours, menus, services, booking links in JSON-LD LocalBusiness |
| 7.4 | **Multi-language llms.txt** | Generate per-language llms.txt (e.g., `/fr/llms.txt`, `/de/llms.txt`) |
| 7.5 | **Geo-specific pricing** | Surface locale-appropriate pricing, currency, tax info |
| 7.6 | **Local authority signals** | Embed local citations, directory references for GEO credibility |
| 7.7 | **Region-specific compliance** | Flag content that varies by jurisdiction (GDPR, CCPA) |

---

## 8. ANALYTICS & MONITORING

| # | Feature | Description |
|---|---------|-------------|
| 8.1 | **AI bot traffic dashboard** | Track visits from 56+ AI bots (server-side, not JS-based) |
| 8.2 | **Content extraction tracking** | Monitor which pages AI bots hit, frequency, depth of crawl |
| 8.3 | **AI mention monitoring** | Track how your site/brand appears in AI-generated answers |
| 8.4 | **Citation rate tracking** | Measure citation frequency, sentiment, share of voice |
| 8.5 | **Agent interaction logs** | Log all MCP/chat agent interactions, queryable for insights |
| 8.6 | **Alerting** | Alerts for unusual bot traffic spikes, new AI crawlers, extraction patterns |
| 8.7 | **Health checks** | Continuous monitoring that llms.txt, MCP server, schema markup are valid |
| 8.8 | **Agent journey tracking** | Track the browse→evaluate→authenticate→transact journey (87%/7%/4%/2% split) |

---

## 9. ACCESS CONTROL & SECURITY

| # | Feature | Description |
|---|---------|-------------|
| 9.1 | **AI-specific robots.txt** | Generate/manage AI bot directives separately from regular crawlers |
| 9.2 | **Agent authentication** | OAuth 2.1 / API key verification before granting access to premium content/actions |
| 9.3 | **Scoped API keys** | Issue agent-specific keys with permission boundaries |
| 9.4 | **Content usage policies** | Machine-readable policy: allow/deny training, inference, citation requirements |
| 9.5 | **Action audit trail** | Immutable log of all agent actions (purchases, form submissions, data access) |
| 9.6 | **Bot fingerprinting** | Distinguish legitimate AI agents from scrapers spoofing AI bot user-agents |
| 9.7 | **Consent management** | For regulated industries: capture and verify agent-mediated consent |
| 9.8 | **NIST trust level declaration** | Declare agent trust requirements (Level 0-3 per NIST framework) |

---

## 10. DEVELOPER EXPERIENCE & PLATFORM ADAPTERS

| # | Feature | Description |
|---|---------|-------------|
| 10.1 | **CLI tool** | `w2agent init`, `w2agent generate`, `w2agent serve`, `w2agent audit`, `w2agent integrate` | ✅ audit + generate + integrate shipped |
| 10.2 | **Config file** | `w2agent.config.yaml` — define site type, modules, credentials, customization |
| 10.3 | **Plugin system** | Extensible architecture for custom site types, output formats, integrations |
| 10.4 | **CI/CD integration** | GitHub Actions / GitLab CI to regenerate agent assets on deploy |
| 10.5 | **Docker image** | Self-contained server with MCP endpoint, chat API, llms.txt serving |
| 10.6 | **Hosted option** | `w2agent.dev` — paste URL, get agent-ready assets (freemium SaaS) |
| 10.7 | **Playground / preview** | Test how AI agents see your site before deploying changes |
| 10.8 | **SDK** | Python + TypeScript libraries for programmatic use |

---

## WEBSITE-TYPE MODULES

Each module pre-configures the right mix of features for a specific site type.

### E-Commerce Module
- Product catalog → structured data (Product schema + Offers)
- UCP manifest at `/.well-known/ucp` (Google/Shopify protocol)
- ACP product feeds as `.jsonl.gz` (OpenAI/Stripe protocol)
- Agent checkout flow via MCP tools
- Inventory/pricing real-time feeds
- Review aggregation for AI consumption
- Comparison-optimized product tables
- Shopping agent optimization: structured data fields, valid GTINs, solution-oriented descriptions
- Agent journey optimization: browse (87%) → evaluate → authenticate (4%) → checkout (2%)
- **E-commerce audit checks** ✅ Shipped — 3 checks run automatically when e-commerce site detected:
  - `ecommerce-product-schema`: % of product pages with complete Product JSON-LD (name + price + availability)
  - `ecommerce-gtin-valid`: GS1 check digit validation for products with GTIN fields (skips sites without GTINs)
  - `ecommerce-checkout-accessible`: verifies cart/checkout URLs are not blocked by robots.txt

### Documentation Module
- API reference → llms.txt with endpoint summaries
- OpenAPI spec → MCP server + agents.json flows
- Versioned llms.txt per doc version
- Code sample extraction with language tags
- Tutorial → SKILL.md conversion
- Changelog/deprecation signals
- Coding agent optimization: raw markdown, API examples, build steps

### Local Business Module
- **Detection**: Implemented (confidence-scored heuristics: LocalBusiness JSON-LD, booking embeds, NAP microdata, map embeds, business hours, menu/services URLs, phone links)
- **Generators**: Implemented — LocalBusiness + Speakable JSON-LD, business-info.md table, MCP tools: `get-hours`, `get-menu`, `get-services`, `book-appointment`
- **Audit checks**: Implemented ✅ — 3 checks run automatically when local-business site detected:
  - `local-business-nap-structured`: % of NAP fields (name/address/phone) present in structured markup (JSON-LD or microdata)
  - `local-business-hours-jsonld`: validates `openingHoursSpecification` present in LocalBusiness JSON-LD
  - `local-business-booking-accessible`: verifies booking links/iframes are not blocked by robots.txt
- NAP + hours + services → LocalBusiness JSON-LD
- Menu/services → structured data
- Booking/reservation → MCP tool (agent-callable)
- Reviews aggregation
- Speakable schema for voice assistant discovery
- "Near me" optimization
- Multi-location support
- Personal assistant optimization: 75% of voice searches have local intent

### Content/Media Module
- Article extraction with byline, dates, categories
- Pay-per-crawl setup (HTTP 402)
- Content licensing manifest
- Citation requirement metadata
- Paywall-aware serving (teaser for free agents, full for paid)
- Author authority markup (Person schema)
- AdCP adagents.json for ad network discovery
- Research agent optimization: clean text, clear attribution, structured data

### SaaS/App Module
- API → MCP server generation (Streamable HTTP)
- Form → MCP tool conversion
- Action schemas with consequences
- OAuth 2.1 flow for agent access
- Webhook registration for agent notifications
- Usage/billing awareness
- Autonomous agent optimization: API endpoints > UI, programmatic auth, predictable URL patterns

### Portfolio/Personal Module
- Person schema with skills, experience, work samples
- "Available for hire" signals
- Contact/booking MCP tool
- Social proof aggregation (GitHub stats, testimonials)
- Skills → SKILL.md format
- Agent optimization: personal sites are least structured — biggest gap

### Community/Forum Module
- Q&A extraction → FAQ schema
- Answer quality scoring metadata
- Topic taxonomy → structured navigation
- User reputation signals
- Best answer highlighting
- Pay-per-crawl for sustainable community funding
- Agent optimization: Q&A format is most citation-friendly content format

### Government/Institutional Module
- Service directory → structured data
- Form inventory → agent-callable MCP tools
- Regulation/policy → chunked, cited markdown
- Accessibility-first (WCAG 2.1 AA — mandated by ADA Title II, deadline April 2026)
- Multi-language mandate support
- Consent management for agent-mediated interactions

---

## PLATFORM ADAPTERS

| Platform | Delivery | Integration Tests | Notes | Status |
|----------|----------|-------------------|-------|--------|
| **Any website** | CLI tool | — | Universal. Crawls URL, generates assets. | Shipped |
| **WordPress** | Plugin | Syntax validation, endpoint verification | Dynamic llms.txt from WP database, admin page, robots.txt filter, auto-detection. | Shipped |
| **Next.js** | Route handlers + middleware | Full build + live audit (llms.txt, agent-card, content negotiation) | ISR route handlers, content negotiation middleware, build script for CI/CD. | Shipped |
| **Nuxt** | Server routes + middleware | Full build + live audit (llms.txt, agent-card) | Nitro server routes, auto-imported middleware. | Shipped |
| **Astro** | Static files + middleware | Full build + live audit (llms.txt, agent-card, response time) | Static output or SSR middleware for content negotiation. | Shipped |
| **Shopify** | Liquid snippets | Syntax validation, structure verification | Liquid head snippet (`/llms.txt` link; Product JSON-LD via Shopify's `structured_data` only when the crawl shows the theme lacks it), robots.txt additions, auto-detection. | Shipped |
| **Docusaurus** | Build plugin | Full build + live audit (llms.txt, agent-card) | Build-time llms.txt generation from the built docs content (an existing `static/llms.txt` is served as is unless `overwrite: true`), auto-detection. | Shipped |
| **Webflow** | App or proxy | — | Content negotiation at same URLs, structured data injection. | |
| **Universal proxy** | Reverse proxy | — | Caddy/Nginx plugin or standalone binary. Any origin. Self-hostable. | |
| **CDN edge** | Worker/middleware | — | Cloudflare Worker or Vercel Edge. Zero infrastructure. | |

### Integration Test Coverage

Every shipped platform adapter is verified by integration tests that:

1. Generate integration files via `generateIntegration()`
2. Inject them into a minimal real project fixture
3. Build the project (JS platforms) or validate syntax (PHP/Liquid)
4. Start a preview server and run `runAudit()` against localhost
5. Assert that discovery endpoints (`/llms.txt`, `/.well-known/agent-card.json`) are served correctly

Negative tests also verify the audit catches real problems (missing llms.txt, invalid content, malformed agent-card).

See [CONTRIBUTING.md](../CONTRIBUTING.md) for details on running and extending integration tests.

---

## PRIORITIZATION: MVP → V1 → V2

### MVP — "Lighthouse for AI + llms.txt Generator"

1. CLI tool (`w2agent init`, `w2agent generate`, `w2agent audit`)
2. HTML → clean markdown conversion (heuristic boilerplate removal)
3. llms.txt + llms-full.txt generation (from crawled content)
4. AI readiness audit ("Lighthouse for AI" scoring)
5. Schema.org JSON-LD injection (auto-detect content type)
6. AI-specific robots.txt management (check/generate bot directives)
7. Basic AI bot traffic tracking (server log analysis for 56+ bots)
8. Config file (`w2agent.config.yaml`)

**Delivery**: CLI tool. Works with any site via URL crawling.

### V1 — "Agent Interface"

9. MCP server generation from site content/API ✅ Shipped (standalone + Vercel + CF Workers + hosted)
10. Chat with website (embeddable RAG widget) ✅ Shipped
11. SKILL.md generation ✅ Shipped
12. A2A Agent Card at `/.well-known/agent-card.json` ✅ Shipped
13. Content negotiation middleware (serve markdown to AI user-agents) ✅ Shipped (Next.js adapter)
14. FAQ extraction + FAQPage schema ✅ Shipped
15. Platform adapters: WordPress plugin, Next.js middleware, Docusaurus plugin, Shopify snippets ✅ Shipped
16. `<link rel="alternate" type="text/markdown">` auto-discovery ✅ Shipped (all adapters)

### V2 — "Monetization + Commerce + Scale"

17. Pay-per-crawl (HTTP 402 with price negotiation headers)
18. Agent commerce — UCP (`/.well-known/ucp` manifest)
19. Agent commerce — ACP (product feeds + checkout endpoints)
20. LLM ads serving (site-owned sponsored content)
21. Agent authentication + scoped access
22. AI mention monitoring across ChatGPT, Perplexity, Gemini, Claude
23. Multi-language support (per-locale llms.txt)
24. Additional platform adapters: Shopify app, Webflow app, universal proxy
25. Revenue dashboard
26. Hosted SaaS option (`w2agent.dev`)

---

## VERIFICATION

### Automated (CI)

- **216 unit tests** — audit engine, checks, adapters, generators, MCP server
- **83 integration tests** — real platform builds with live server audits across 6 platforms
- **3 negative tests** — confirm audit catches missing/invalid llms.txt and agent-card
- **CI matrix** — 6 platforms × 2 Node versions (`.github/workflows/integration-tests.yml`)

```bash
pnpm test                                        # Unit tests (~1s)
pnpm --filter @w2agent/core test:integration     # Integration tests (~75s)
```

### Manual

1. Pick 3-5 real websites of different types (e-commerce, docs, local business, blog, SaaS)
2. Run `w2agent audit` against each — score their current AI readiness
3. Run `w2agent generate` — produce llms.txt + markdown for each
4. Test with actual AI agents (Claude, ChatGPT, Perplexity): ask questions about the site before/after
5. Measure: citation rate, answer accuracy, content coverage with vs without w2agent assets

See [SMOKE-TESTS.md](SMOKE-TESTS.md) for real-world audit results.

---

## OPEN QUESTIONS (for implementation session)

1. **Delivery model**: Plugin per platform? Reverse proxy? CLI? Hosted SaaS? Combination?
2. **Language**: TypeScript, Go, Python, or hybrid?
3. **LLM dependency**: Should core features work without any LLM API key?
4. **Naming**: Is "w2agent" the final name?
5. **Monetization of w2agent itself**: Open-source core + paid hosting? Commercial license?
6. **First platform adapter**: WordPress (biggest market) or Next.js (developer-friendly)?
7. **Proxy vs plugin**: For WordPress, is a proxy (sits in front) better than a plugin (runs inside)?
