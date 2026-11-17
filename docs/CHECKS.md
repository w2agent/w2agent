# w2agent Check Reference

57 core checks (`allChecks`; 7 of them tracked at weight 0) across 7 categories + 19 platform-specific checks (76 total). Rubric 3.2; see `RUBRIC-CHANGELOG.md`. The 6 site-type checks (ecommerce, local-business) added only when that site type is detected are not listed here. An ecommerce site is detected from platform markup (Shopify, WooCommerce, BigCommerce and Magento markers in `script[src]`, `link[href]`, `img[src]`, `a[href]`, `form[action]`, the checkout meta tag, body classes and `data-mage-init`, or code tokens in code scripts), Product JSON-LD, `og:type=product`, commerce URL paths, price microdata and cart/checkout controls (a button inside a form or tied to one by its `form` attribute, or a link to a `/cart` or `/checkout` path); words in page prose or in data payloads such as Next.js flight data do not count.

**Visible text.** Checks marked "visible text" below read the body text with `script`, `style`, `noscript` and `template` content removed, whitespace-collapsed. `no-js-dependency` measures the no-JS view and also counts the words inside `noscript` (parsed as an HTML fragment: entities decoded, `template`, `script` and `style` skipped).

## Bot Accessibility (15%)

| Check | ID | What it measures |
|-------|----|-----------------|
| robots.txt exists | `robots-txt-exists` | robots.txt is accessible |
| AI agent access | `ai-agent-access` | robots.txt root access per vendor-documented token (`src/audit/shared/bot-tokens.ts`): user-initiated agent blocked = fail (error); search fetcher blocked = partial (warning); training crawlers reported only, never scored. The fix snippet appends `Allow` groups only for agents the `User-agent: *` group blocks; an agent a group names explicitly is listed in a comment and its block is never reversed; when the file ends in a `User-agent` line with no rules no groups are appended (they would join it) and the snippet says to add that group's rules or remove the line first. No robots.txt (4xx, or a 200 HTML soft-404) = pass; robots.txt 5xx, including a 503 that persists through retries = fail (error; RFC 9309 unreachable = assume complete disallow); a 429 that persists through retries = `error` (unmeasured: rate-limited, the file was never seen); no response (network error, timeout) = `error` (unmeasured) |
| XML sitemap exists | `sitemap-exists` | Valid sitemap.xml present |
| Response time | `response-time` | Average response time over measured pages (`responseTime > 0`): <500 ms = pass 100; <1500 ms = pass 70; <3000 ms = partial 35; else fail 0. No measured pages (e.g. externally supplied pre-fetched pages with a 0 ms timing) = skip |
| Content negotiation | `content-negotiation` | Probes the homepage and one docs page (first 2xx crawled page on the site under `/docs` or `/documentation`, or on the `docs.` subdomain) two ways: `GET` with `Accept: text/markdown`, and the `.md` twin (`/` → `/index.md`, else trailing slash stripped + `.md`, query dropped). A hit needs a 2xx, `text/markdown` (or `text/x-markdown`), a non-empty body that is not an HTML document (after a leading BOM, whitespace, HTML comments, `<?…?>` processing instructions such as an XML prolog, and non-HTML `<!DOCTYPE …>` declarations, it does not start with `<!doctype html`, `<html>`, `<head>` or `<body>`; an unterminated leading comment, prolog or doctype counts as HTML), and a body that does not reproduce the crawled page (BOM ignored on both sides; exact comparison, except that a read cut at the 64 KB cap counts as the same when, minus its last 4 chars, it is a prefix of the page). The copy test applies only when the site is flagged catch-all or the crawled page was not declared `text/markdown`, `text/x-markdown` or `text/plain` (a missing content-type counts as HTML), so a site that serves markdown at a crawled URL is not penalised for returning that same markdown. A negotiation request that redirects (301/302/303/307/308) is judged on the redirect target's status, type and body; `Vary: Accept` on either the first response or the final one counts. After the probes, each `.md` hit is checked with a control `GET` to `<random UUID>.md` in the directory of the requested `.md` URL and, when it redirected elsewhere, also in the directory of its final URL (one control per distinct directory, own 5 s timeout, same fetch guard). The hit stands only if every one of its controls gets a response that fails the hit test; a control that also passes it, or is refused, fails or times out, makes that directory's `.md` hits misses. So an `/index.md` that redirects to a shared markdown error document fails, because a nonexistent `/<uuid>.md` redirects there too. The Next.js and Nuxt integrations that `w2agent generate` emits pass this check: they serve `/index.md` as `text/markdown` and send `Accept: text/markdown` at `/` there with `Vary: Accept`. Any `.md` hit, or a negotiation hit with `Vary: Accept` (or `*`) = pass 100; negotiation hits without `Vary: Accept` only = partial 50; no hit (including refused/failed requests) = fail 0 |
| Status codes | `status-codes` | No 4xx/5xx errors |
| Declared AI usage preferences (tracked, weight 0) | `usage-preference-declared` | Whether the site declares how AI may use its content, in any of four vocabularies: `Content-Signal:` in robots.txt (`key=yes\|no`, Cloudflare's Content Signals Policy), `Content-Usage:` in robots.txt and on the homepage response (AIPREF `draft-ietf-aipref-attach`, a structured-field dictionary whose preference values are bare `y`/`n`), `License:` in robots.txt (RSL 1.0 §4.4) and `/.well-known/tdmrep.json` (W3C TDMRep, `tdm-reservation` 1 = reserved). Only robots.txt, the homepage headers and the one `tdmrep.json` probe are read; the probe goes through the catch-all guard, so a catch-all 200 counts as absent. 100 = at least one declaration found; skip = none. The message names the vocabularies and, when the robots body contains Cloudflare's delimited managed block, adds `CDN-managed default`. `details` reports `sources`, `trainingOptOut`, `managedDefault` and one line per parsed signal (path kept in the key for path-scoped declarations). `trainingOptOut` is true when any source forbids training (`ai-train=no`, `train-ai=n`, `tdm-reservation: 1`), false when one permits it and none forbids, else null — one "no" outweighs any number of "yes". Scoping (UA groups, paths, TDMRep `location`) is recorded in `details` but not evaluated. Tracked because it reports a deliberate publisher choice, not readiness: a training opt-out is not a misconfiguration |
| Edge treatment of agent user-agents (tracked, weight 0) | `edge-agent-access` | Whether a site's edge (CDN/WAF) answers the documented agent user-agents worse than our own declared crawler. The multi-UA pass (`fetchUnderUas`, `crawler.ts`) fetches the homepage under every documented `purpose: "user"` token the registry publishes a UA string for — today ChatGPT-User, Perplexity-User, Google-Agent, Amzn-User, MistralAI-User and Meta-ExternalFetcher. The list is built in `crawler.ts` as the three tokens backing a *scored* `reach-*` check, pinned in their historical positions and keys, followed by every other such token in `BOT_TOKENS` order, so a new documented agent is probed with no code change while no scored check moves: the loop is budget-gated per fetch, so a token's position decides whether its check is measured at all on a slow site. Up to 2 extra key pages selected from the crawl are probed under the first `EDGE_EXTRA_PAGE_TOKENS` = 3 only, which is exactly that scored head (ChatGPT-User, Perplexity-User, Google-Agent): the pass runs on a `min(timeout*3, 15s)` wall-clock budget, and six UAs on every page would convert budget pressure into more `unmeasured` results rather than more coverage. Every page also gets a control fetch under `w2agent/0.1`, and each response is fingerprinted with `detectChallenge`. The control is a single-shot fetch of its own on every page, homepage included (never the crawl's retrying `fetchPage`, which would turn a flaky 503 into a fake rejection). A page is comparable only when its control fetch succeeded, returned 2xx **and** carried no challenge — a challenged control means the edge treats everyone that way. Outcomes, in priority order, reported on the `outcome:` first line of `details`: `agent-blocked` = fail, any agent UA got a challenge, 403 or 429 — including one observed before a body-read error; `agent-rejected` = fail, any other non-2xx except 402; `paywalled` = pass, a 402 (informational — a declared paywall is not an edge block); `consistent` = pass, and only when some comparable page was answered 2xx by every agent UA probed *on that page* **and** no probed UA is left without a 2xx answer on any comparable page. Completeness is measured per page rather than against the union of probed tokens, because an extra page carries only three of the six; the second clause is what the union rule used to give for free, and it stops a UA with no 2xx on any comparable page from riding on a complete extra page. When the probe set was not uniform across the comparable pages, the message scopes its claim to the agents each page was probed under instead of claiming all of them. `unmeasured` = `error`, no comparable page, or every agent fetch was budget-skipped, timed out or errored, or no comparable page was answered by every UA probed on it, or some probed UA got no 2xx on any comparable page (so a UA with no clean answer anywhere is never awarded a pass). `details` also carries `<url>.control: <status>` and `<url>.<token>: <status>[ <vendor> <signal>]` per probed page — the control line takes the same shape as an agent line, so a challenged or failed control reads as `200 cloudflare cf-mitigated: challenge` or `0 (fetch-error)`, plus a `notProbed:` line naming the documented `purpose: "user"` tokens with no fetch anywhere (today Claude-User alone — Anthropic publishes no UA string); an unprobed token can never contribute to a pass. A token probed on the homepage but not on an extra page is not on that line — it was probed — and is reported per page instead as `<url>.notProbed: <tokens> (extra-pages-only)`, for any page that carries a probe set of its own, since it reports probe-set coverage rather than what ran — a budget-skipped extra page still has a three-token set, and its stubs read `0 (budget-skipped)` on their own lines. A page whose control was not comparable has no results at all (its agent fetches are skipped wholesale) and gets no such line, because `extra-pages-only` would name the wrong reason there. Tracked, not scored, because the request carrying an agent token comes from our network and is not a *verified* agent request (Cloudflare verifies by IP list, reverse DNS or Web Bot Auth), so what a real agent gets may differ in either direction; promotion is a 3.1 decision |

## Structured Data (15%)

| Check | ID | What it measures |
|-------|----|-----------------|
| Schema.org JSON-LD | `schema-org-present` | JSON-LD on pages |
| Schema.org type | `schema-org-type` | Uses recognized types (Article, Product, etc.) |
| Schema.org completeness | `schema-org-completeness` | Required fields populated |
| JSON-LD valid | `schema-org-valid` | Valid @context and @type |
| OpenGraph tags | `og-meta-tags` | og:title, og:description, og:image |
| Heading hierarchy | `heading-hierarchy` | Proper H1→H2→H3 nesting |
| Semantic HTML | `semantic-html` | Uses article, section, nav, main |

## Content Quality (15%)

| Check | ID | What it measures |
|-------|----|-----------------|
| Answer-first | `answer-first` | Substantive content in first 500 chars of visible text |
| Token efficiency | `token-efficiency` | Visible-text-to-HTML ratio |
| Content length | `content-length` | 200+ visible words per page |
| Lists and tables | `list-and-table-usage` | Structured content elements |
| FAQ content | `faq-content` | Q&A formatted content (question marks and "frequently asked" are counted in visible text) |
| Citation readiness | `citation-readiness` | Stats, quotes, references (stat and quote patterns are matched in visible text) |
| Freshness signals | `freshness-signals` | datePublished, dateModified |
| Author attribution | `author-attribution` | Author name visible |

## Agent Discovery (12%)

| Check | ID | What it measures |
|-------|----|-----------------|
| llms.txt | `llms-txt-exists` | /llms.txt present |
| llms.txt valid | `llms-txt-valid` | Follows spec (H1, blockquote, URLs) |
| llms.txt links | `llms-txt-links-resolve` | URLs in llms.txt return 200 |
| Agent card | `well-known-agent-card` | /.well-known/agent-card.json validated against A2A v1.0 (100 = `name`, `description`, `version`, non-empty `supportedInterfaces[]` each with an absolute http(s) `url`/`protocolBinding`/`protocolVersion`, `capabilities` object, `defaultInputModes`/`defaultOutputModes`, `skills[]` each with `id`/`name`/`description`/`tags`; 50 = v0.3 shape (`name` + absolute `url`, plus `preferredTransport` or `capabilities` object + `skills[]`), or a "stub" whose interface URL is the site homepage; 0 = absent, not JSON, or neither shape) |
| MCP server card (tracked, weight 0) | `mcp-server-card` | First valid of: `<MCP endpoint>/server-card`, up to 3 `/.well-known/ai-catalog.json` entries of type `application/mcp-server-card+json` (fetched, off-origin allowed, through the fetch allow-hook), legacy `/.well-known/mcp/server-card.json`. On a catch-all site, same-origin endpoint and catalog URLs are not fetched. Fetches share a 10 s budget. 100 = JSON object with `name`, `version`, `description`; 0 = a card was found but misses a field (message names it and where); skip = none. Not scored until SEP-2127 merges |
| Agent Skills index (tracked, weight 0) | `agent-skills-index` | Reads `/.well-known/agent-skills/index.json`, fetched by the crawler with the other well-known files, so it needs a JSON content type (`application/json` or a `+json` type; the RFC requires servers to use `application/json`) and is absent on a catch-all site (the catch-all body guard). Never fetches a skill `url`. Bodies over 256 KB fail. Valid = a JSON object with the known v0.2.0 `$schema` (`https://schemas.agentskills.io/discovery/0.2.0/schema.json`) and a non-empty `skills` array whose entries each have `name` (1-64 chars, lowercase words joined by single hyphens), `type` (`skill-md` or `archive`), `description` (1-1024 chars), `url` (not blank; resolves to http(s) against the index URL, and not to the index URL itself, e.g. a fragment-only url) and `digest` (`sha256:` plus 64 lowercase hex). Unknown fields are ignored. 100 = valid; 50 = entries valid but `$schema` absent (v0.2.0 requires it; clients treat the index as v0.1.0); 0 = over the cap, not a JSON object, unknown or non-string `$schema`, missing or empty `skills`, or an invalid entry (message names the first 3 problems); skip = no index. Not scored: the [RFC](https://github.com/cloudflare/agent-skills-discovery-rfc) is a Cloudflare-led draft whose v0.2 renamed the path and replaced the schema |
| Markdown alternate | `markdown-alternate` | `<link rel="alternate" type="text/markdown">` |

Retired (no longer audited or probed): `well-known-agents-json`, `well-known-ara`, `well-known-ai-plugin`.

## Agent Protocols (13%)

| Check | ID | What it measures |
|-------|----|-----------------|
| MCP endpoint | `mcp-discovery` | Probes same-site homepage MCP links, `/mcp`, `mcp.<domain>/mcp`, `mcp.<domain>/` with `server/discover` (2026-07-28), falling back to `initialize` (2025-11-25) and legacy HTTP+SSE (100=handshake or modern protocol error, 75=401 Bearer challenge with `resource_metadata` (auth-gated), 50=deprecated HTTP+SSE (incl. auth-gated), 0=no endpoint). No endpoint → MCP-tier auth checks are N/A |
| API endpoints | `api-endpoints` | OpenAPI, GraphQL links |
| Structured forms | `forms-structured` | Forms have labels and names |
| UCP | `well-known-ucp` | /.well-known/ucp (weight 0.5). 100 = JSON with a top-level `ucp` object carrying `version` (a `YYYY-MM-DD` date), a non-empty `services` object and a non-empty `payment_handlers` object whose values are arrays; 0 = absent or any of those missing/invalid (message names which). N/A unless the site is detected as ecommerce (detection rule: see the header); a valid profile on a site not detected as ecommerce still passes |
| Action schemas | `action-schemas` | SearchAction, OrderAction in JSON-LD |
| WebMCP declarative (tracked, weight 0) | `webmcp-declarative` | Forms with a `toolname` attribute. 100 = at least one found (message: `n/m task forms declare WebMCP tools`; every `toolname` form counts in both n and m; forms without `toolname` count in m unless they are search forms (`role="search"`, inside `<search>`, an `input[type=search]`, or a text input named `q`/`query`/`s` as the only field), login forms (a password input) or newsletter forms (a single email input)); skip = none |
| WebMCP imperative (tracked, weight 0) | `webmcp-imperative` | `document.modelContext` (CG draft 2026-09-10), the deprecated `navigator.modelContext` alias, or `modelContext.registerTool` in inline JavaScript on crawled pages (inline data payloads, meaning `<script>` with a non-JavaScript `type` such as `application/json` or `application/ld+json`, and Next.js flight data `self.__next_f.push(...)`, are not scanned); if none, up to 5 unique `<script src>` files on the audited site, resolved against `<base href>` (same scheme and port as the audited URL, host equal to the audited host up to a leading `www.`, whichever page the tag is on; ≤256 KB each, through the fetch allow-hook; 301/302/303/307/308 followed only to another such URL, max 3 hops; refused, non-2xx, other redirects and failed fetches are ignored). An `origin-trial` meta token whose feature names WebMCP counts as detected even without registration code (details say so). 100 = detected; skip = none |
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
| No JS dependency | `no-js-dependency` | Content accessible without JS (word thresholds and the SPA-shell ratio count visible text plus `noscript` text) |

## Auth & Access (20%)

| Check | ID | What it measures |
|-------|----|-----------------|
| Public API surface | `public-api` | Weight 2. 100 = `/api/` or `api.<domain>/` answers 2xx/4xx with a JSON or YAML body, or 3+ API links on the homepage; 50 = 1–2 API links; 0 otherwise |
| OpenAPI specification | `openapi-spec` | Weight 2. 100 = OpenAPI spec found with at least one endpoint; 50 = spec with no endpoints; 0 = none. N/A when `public-api` fails (a pass or partial result is kept) |
| Developer portal | `developer-portal` | Weight 2. 100 = portal found with 1000+ chars of text. A portal is a 2xx response whose `content-type` contains `html` or is missing, on `/developers`, `/developer`, `/api`, `/docs/api`, `/api-docs` or a `docs.`/`developers.`/`developer.` subdomain root; a JSON, YAML, XML or plain-text reply is a machine endpoint (see `public-api`) and is not a portal; 50 = thin portal; 0 = none; skip when the portal probe had no network. Same-origin portal paths are not credited on a catch-all site. N/A when `public-api` fails (a pass or partial result is kept) |
| Agent/bot auth documentation | `agent-auth-docs` | Weight 2. Counts "api key"/"oauth"/"rate limit" near "agent"/"bot"/"ai"/"scope"/"permission"/"token" in portal, key docs and homepage text: 3+ = 100, 1–2 = 50, 0 = 0. N/A when `developer-portal` fails (a pass or partial result is kept) |
| Scoped API permissions | `scoped-permissions` | Weight 1.5. Scope patterns (`read:x`), scope/permission wording and graduated-access vocabulary in portal and key docs: 3+ = 100, 1–2 = 50, 0 = 0. N/A when `developer-portal` fails (a pass or partial result is kept) |
| API catalog (RFC 9727) | `api-catalog-rfc9727` | Weight 1. 100 = `/.well-known/api-catalog` served as `application/linkset+json` with a `linkset` entry carrying `anchor` and a non-empty `item`/`service-desc`/`service-doc` array of `href` objects; 0 otherwise. N/A when `public-api` fails (a pass or partial result is kept) |
| Agent operator signing directory (tracked, weight 0) | `agent-operator-signing` | `/.well-known/http-message-signatures-directory` served with its media type: 100 = an Ed25519 JWK and a `signature_agent` whose origin is the audited origin; 0 = key or origin missing; skip = absent. Tracked because the directory describes the bot operator, not the audited site |
| OAuth discovery chain | `oauth-discovery` | Weight 3. Entry points, in precedence order: a 401 from `/api/`, `api.<domain>/`, or the discovered MCP endpoint (Bearer `resource_metadata` if present, else path-inserted then root `/.well-known/oauth-protected-resource`), then the crawled root PRM; the first entry that resolves a full chain wins, else the first valid PRM is scored. PRM must be JSON with a `resource` covering the requested URL (same origin, path prefix) and non-empty `authorization_servers`. AS metadata tried per MCP 2026-07-28 order (RFC 8414 / OIDC, path insertion), off-origin allowed through the fetch allow-hook; `issuer` must be the identical string (only an origin-only issuer may differ by a trailing `/`); an issuer-matched document without both endpoints does not stop the walk. 100 = full chain with `authorization_endpoint` + `token_endpoint`; 50 = valid PRM but no usable AS, or no PRM but a valid root AS whose issuer is the site origin; 0 otherwise. N/A when `public-api` fails and no MCP endpoint was found (a pass or partial result is kept). 15 s budget |
| PKCE S256 | `pkce-s256` | Weight 1.5. 100 = `code_challenge_methods_supported` includes `S256` on the complete AS (issuer match + both endpoints) resolved by `oauth-discovery` or its root-AS fallback; 50 = developer docs mention PKCE and S256; 0 otherwise; skip when no AS was resolved and the developer-portal probe had no network. N/A when `oauth-discovery` and `developer-portal` both fail or are N/A (a pass or partial result is kept) |
| MCP authorization | `mcp-auth` | Weight 1.5. On an auth-gated MCP endpoint (401 Bearer challenge with `resource_metadata`): 100 = the linked PRM is valid for the endpoint and differs from the PRM `oauth-discovery` scored; 50 = linked PRM missing or invalid. Skip when the endpoint answers without authorization, or when its PRM is the document `oauth-discovery` already scored (the usual case for an MCP-only site) |
| Client ID Metadata Documents | `cimd-support` | Weight 0.5 bonus. 100 when `oauth-discovery` resolves a full chain and the AS sets `client_id_metadata_document_supported: true`; otherwise skip (never lowers the score; `registration_endpoint` alone is neutral) |

Retired: `oauth-support`, `oauth-protected-resource`, `oauth-metadata-rfc9728`, `mcp-auth-mechanism`, `mcp-oauth-metadata`, `mcp-pkce-s256`, `agent-allowlist` (merged into `ai-agent-access`), `web-bot-auth-directory` (now tracked `agent-operator-signing`).

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
| .well-known Serving | `nextjs-well-known-served` | Does the site serve an A2A `.well-known/agent-card.json`? Skipped (not applicable) when none is published; fails only when a credited file is not an agent card |
| Static Generation | `nextjs-static-generation` | Are most pages statically generated (fast for AI crawlers)? Each sampled page is classed dynamic (`cache-control` `private` or `no-store`; `__NEXT_DATA__` `gssp` or `gip` true, unless `nextExport` is true; `appGip` true without `gsp` or `nextExport`; flags read only at the top level of the parsed JSON), static (`x-nextjs-prerender`; `x-nextjs-cache` or `x-vercel-cache` of HIT, STALE, PRERENDER or REVALIDATED; `cache-control` `s-maxage` or `public`; `__NEXT_DATA__` `gsp`, `nextExport` or `autoExport` true) or no evidence; dynamic wins. 100 when at least half of the pages with evidence are static; else 60 (also when no page has evidence) |
| Metadata API | `nextjs-metadata-api` | Is `generateMetadata` used for consistent SEO? |

### Shopify (3 checks)

| Check | ID | What it measures |
|-------|----|-----------------|
| Robots.txt Customizable | `shopify-robots-editable` | Does the store use `robots.txt.liquid` (Shopify 2.0+)? |
| Product Schema | `shopify-product-schema` | Do product pages (crawled URLs containing `/products/`) carry Product or ProductGroup schema, as JSON-LD or microdata? The same predicate the Shopify generator uses to decide whether to emit schema. Fields are not checked |
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
