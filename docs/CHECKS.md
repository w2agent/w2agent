# w2agent Check Reference

41 core checks across 6 categories + 19 platform-specific checks (60 total).

## Bot Accessibility (20%)

| Check | ID | What it measures |
|-------|----|-----------------|
| robots.txt exists | `robots-txt-exists` | robots.txt is accessible |
| AI agent access | `ai-agent-access` | robots.txt root access per vendor-documented token (`src/audit/shared/bot-tokens.ts`): user-initiated agent blocked = fail (error); search fetcher blocked = partial (warning); training crawlers reported only, never scored. No robots.txt (4xx, or a 200 HTML soft-404) = pass; robots.txt 5xx, including a 503 that persists through retries = fail (error; RFC 9309 unreachable = assume complete disallow); a 429 that persists through retries = `error` (unmeasured: rate-limited, the file was never seen); no response (network error, timeout) = `error` (unmeasured) |
| XML sitemap exists | `sitemap-exists` | Valid sitemap.xml present |
| Response time | `response-time` | Average page load <2s |
| Content negotiation | `content-negotiation` | Responds to `Accept: text/markdown` |
| Status codes | `status-codes` | No 4xx/5xx errors |

## Structured Data (20%)

| Check | ID | What it measures |
|-------|----|-----------------|
| Schema.org JSON-LD | `schema-org-present` | JSON-LD on pages |
| Schema.org type | `schema-org-type` | Uses recognized types (Article, Product, etc.) |
| Schema.org completeness | `schema-org-completeness` | Required fields populated |
| JSON-LD valid | `schema-org-valid` | Valid @context and @type |
| OpenGraph tags | `og-meta-tags` | og:title, og:description, og:image |
| Heading hierarchy | `heading-hierarchy` | Proper H1→H2→H3 nesting |
| Semantic HTML | `semantic-html` | Uses article, section, nav, main |

## Content Quality (20%)

| Check | ID | What it measures |
|-------|----|-----------------|
| Answer-first | `answer-first` | Substantive content in first 500 chars |
| Token efficiency | `token-efficiency` | Text-to-HTML ratio |
| Content length | `content-length` | 200+ words per page |
| Lists and tables | `list-and-table-usage` | Structured content elements |
| FAQ content | `faq-content` | Q&A formatted content |
| Citation readiness | `citation-readiness` | Stats, quotes, references |
| Freshness signals | `freshness-signals` | datePublished, dateModified |
| Author attribution | `author-attribution` | Author name visible |

## Agent Discovery (15%)

| Check | ID | What it measures |
|-------|----|-----------------|
| llms.txt | `llms-txt-exists` | /llms.txt present |
| llms.txt valid | `llms-txt-valid` | Follows spec (H1, blockquote, URLs) |
| llms.txt links | `llms-txt-links-resolve` | URLs in llms.txt return 200 |
| Agent card | `well-known-agent-card` | /.well-known/agent-card.json validated against A2A v1.0 (100 = `name`, `description`, `version`, non-empty `supportedInterfaces[]` each with an absolute http(s) `url`/`protocolBinding`/`protocolVersion`, `capabilities` object, `defaultInputModes`/`defaultOutputModes`, `skills[]` each with `id`/`name`/`description`/`tags`; 50 = v0.3 shape (`name` + absolute `url`, plus `preferredTransport` or `capabilities` object + `skills[]`), or a "stub" whose interface URL is the site homepage; 0 = absent, not JSON, or neither shape) |
| MCP server card (tracked, weight 0) | `mcp-server-card` | First valid of: `<MCP endpoint>/server-card`, up to 3 `/.well-known/ai-catalog.json` entries of type `application/mcp-server-card+json` (fetched, off-origin allowed, through the fetch allow-hook), legacy `/.well-known/mcp/server-card.json`. On a catch-all site, same-origin endpoint and catalog URLs are not fetched. Fetches share a 10 s budget. 100 = JSON object with `name`, `version`, `description`; 0 = a card was found but misses a field (message names it and where); skip = none. Not scored until SEP-2127 merges |
| Markdown alternate | `markdown-alternate` | `<link rel="alternate" type="text/markdown">` |

Retired (no longer audited or probed): `well-known-agents-json`, `well-known-ara`, `well-known-ai-plugin`.

## Agent Protocols (15%)

| Check | ID | What it measures |
|-------|----|-----------------|
| MCP endpoint | `mcp-discovery` | Probes same-site homepage MCP links, `/mcp`, `mcp.<domain>/mcp`, `mcp.<domain>/` with `server/discover` (2026-07-28), falling back to `initialize` (2025-11-25) and legacy HTTP+SSE (100=handshake or modern protocol error, 75=401 Bearer challenge with `resource_metadata` (auth-gated), 50=deprecated HTTP+SSE (incl. auth-gated), 0=no endpoint). No endpoint → MCP-tier auth checks are N/A |
| API endpoints | `api-endpoints` | OpenAPI, GraphQL links |
| Structured forms | `forms-structured` | Forms have labels and names |
| UCP | `well-known-ucp` | /.well-known/ucp (weight 0.5). 100 = JSON with a top-level `ucp` object carrying `version` (a `YYYY-MM-DD` date), a non-empty `services` object and a non-empty `payment_handlers` object whose values are arrays; 0 = absent or any of those missing/invalid (message names which). N/A unless the site is detected as ecommerce; a valid profile on a site not detected as ecommerce still passes |
| Action schemas | `action-schemas` | SearchAction, OrderAction in JSON-LD |
| Auth discovery | `auth-discovery` | OAuth/auth endpoints discoverable |
| WebMCP declarative (tracked, weight 0) | `webmcp-declarative` | Forms with a `toolname` attribute. 100 = at least one found (message: `n/m task forms declare WebMCP tools`; every `toolname` form counts in both n and m; forms without `toolname` count in m unless they are search forms (`role="search"`, inside `<search>`, an `input[type=search]`, or a text input named `q`/`query`/`s` as the only field), login forms (a password input) or newsletter forms (a single email input)); skip = none |
| WebMCP imperative (tracked, weight 0) | `webmcp-imperative` | `document.modelContext` (CG draft 2026-09-10), the deprecated `navigator.modelContext` alias, or `modelContext.registerTool` in inline scripts on crawled pages; if none, up to 5 unique same-origin `<script src>` files, resolved against `<base href>` (same origin as the page or the audited URL, same scheme, host equal to the audited host up to a leading `www.`; ≤256 KB each, through the fetch allow-hook; 301/302/303/307/308 followed only to another such URL, max 3 hops; refused, non-2xx, other redirects and failed fetches are ignored). An `origin-trial` meta token whose feature names WebMCP counts as detected even without registration code (details say so). 100 = detected; skip = none |
| Reachable as ChatGPT-User | `reach-openai-user-agent` | Homepage fetched with OpenAI's documented ChatGPT-User UA string (weight 0.5). 100 = final 2xx with non-empty body; 0 = non-2xx (403 challenge, 429, 5xx), empty body, timeout, or fetch error. HTTP only — robots.txt posture is scored by `ai-agent-access`. Crawler time budget exhausted before the fetch → `error` (unmeasured, excluded from the score, `unmeasured-checks` warning) |
| Reachable as Perplexity-User | `reach-perplexity-user-agent` | Same as above with Perplexity's documented Perplexity-User UA string |
| Reachable as Google-Agent | `reach-google-user-agent` | Same as above with Google's documented Google-Agent UA string (sent verbatim, including its `Chrome/W.X.Y.Z` version placeholder) |

No Claude-User reach check: Anthropic publishes the robots token but no UA string.

UCP is a documented scoring-policy exception: it fails the stability bar (breaking schema change in the 2026-08-25 release) but stays scored at 0.5, ecommerce-only, because it is a shipped spec under Google/Shopify governance with platform-default adoption on every Shopify store. If the next UCP release breaks the profile schema again, it is demoted to tracked.

## Technical Foundations (10%)

| Check | ID | What it measures |
|-------|----|-----------------|
| HTTPS | `https` | All pages use HTTPS |
| Security headers | `security-headers` | CSP, X-Frame-Options, HSTS |
| Canonical URLs | `canonical-urls` | `<link rel="canonical">` |
| Mobile viewport | `mobile-viewport` | Viewport meta tag |
| UTF-8 charset | `charset-utf8` | UTF-8 declared |
| No JS dependency | `no-js-dependency` | Content accessible without JS |

## Auth & Access (OAuth and MCP authorization rows)

| Check | ID | What it measures |
|-------|----|-----------------|
| OAuth discovery chain | `oauth-discovery` | Weight 3. Entry points, in precedence order: a 401 from `/api/`, `api.<domain>/`, or the discovered MCP endpoint (Bearer `resource_metadata` if present, else path-inserted then root `/.well-known/oauth-protected-resource`), then the crawled root PRM; the first entry that resolves a full chain wins, else the first valid PRM is scored. PRM must be JSON with a `resource` covering the requested URL (same origin, path prefix) and non-empty `authorization_servers`. AS metadata tried per MCP 2026-07-28 order (RFC 8414 / OIDC, path insertion), off-origin allowed through the fetch allow-hook; `issuer` must be the identical string (only an origin-only issuer may differ by a trailing `/`); an issuer-matched document without both endpoints does not stop the walk. 100 = full chain with `authorization_endpoint` + `token_endpoint`; 50 = valid PRM but no usable AS, or no PRM but a valid root AS whose issuer is the site origin; 0 otherwise. N/A when `public-api` fails and no MCP endpoint was found. 15 s budget |
| PKCE S256 | `pkce-s256` | Weight 1.5. 100 = `code_challenge_methods_supported` includes `S256` on the complete AS (issuer match + both endpoints) resolved by `oauth-discovery` or its root-AS fallback; 50 = developer docs mention PKCE and S256; 0 otherwise |
| MCP authorization | `mcp-auth` | Weight 1.5. On an auth-gated MCP endpoint (401 Bearer challenge with `resource_metadata`): 100 = the linked PRM is valid for the endpoint and differs from the PRM `oauth-discovery` scored; 50 = linked PRM missing or invalid. Skip when the endpoint answers without authorization, or when its PRM is the document `oauth-discovery` already scored (the usual case for an MCP-only site) |
| Client ID Metadata Documents | `cimd-support` | Weight 0.5 bonus. 100 when `oauth-discovery` resolves a full chain and the AS sets `client_id_metadata_document_supported: true`; otherwise skip (never lowers the score; `registration_endpoint` alone is neutral) |

Retired: `oauth-support`, `oauth-protected-resource`, `oauth-metadata-rfc9728`, `mcp-auth-mechanism`, `mcp-oauth-metadata`, `mcp-pkce-s256`.

---

## Platform-Specific Checks

These checks run automatically when a platform is detected.

### WordPress (4 checks)

| Check | ID | What it measures |
|-------|----|-----------------|
| REST API Accessible | `wp-rest-api-accessible` | Is `/wp-json/wp/v2/` reachable? |
| Security Plugin Bot Blocking | `wp-security-blocking-bots` | Wordfence/Sucuri/iThemes blocking AI bots? |
| Robots.txt AI Bot Rules | `wp-robots-default-blocking` | Does WP robots.txt block user-initiated or search AI tokens at the root (same token table and robots-parser evaluation as `ai-agent-access`; training opt-outs not penalised)? 100 − 20 per blocked token |
| Page Builder Markup | `wp-page-builder-soup` | Elementor/Divi/WPBakery div-heavy markup hurting parsability? |

### Next.js (3 checks)

| Check | ID | What it measures |
|-------|----|-----------------|
| .well-known Serving | `nextjs-well-known-served` | Does Next.js serve `.well-known/` correctly? |
| Static Generation | `nextjs-static-generation` | Are pages statically generated (fast for AI crawlers)? |
| Metadata API | `nextjs-metadata-api` | Is `generateMetadata` used for consistent SEO? |

### Shopify (3 checks)

| Check | ID | What it measures |
|-------|----|-----------------|
| Robots.txt Customizable | `shopify-robots-editable` | Does the store use `robots.txt.liquid` (Shopify 2.0+)? |
| Product Schema | `shopify-product-schema` | Do product pages have Product JSON-LD with price/availability? |
| Theme App Blocks | `shopify-theme-app-blocks` | Does the theme support Online Store 2.0 app blocks? |

### Nuxt (4 checks)

| Check | ID | What it measures |
|-------|----|-----------------|
| SEO Module | `nuxt-seo-module` | Is `@nuxtjs/seo` installed for sitemap + meta? |
| LLMs Module | `nuxt-llms-module` | Is `nuxt-llms` or llms.txt detected? |
| Schema.org Coverage | `nuxt-schema-org` | What % of pages have JSON-LD structured data? |
| SSR Rendering | `nuxt-ssr-hints` | Are pages server-rendered (not SPA-only)? |

### Astro (3 checks)

| Check | ID | What it measures |
|-------|----|-----------------|
| Sitemap Integration | `astro-sitemap-integration` | Is `@astrojs/sitemap` generating a sitemap? |
| robots.txt | `astro-robots-txt` | Does robots.txt exist and leave user-initiated and search AI tokens unblocked at the root (same evaluation as `ai-agent-access`; training opt-outs not penalised)? |
| Rendering Mode | `astro-ssr-mode` | Are pages fully rendered (static or SSR)? |

### Docusaurus (2 checks)

| Check | ID | What it measures |
|-------|----|-----------------|
| Sidebar Coverage | `docusaurus-sidebar-coverage` | Does sidebar cover all docs? |
| Versioned Docs | `docusaurus-versioned-docs` | Are versioned docs discoverable? |
