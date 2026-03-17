# AGENTIZE.md — w2agent Agentize SOP

> Every website is already an agent. This document is the standard operating
> procedure for turning one into a live, queryable agent server using w2agent.

**Audience**: AI agents (Claude, Codex) and human developers.
**Purpose**: Methodology-as-prompt — follow this to agentize any website consistently.
**Scope**: The four-phase pipeline from analysis through live deployment.
Does not cover audit scoring, generate format details, or per-site templates — see [SITE_TEMPLATE.md](SITE_TEMPLATE.md).

Each website gets a companion `<SITE>.md` (per-site document) that fills in the mandatory
tables from this SOP. This document defines the process; `<SITE>.md` holds the site-specific data.

---

## The Three Rules

These rules exist because the most common agentize failures come from agents making assumptions
about sites they haven't actually visited. State them once here; they apply throughout.

**Rule 1: Use the real website — don't simulate it.**

Every route, form, and data model must be verified against the live site.

- ❌ Anti-pattern: "The site probably has a contact form" → run `w2agent generate` and check detected tools
- ❌ Anti-pattern: Inventing route descriptions from URL patterns alone
- ❌ Anti-pattern: Assuming a tool exists because the page type usually has one

**Rule 2: Every agent must be tested against the live site.**

Deployment success ≠ agent working. Test every tool before marking agentize complete.

- ❌ Anti-pattern: Marking validation complete after `agentize` succeeds without calling tools
- ❌ Anti-pattern: Assuming `search_site` works because `hasSearchAction: true` was detected
- ❌ Anti-pattern: Skipping Phase 4 when the deploy step shows no errors

**Rule 3: No graceful degradation — if the site is down, the agent says so.**

Agents must surface errors. Fabricated or stale responses corrupt agent consumers.

- ❌ Anti-pattern: Agent returns cached/stale data when site is unreachable
- ❌ Anti-pattern: Fallback responses that fabricate content ("I think this page might contain...")
- ❌ Anti-pattern: Swallowing 404s and returning empty results as if the page exists

---

## Phase 1: Site Analysis

**Goal**: Build a complete picture of the site before running any w2agent commands.

### Step 1: Run the audit

```bash
npx w2agent audit https://example.com --depth 20
```

Record in `<SITE>.md`:
- Overall score (0–100)
- Platform detected (Next.js, Nuxt, Astro, Docusaurus, WordPress, Shopify, or Unknown)
- Pages scanned
- Top 3 issues flagged

The audit scores 6 categories: Bot Accessibility, Structured Data, Content Quality,
Agent Discovery, Agent Protocols, Technical Foundations.

### Step 2: Map routes

Fill the **Route Map** table (template in the Mandatory Tables section).

Sources: audit verbose output + `sitemap.xml` + actual site browsing.

**Rule 1 applies here**: visit the site. Do not infer routes from URL patterns alone.
A `/blog` path might be a CMS, a redirect, or a 404. Check.

Cover at minimum:
- Homepage
- One example of each page type (product, docs, pricing, contact, etc.)
- Any page that will become a tool source (forms, search, API explorers)

### Step 3: Catalog interactive elements

Fill the **Component Registry** table.

What to look for:
- Search inputs (site search, doc search, product filters)
- Contact and inquiry forms
- Login / signup forms
- Newsletter signups
- API explorers or embedded sandboxes
- Any GET or POST form that sends data to the server

**Rule 1 applies**: open the page, look for forms. URL patterns don't reveal form fields.

### Step 4: Identify data models

Fill the **Data Model Schema** table.

What to look for:
- Product or service entities (name, price, features, SKU)
- Documentation articles (title, content, version, category)
- Pricing tiers (name, limits, price, features)
- User or account types (roles, capabilities)
- API resources (if the site documents an API)

### Step 5: Note platform

Check what platform was auto-detected in the audit output. This matters because:
- `w2agent integrate` generates platform-native integration files (e.g., Next.js route handlers, Astro middleware)
- Platform-specific checks affect what integration paths are available

If the platform shows as Unknown, proceed — the generate step works for any site.

### Phase 1 quality gate

- [ ] Route Map table has ≥ 1 row per distinct page type (not just the homepage)
- [ ] Component Registry lists every form and interactive widget found on the site
- [ ] Platform detected or confirmed as Unknown
- [ ] Audit score recorded with top 3 issues noted

---

## Phase 2: Agent Architecture

**Goal**: Decide what the agent *does* — tool scope, knowledge boundaries, deployment target.

### Step 1: Define tool scope

From the Component Registry, classify each element as tool, skip, or review:

| Form type | Default classification |
|-----------|----------------------|
| GET form (search, filter) | **Tool** — safe read operation |
| POST form (contact, submit) | **Review** — side effects, consider auth |
| POST form (login, auth) | **Skip** — expose credentials risk |
| OpenAPI endpoints | **Tool** — auto-detected, structured |
| FAQ content | **Tool** — `search_faq` auto-generated |
| Newsletter signup | **Skip** — no agent utility |

Update the Component Registry `Tool?` column with your decision and a brief reason for skips.

### Step 2: Define knowledge scope

Decide which pages the agent needs to answer questions about:

- **Include**: homepage, product/pricing pages, docs/guides, API reference
- **Exclude typically**: legal pages, blog archives (unless the site is a publication), auth flows
- **Include if relevant**: changelog, FAQ, support articles

Use `--sections` to filter the crawl to relevant paths:
```bash
npx w2agent generate https://example.com --sections /docs,/api,/guides
```

### Step 3: Read vs write capability decision

For each tool that made it through Step 1, record an explicit read/write classification:

- **Read tools**: safe to expose to any agent consumer, no side effects
- **Write tools**: annotate with caution; note any authentication requirements
  (e.g., "requires `X-API-Key` header" or "form is protected by CSRF token")

This decision shapes how consumer agents invoke your MCP tools.

### Step 4: Data Model Schema

Complete the Data Model Schema table. This becomes the agent's conceptual model.
Agents that lack a clear data model give inconsistent answers about entities —
they may describe a product correctly on one query and incorrectly on the next.

### Step 5: Choose deployment target

| Option | Command | Result |
|--------|---------|--------|
| Hosted (immediate) | `w2agent agentize` | Live at `<slug>.agent.w2agent.dev/mcp`, public, directory-listed |
| Self-hosted (Vercel) | `w2agent mcp deploy --self-host vercel` | Custom domain, your infra |
| Self-hosted (Cloudflare) | `w2agent mcp deploy --self-host cf` | Custom domain, edge-deployed |

Hosted is the default — fastest path to a working agent.

### Phase 2 quality gate

- [ ] Data Model Schema table complete (all key entities identified)
- [ ] Every interactive element in Component Registry classified as tool, skip, or review
- [ ] Knowledge page list (include/exclude) defined
- [ ] Deployment target chosen

---

## Phase 3: Agentize

**Goal**: Run the pipeline — generate, verify outputs, deploy.

**Rule 1 applies**: w2agent fetches the real site. Every command here makes real HTTP requests.

### Step 1: Generate (inspect before deploying)

```bash
npx w2agent generate https://example.com --output ./w2agent-output
```

**Key outputs for agent deployment** — inspect these before proceeding:

**`llms.txt`** — the agent's knowledge file
Verify: does it include all pages from the Phase 2 knowledge scope?
Check for gaps: missing product pages, incomplete docs coverage, truncated content.

**`agent-card.json`** — discovery metadata for the agent network
Verify: name, description, and capabilities are accurate for this site.
The agent card is how other agents discover and decide to use your agent.

**`mcp-server/`** — the MCP server package with detected tools
Verify tool list matches Phase 2 decisions:
```bash
grep "name:" w2agent-output/mcp-server/server.ts
```
Check for:
- **Phantom tools**: tools generated for forms that Phase 2 classified as skip
- **Missing tools**: expected tools not detected (check if the form is JS-rendered)
- **Mis-classified tools**: search form detected as POST (write) when it's GET (read)

**Other generated files** (review if relevant for your integration):
- `llms-full.txt` — expanded knowledge with full page content
- `robots.txt` — updated robots directives including agent permissions
- `schema-org.json` — structured data for search engine consumption
- `faq.json` — extracted FAQ pairs
- `skill-md`, `webmcp`, `openclaw` — additional agent protocol formats

If tools are wrong or missing, use `--sections` to refine crawl scope and regenerate:
```bash
npx w2agent generate https://example.com --sections /search,/contact --output ./w2agent-output
```

### Step 2: Deploy

**Option A — Hosted:**
```bash
npx w2agent login        # one-time auth
npx w2agent agentize https://example.com --slug my-site
# → live at https://my-site.agent.w2agent.dev/mcp
```

**Option B — Self-hosted (Vercel):**
```bash
npx w2agent mcp deploy https://example.com --self-host vercel
cd w2agent-output && vercel deploy
```

**Option C — Self-hosted (Cloudflare):**
```bash
npx w2agent mcp deploy https://example.com --self-host cf
cd w2agent-output && wrangler deploy
```

**Rule 2**: Deployment success ≠ agent working. Proceed to Phase 4 immediately.

### Phase 3 quality gate

- [ ] `llms.txt` coverage matches the knowledge scope defined in Phase 2
- [ ] `agent-card.json` name and description accurately reflect actual site capabilities
- [ ] Generated tools match Phase 2 tool decisions (no phantom tools, no missing tools)
- [ ] agent endpoint is live and returns HTTP 200

---

## Phase 4: Quality Validation

**Goal**: Verify the agent works against the live site. **Rules 2 and 3 apply throughout.**

### Step 1: Test each tool

For each tool in the deployed agent:

1. Call it with valid inputs → verify it returns real data from the live site
2. Call it with edge-case inputs (empty string, very long query, special characters) → verify a graceful error, not a fabricated response
3. Simulate site unavailability → **Rule 3**: the tool must surface the error to the calling agent, not return stale or invented data

Fill the tool test matrix in `<SITE>.md`:

| Tool name | Test input | Expected response | Pass/Fail |
|-----------|-----------|-------------------|-----------|
| `search_site` | "pricing" | List of matching pages with URLs | |
| `contact_form` | name="Test", email="t@t.com", msg="Hello" | Confirmation message | |
| `search_faq` | "refund policy" | Relevant FAQ answer | |

### Step 2: Verify knowledge coverage

Ask the deployed agent questions that require knowledge from each page in the Phase 2 scope:

- Can it describe the product or service accurately?
- Can it answer pricing questions with correct figures?
- Can it cite documentation correctly, without hallucinating version numbers or API signatures?
- Can it answer questions about every major entity in the Data Model Schema?

**Flag**: If the agent answers confidently but incorrectly → the knowledge file is wrong.
Re-run generate with `--max-pages` increased or `--sections` adjusted to include the missing pages.

### Step 3: Verify discovery

```bash
# Agent card must be reachable
curl https://my-site.agent.w2agent.dev/.well-known/agent-card.json

# MCP capability list must be returned
curl https://my-site.agent.w2agent.dev/mcp
```

Both must return valid JSON. Failures here mean the agent is not discoverable by agent directories.

### Phase 4 quality gate (MUST checklist)

- [ ] MUST: Every tool has been called at least once against the live site
- [ ] MUST: No tool returns fabricated data when the underlying page is unreachable
- [ ] MUST: `agent-card.json` description accurately reflects actual capabilities (not generic boilerplate)
- [ ] MUST: Knowledge file covers all pages defined in Phase 2 knowledge scope
- [ ] MUST: Agent can answer questions about every major entity in the Data Model Schema
- [ ] MUST: If the site has a search form, `search_site` tool is present and returns live results
- [ ] MUST: MCP endpoint is reachable at `<slug>.agent.w2agent.dev/mcp` (or custom domain)
- [ ] MUST: No graceful degradation — errors surface to the calling agent, not masked

---

## Mandatory Tables

These three tables are required for every agentize run. Fill them in `<SITE>.md`.
Template rows are examples — replace with actual site data.

### Route Map

**When to fill**: Phase 1 (discovery). **When to verify**: Phase 3 (after generate).
**Purpose**: Complete inventory of the site's URL space. Required to scope the crawl correctly.

| URL Pattern | Page Type | Purpose | Agent Mapping |
|------------|-----------|---------|---------------|
| `/` | Homepage | Product overview, hero CTA | knowledge |
| `/pricing` | Pricing | Tier comparison, prices | knowledge |
| `/docs/*` | Docs | Technical reference | knowledge: `--sections /docs` |
| `/contact` | Form | Inquiry form | tool: `contact_form` |
| `/search` | Search | Site search | tool: `search_site` |
| `/blog/*` | Blog | Posts (if excluding, note here) | skip: out of knowledge scope |

**Agent Mapping values**: `knowledge`, `tool: <name>`, `skip: <reason>`, `review`

### Component Registry

**When to fill**: Phase 1 (discovery). **When to decide**: Phase 2 (classification).
**Purpose**: Exhaustive catalog of interactive elements. Drives tool scope decisions.

| Element | Type | Input Fields | Output / Side Effect | Source Page | Tool? |
|---------|------|-------------|----------------------|-------------|-------|
| Site search | GET form | `q` | Search results page | `/` | Yes |
| Contact form | POST form | `name`, `email`, `message` | Email sent to site owner | `/contact` | Review |
| Doc search | GET form | `query` | Filtered doc list | `/docs` | Yes |
| Newsletter signup | POST form | `email` | Subscription created | `/` | Skip: no agent utility |
| Login form | POST form | `email`, `password` | Session cookie | `/login` | Skip: credentials risk |

**Tool? values**: `Yes`, `No`, `Skip: <reason>`, `Review: <concern>`

### Data Model Schema

**When to fill**: Phase 2 (architecture). **When to verify**: Phase 4 (validation).
**Purpose**: The agent's conceptual model. Agents without this give inconsistent entity answers.

| Entity | Key Fields | Source Pages | How Accessed by Agent |
|--------|-----------|-------------|----------------------|
| Product | `name`, `price`, `features`, `plan_limits` | `/pricing` | knowledge: `llms.txt` |
| Doc article | `title`, `content`, `version`, `category` | `/docs/*` | knowledge: `llms.txt` |
| API endpoint | `path`, `method`, `params`, `response_schema` | `/docs/api/*` | knowledge + tool: auto-detected |
| Pricing tier | `name`, `monthly_price`, `annual_price`, `limits` | `/pricing` | knowledge: `llms.txt` |

**How Accessed values**: `knowledge: llms.txt`, `tool: <name>`, `knowledge + tool: <name>`
