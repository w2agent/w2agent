# Smoke Test Results

Tested on 2026-03-03 with `w2agent audit` v0.1.0.

## Summary

| Site | Score | Grade | Bot Access | Structured | Content | Discovery | Protocols | Technical |
|------|-------|-------|-----------|-----------|---------|-----------|-----------|-----------|
| `example.com` | 19 | F | 43 | 7 | 11 | 0 | 18 | 42 |
| `docs.anthropic.com` | 47 | F | 47 | 20 | 73 | 7 | 55 | 100 |
| `stripe.com/docs` | 52 | F | 69 | 21 | 76 | 43 | 18 | 96 |
| `github.com` | 54 | F | 71 | 19 | 86 | 44 | 15 | 100 |

## Analysis

### Why all sites score F

Agent-readiness is still early. Even top-tier sites are missing:
- **llms.txt** — No site has one yet
- **Schema.org JSON-LD** — Surprisingly absent from docs sites
- **/.well-known/agent-card.json** — Not adopted yet
- **MCP endpoints** — Emerging standard

### Score differentiation is correct

- **example.com (19)**: Bare placeholder page — lowest score, as expected
- **docs.anthropic.com (47)**: Good content quality (73), perfect technical (100), but no structured data
- **stripe.com/docs (52)**: Strong content and technical, some agent discovery features
- **github.com (54)**: Highest content quality (86), good bot accessibility (71)

### Category insights

- **Technical Foundations** scores highest across all production sites (96-100) — HTTPS, security headers, viewport are table stakes
- **Content Quality** differentiates well — GitHub's rich content (86) vs example.com's bare page (11)
- **Agent Discovery** and **Protocols** are near zero everywhere — this is the market gap w2agent addresses

### Known limitations

- Single-page scans when sitemap isn't at `/sitemap.xml` (many sites use different paths or sitemap indexes)
- Content negotiation check requires server-side markdown support (rare)
- No JavaScript rendering — SPA content is invisible to the crawler
