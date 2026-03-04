# w2agent Check Reference

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
| Agents JSON | `well-known-agents-json` | /.well-known/agents.json |
| ARA manifest | `well-known-ara` | /.well-known/ara/manifest.json |
| Markdown alternate | `markdown-alternate` | `<link rel="alternate" type="text/markdown">` |

## Agent Protocols (15%)

| Check | ID | What it measures |
|-------|----|-----------------|
| MCP endpoint | `mcp-discovery` | /.well-known/mcp |
| API endpoints | `api-endpoints` | OpenAPI, GraphQL links |
| Structured forms | `forms-structured` | Forms have labels and names |
| UCP | `well-known-ucp` | /.well-known/ucp |
| Action schemas | `action-schemas` | SearchAction, OrderAction in JSON-LD |
| Auth discovery | `auth-discovery` | OAuth/auth endpoints discoverable |

## Technical Foundations (10%)

| Check | ID | What it measures |
|-------|----|-----------------|
| HTTPS | `https` | All pages use HTTPS |
| Security headers | `security-headers` | CSP, X-Frame-Options, HSTS |
| Canonical URLs | `canonical-urls` | `<link rel="canonical">` |
| Mobile viewport | `mobile-viewport` | Viewport meta tag |
| UTF-8 charset | `charset-utf8` | UTF-8 declared |
| No JS dependency | `no-js-dependency` | Content accessible without JS |
