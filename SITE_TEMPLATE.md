# [Site Name] — `<SITE>.md`

<!-- Copy this file and rename it to your site's slug, e.g. stripe.md, shopify.md -->
<!-- Fill each section top-to-bottom as you execute AGENTIZE.md phases -->

**Site**: [Site Name]
**URL**: https://example.com
**Slug**: example
**Agentize date**: YYYY-MM-DD
**Deployment**: https://example.agent.w2agent.dev/mcp

---

## Audit Summary

<!-- Phase 1, Step 1 — run: npx w2agent audit https://example.com --depth 20 -->

| Field | Value |
|-------|-------|
| Score | 0–100 |
| Platform | Next.js / Nuxt / Astro / Docusaurus / WordPress / Shopify / Unknown |
| Pages scanned | 0 |
| Top issue 1 | |
| Top issue 2 | |
| Top issue 3 | |

---

## Architecture Summary

<!-- Phase 1 — fill after audit + initial site review -->

**Framework**: [e.g. Next.js 14, App Router]
**Hosting**: [e.g. Vercel, Cloudflare, AWS, self-hosted]
**Deployment target**: [Hosted / Self-hosted Vercel / Self-hosted Cloudflare]
**MCP slug**: [e.g. example]

**API patterns**:
- [e.g. REST API at /api/v1, documented at /docs/api]
- [e.g. No public API — content-only site]

**Auth**: [e.g. None / Clerk / NextAuth / Cookie session]

**Notable**: [Any platform-specific notes — e.g. "ISR pages may delay fresh content"; "search is client-side JS, not a form POST"]

---

## Route Map

<!-- Phase 1, Step 2 — fill from audit + sitemap.xml + actual site browsing (Rule 1: visit the real site) -->
<!-- Phase 3 verify: confirm after w2agent generate that all knowledge routes appear in llms.txt -->

| URL Pattern | Page Type | Purpose | Agent Mapping |
|------------|-----------|---------|---------------|
| `/` | Homepage | Product overview, hero CTA | knowledge |
| `/pricing` | Pricing | Tier comparison, prices | knowledge |
| `/docs/*` | Docs | Technical reference | knowledge: `--sections /docs` |
| `/contact` | Form | Inquiry form | tool: `contact_form` |
| `/search` | Search | Site search | tool: `search_site` |
| `/blog/*` | Blog | Posts | skip: out of knowledge scope |

<!-- Agent Mapping values: knowledge | tool: <name> | skip: <reason> | review -->

**Phase 1 gate**:
- [ ] ≥ 1 row per distinct page type (not just homepage)
- [ ] Every form/tool-source page has its own row

---

## Component Registry

<!-- Phase 1, Step 3 — catalog all interactive elements (Rule 1: open each page, look for forms) -->
<!-- Phase 2, Step 1 — set Tool? column to Yes / No / Skip: <reason> / Review: <concern> -->

| Element | Type | Input Fields | Output / Side Effect | Source Page | Tool? |
|---------|------|-------------|----------------------|-------------|-------|
| Site search | GET form | `q` | Search results page | `/` | Yes |
| Contact form | POST form | `name`, `email`, `message` | Email sent to site owner | `/contact` | Review |
| Doc search | GET form | `query` | Filtered doc list | `/docs` | Yes |
| Newsletter signup | POST form | `email` | Subscription created | `/` | Skip: no agent utility |
| Login form | POST form | `email`, `password` | Session cookie | `/login` | Skip: credentials risk |

<!-- Tool? values: Yes | No | Skip: <reason> | Review: <concern> -->

**Phase 2 gate**:
- [ ] Every element classified — no blank Tool? cells

---

## Data Model Schema

<!-- Phase 2, Step 4 — the agent's conceptual model of key entities -->
<!-- Phase 4 verify: agent can answer questions about every entity listed here -->

| Entity | Key Fields | Source Pages | How Accessed by Agent |
|--------|-----------|-------------|----------------------|
| Product | `name`, `price`, `features`, `plan_limits` | `/pricing` | knowledge: `llms.txt` |
| Doc article | `title`, `content`, `version`, `category` | `/docs/*` | knowledge: `llms.txt` |
| API endpoint | `path`, `method`, `params`, `response_schema` | `/docs/api/*` | knowledge + tool: auto-detected |
| Pricing tier | `name`, `monthly_price`, `annual_price`, `limits` | `/pricing` | knowledge: `llms.txt` |

<!-- How Accessed values: knowledge: llms.txt | tool: <name> | knowledge + tool: <name> -->

**Phase 4 gate**:
- [ ] Agent can answer questions about every entity in this table

---

## Knowledge Scope

<!-- Phase 2, Step 2 — define which pages the agent needs to know -->

**Included paths** (crawl these):
- `/` — homepage
- `/pricing` — pricing and plans
- `/docs/*` — technical reference
- `/api/*` — API reference

**Excluded paths** (skip these):
- `/blog/*` — out of scope for this agent
- `/legal/*` — boilerplate, low signal
- `/login`, `/signup` — auth flows, no agent utility

**Generate command with sections filter**:
```bash
npx w2agent generate https://example.com --sections /docs,/api,/pricing --output ./w2agent-output
```

**Phase 2 gate**:
- [ ] Included/excluded list is explicit (no "maybe" pages)
- [ ] `--sections` value matches included paths above

---

## Agent Tool Design

<!-- Phase 2 → Phase 3 bridge — one row per tool that will be deployed -->
<!-- Derived from Component Registry (Tool? = Yes or Review-approved) -->

| Tool Name | Description | Inputs | Output | Source Page | Read/Write |
|-----------|-------------|--------|--------|-------------|------------|
| `search_site` | Full-text search across all indexed pages | `q: string` | Array of `{url, title, snippet}` | `/search` | Read |
| `contact_form` | Submit an inquiry to the site owner | `name: string`, `email: string`, `message: string` | Confirmation string | `/contact` | Write |
| `search_faq` | Search FAQ entries for an answer | `query: string` | Matching FAQ `{question, answer}` pairs | `/faq` | Read |
| `get_pricing` | Return current pricing tiers and feature limits | none | Array of `{name, price, features}` | `/pricing` | Read |

<!-- Read/Write: Read = safe, no side effects | Write = has side effects, note auth requirements -->
<!-- If a Write tool requires auth: add "requires X-API-Key header" or "CSRF protected" note -->

**Phase 3 gate**:
- [ ] Tool list here matches `grep "name:" w2agent-output/mcp-server/server.ts` output
- [ ] No phantom tools (check against Skip decisions in Component Registry)
- [ ] No missing tools (check against Yes decisions in Component Registry)

---

## Tool Test Matrix

<!-- Phase 4, Step 1 — test every tool against the live site -->
<!-- Rule 2: call each tool before marking agentize complete -->
<!-- Rule 3: test with unavailable site — tool must surface error, not return stale data -->

| Tool Name | Test Input | Expected Response | Edge Case Tested | Pass/Fail |
|-----------|-----------|-------------------|-----------------|-----------|
| `search_site` | `"pricing"` | List of matching pages with URLs | Empty string → graceful error | |
| `contact_form` | `name="Test", email="t@t.com", msg="Hello"` | Confirmation message | Invalid email → validation error | |
| `search_faq` | `"refund policy"` | Relevant FAQ answer | No match → empty array, not fabricated | |
| `get_pricing` | (none) | Tier list with prices | Site down → error surfaced | |

**Phase 4 gate**:
- [ ] MUST: Every tool called at least once against the live site
- [ ] MUST: No tool returns fabricated data when underlying page is unreachable
- [ ] MUST: MCP endpoint reachable and returns HTTP 200

---

## Quality Notes

<!-- Ongoing — record gaps, caveats, and known issues discovered during any phase -->

### Gaps

- [ ] [e.g. Docs section has 400+ pages — llms.txt may truncate; increase --max-pages if needed]
- [ ] [e.g. Pricing page uses JS to render tier cards — verify llms.txt captured prices]

### Caveats

- [e.g. Contact form is CSRF-protected — `contact_form` tool may fail without session cookie]
- [e.g. Search returns stale results (CDN cache) — up to 5 min delay for newly indexed pages]

### Known issues

- [e.g. `/api/webhooks` path detected as tool but should be skip — remove from Phase 2 decision]
