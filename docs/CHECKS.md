# w2agent Check Reference

41 core checks across 6 categories + 19 platform-specific checks (60 total).

## Bot Accessibility (20%)

| Check | ID | What it measures |
|-------|----|-----------------|
| robots.txt exists | `robots-txt-exists` | robots.txt is accessible |
| AI bots not blocked | `robots-txt-ai-bots` | GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Bytespider allowed |
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
| Agent card | `well-known-agent-card` | /.well-known/agent-card.json |
| Markdown alternate | `markdown-alternate` | `<link rel="alternate" type="text/markdown">` |

Retired (no longer audited or probed): `well-known-agents-json`, `well-known-ara`, `well-known-ai-plugin`.

## Agent Protocols (15%)

| Check | ID | What it measures |
|-------|----|-----------------|
| MCP endpoint | `mcp-discovery` | Probes same-site homepage MCP links, `/mcp`, `mcp.<domain>/mcp`, `mcp.<domain>/` with `server/discover` (2026-07-28), falling back to `initialize` (2025-11-25) and legacy HTTP+SSE (100=handshake or modern protocol error, 75=401 Bearer challenge with `resource_metadata` (auth-gated), 50=deprecated HTTP+SSE (incl. auth-gated), 0=no endpoint). No endpoint → MCP-tier auth checks and `mcp-server-card` are N/A |
| API endpoints | `api-endpoints` | OpenAPI, GraphQL links |
| Structured forms | `forms-structured` | Forms have labels and names |
| UCP | `well-known-ucp` | /.well-known/ucp |
| Action schemas | `action-schemas` | SearchAction, OrderAction in JSON-LD |
| Auth discovery | `auth-discovery` | OAuth/auth endpoints discoverable |
| WebMCP declarative | `webmcp-declarative` | Forms use `toolname` attribute for WebMCP declarative API |

## Technical Foundations (10%)

| Check | ID | What it measures |
|-------|----|-----------------|
| HTTPS | `https` | All pages use HTTPS |
| Security headers | `security-headers` | CSP, X-Frame-Options, HSTS |
| Canonical URLs | `canonical-urls` | `<link rel="canonical">` |
| Mobile viewport | `mobile-viewport` | Viewport meta tag |
| UTF-8 charset | `charset-utf8` | UTF-8 declared |
| No JS dependency | `no-js-dependency` | Content accessible without JS |

---

## Platform-Specific Checks

These checks run automatically when a platform is detected.

### WordPress (4 checks)

| Check | ID | What it measures |
|-------|----|-----------------|
| REST API Accessible | `wp-rest-api-accessible` | Is `/wp-json/wp/v2/` reachable? |
| Security Plugin Bot Blocking | `wp-security-blocking-bots` | Wordfence/Sucuri/iThemes blocking AI bots? |
| Robots.txt AI Bot Rules | `wp-robots-default-blocking` | Does WP robots.txt block AI crawlers? |
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
| robots.txt | `astro-robots-txt` | Does robots.txt exist and allow AI bots? |
| Rendering Mode | `astro-ssr-mode` | Are pages fully rendered (static or SSR)? |

### Docusaurus (2 checks)

| Check | ID | What it measures |
|-------|----|-----------------|
| Sidebar Coverage | `docusaurus-sidebar-coverage` | Does sidebar cover all docs? |
| Versioned Docs | `docusaurus-versioned-docs` | Are versioned docs discoverable? |
