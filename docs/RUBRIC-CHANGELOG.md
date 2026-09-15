# Rubric Changelog

`RUBRIC_VERSION` is exported from `w2agent-core` and stamped on every `AuditReport.rubricVersion`. Check ids, categories and weights below are read from `allChecks`; per-check detail lives in [CHECKS.md](CHECKS.md).

## Versioning rules

| Bump | When |
|------|------|
| major | The **scored** check set changes (add, retire, merge, move to or from tracked) or any weight changes |
| minor | A detection fix that changes pass rates without changing what the check is meant to measure |
| patch | Messages or `fixSnippet` text only |

- A check is scored only if its standard is governed (IANA / RFC / IETF WG / foundation, or vendor-documented HTTP behaviour), its path and schema have been stable for 2 or more rubric cycles, and an applicability gate keeps it from penalising sites it doesn't address. Otherwise it is **tracked**: reported with weight 0 and never scored.
- Checks are promoted or demoted only at a version bump, and every bump is logged here. A newly promoted check (tracked → scored, or a new signal) enters at weight 0.5 or less for one cycle. A merge that measures facts already scored by the checks it replaces is not a promotion. The plan's policy section doesn't cover merges; the rubric-change table set their weights (`oauth-discovery` 3 from three 1.5 checks, `mcp-auth` 1.5 from two 1.0 checks).
- **Adding a tracked check does not bump the version.** A check that enters at weight 0 and `tracked: true` is excluded from category renormalization, so it moves no score and no weight — the major-bump row above covers promotion and demotion (tracked ↔ scored), not arrival. Such a check is logged under the current version's "tracked additions" heading, with the same rationale a scored entry owes; it becomes a version event when it is promoted.
- Every entry states the expected median score delta. Before cutover, it also records the measured delta.

## 3.0 — 2026-09-15

Major. `allChecks` 63 → 54 at cutover, of which 4 were tracked. `CATEGORY_CONFIG` is unchanged, so the delta can be attributed to check changes alone. Tracked checks added since cutover (see "3.0 tracked additions" below) bring `allChecks` to 56, of which 6 are tracked; they carry weight 0, so neither the sums below nor the measured delta move.

### Category intra-weight sums (scored checks)

| Category | Category weight | 2.0 | 3.0 |
|----------|-----------------|-----|-----|
| Bot Accessibility | 0.15 | 7 | 7 |
| Structured Data | 0.15 | 7 | 7 |
| Content Quality | 0.15 | 7.5 | 7.5 |
| Agent Discovery | 0.12 | 8 | 3 |
| Agent Protocols | 0.13 | 11.25 | 6.5 on ecommerce sites, and on any site where `well-known-ucp` passes; 6.0 when it fails on a site not detected as ecommerce (it becomes N/A) |
| Technical Foundations | 0.10 | 6 | 6 |
| Auth & Access | 0.20 | 22.5 | 16.5, plus a 0.5 `cimd-support` bonus that only counts when it passes |

These sums are registry maxima. On a given site, N/A cascades and `skip`/`error` results shrink the denominator further. Adding every non-tracked weight gives Auth & Access 17, because that total includes the bonus.

### Changed checks

Weight `—` = the check does not exist in that version. `0 T` = tracked.

| Check | Category | Weight 2.0 → 3.0 | Action | Rationale |
|-------|----------|------------------|--------|-----------|
| `robots-txt-ai-bots` → `ai-agent-access` | bot-accessibility | 2 → 2 | fix (rename, purpose-tiered) | Blocking a user-initiated agent fails; blocking a search fetcher is partial; training crawlers are reported but not scored (D-2: a training opt-out does not make a site agent-unready). A 5xx robots.txt fails; a 429 or no response is `error` |
| `response-time` | bot-accessibility | 1 → 1 | fix (detection) | Buckets are <500 / <1500 / <3000 ms. `skip` when no page carries a timing; untimed pages used to earn a free 100 |
| `content-negotiation` | bot-accessibility | 0.5 → 0.5 | fix (detection) | Adds a `.md` twin probe, a docs page, a `Vary: Accept` requirement (negotiation without it = partial) and catch-all controls |
| `llms-txt-exists` | agent-discovery | 2 → 0.5 | reweight | No governing body and a narrow set of consumers (coding agents). Kept because it is cheap |
| `llms-txt-valid` | agent-discovery | 1 → 0.5 | reweight | Same as above |
| `llms-txt-links-resolve` | agent-discovery | 1 → 0.5 | reweight | Same as above |
| `well-known-agent-card` | agent-discovery | 1 → 1 | fix (detection) | A2A v1.0 required fields = 100; v0.3 shape or a homepage-stub interface = 50; a card that only parses as JSON = 0 |
| `mcp-server-card` | agent-auth → agent-discovery | 1 → 0 T | fix → tracked | SEP-2127 is unmerged and 3 card shapes are live. Now read from `<endpoint>/server-card`, ai-catalog entries, then the legacy path |
| `well-known-agents-json` | agent-discovery | 1 → — | retire | Three incompatible formats and a dormant upstream. No longer probed |
| `well-known-ara` | agent-discovery | 0.5 → — | retire | No adopters. No longer probed |
| `well-known-ai-plugin` | agent-discovery | 1 → — | retire | Its consumer went away in 2024. No longer probed |
| `mcp-discovery` | agent-protocols | 1.5 → 1.5 | fix (rewrite) | The old probe used `/.well-known/mcp`, which no MCP revision defines. Now probes homepage links, `/mcp` and `mcp.<domain>` with `server/discover`, then `initialize`, then legacy SSE. A 401 Bearer with `resource_metadata` = 75. The discovered `mcpEndpoint` is the N/A sentinel for MCP-tier auth checks |
| `well-known-ucp` | agent-protocols | 0.5 → 0.5 (ecommerce only) | fix + gate | Requires a `ucp.version` date, `services` and `payment_handlers`. On a site not detected as ecommerce, a failing result becomes N/A, but a valid profile still passes and counts. D-1 policy exception: fails the stability bar but stays scored |
| `webmcp-declarative` | agent-protocols | 0.75 → 0 T | fix → tracked | Origin trial with an API still in motion. Denominator is task forms only |
| `webmcp-imperative` | agent-protocols | 0.5 → 0 T | fix → tracked | Detects `document.modelContext` and `navigator.modelContext` in inline and same-site scripts |
| `sim-claude` | agent-protocols | 1 → — | retire | Claimed an outcome from a surrogate. Anthropic publishes no Claude-User UA string, so there is no reach replacement |
| `sim-chatgpt` | agent-protocols | 1 → — | retire | Replaced by `reach-openai-user-agent` |
| `sim-gemini` | agent-protocols | 1 → — | retire | Replaced by `reach-google-user-agent` |
| `sim-perplexity` | agent-protocols | 1 → — | retire | Replaced by `reach-perplexity-user-agent` |
| `sim-deepseek` | agent-protocols | 1 → — | retire | No vendor-documented UA |
| `reach-openai-user-agent` | agent-protocols | — → 0.5 | add | Homepage returns 2xx with a non-empty body under the documented ChatGPT-User UA. HTTP only. Budget exhausted = `error` |
| `reach-perplexity-user-agent` | agent-protocols | — → 0.5 | add | Same test with Perplexity-User |
| `reach-google-user-agent` | agent-protocols | — → 0.5 | add | Same test with Google-Agent |
| `oauth-support` | agent-auth | 1.5 → — | merge → `oauth-discovery` | Root-only probing under-scored sites on Auth0/Okta |
| `oauth-protected-resource` | agent-auth | 1.5 → — | merge → `oauth-discovery` | Only checked that the document parsed |
| `oauth-metadata-rfc9728` | agent-auth | 1.5 → — | merge → `oauth-discovery` | Same fact as the chain |
| `oauth-discovery` | agent-auth | — → 3 | add (merge) | Follows 401 → PRM (path-inserted or root) → AS metadata (RFC 8414 / OIDC, off-origin allowed) and requires a matching issuer. Full chain = 100; PRM only, or a root AS alone = 50 |
| `pkce-s256` | agent-auth | 1.5 → 1.5 | fix (detection) | Reads `S256` on the AS that `oauth-discovery` resolved (a full PRM → AS chain, or its fallback to a root AS whose issuer is the site origin), not only the root AS. A docs mention = 50. Absorbs `mcp-pkce-s256` |
| `mcp-auth-mechanism` | agent-auth | 1 → — | merge → `mcp-auth` | `capabilities.auth.type` exists in no schema |
| `mcp-oauth-metadata` | agent-auth | 1 → — | merge → `mcp-auth` | Duplicated the PRM/AS branch |
| `mcp-pkce-s256` | agent-auth | 1 → — | merge → `pkce-s256` | Measured the same fact twice |
| `mcp-auth` | agent-auth | — → 1.5 | add (merge) | A 401 Bearer with `resource_metadata` plus a valid PRM for the MCP endpoint. N/A when there is no MCP endpoint, or when its PRM is the one `oauth-discovery` already scored |
| `cimd-support` | agent-auth | — → 0.5 bonus | add | Passes only on a full `oauth-discovery` chain whose AS has `client_id_metadata_document_supported: true`; otherwise `skip`, so it never lowers a score. MCP 2026-07-28 deprecates DCR |
| `api-catalog-rfc9727` | agent-auth | 1 → 1 | fix (detection) | Requires `application/linkset+json` and a `linkset` entry with `anchor` plus `item`/`service-desc`/`service-doc`. The old invented `apis[]` format now scores 0 |
| `web-bot-auth-directory` | agent-auth | 1 → — | retire → tracked `agent-operator-signing` | The directory describes the bot operator, not the audited site |
| `agent-operator-signing` | agent-auth | — → 0 T | add tracked | Checks for an Ed25519 JWK and a `signature_agent` equal to the audited origin |
| `agent-allowlist` | agent-auth | 1 → — | retire (merged into `ai-agent-access`) | Rewarded `Allow` boilerplate and deprecated tokens |

### Engine-level changes

| Change | Effect |
|--------|--------|
| Catch-all / soft-404 guard | A well-known file is credited only on a 200 with a JSON content-type (the exact media type for api-catalog and the signing directory) and a body that differs from a random-UUID control path. robots.txt and llms.txt served as HTML shells count as absent. On catch-all sites, same-origin developer-portal and key-doc paths are not credited, and the `catch-all-responses` warning is emitted. Sites that used to pass on catch-all 200s lose those passes |
| `error` status | Unmeasured, not a finding about the site. Excluded from category scores, impact estimates, `topIssues` and generate mapping, and listed in the `unmeasured-checks` warning |
| `tracked` checks | Weight 0 and flagged `tracked: true`. Excluded from category renormalization, `topIssues`, warnings and generate mapping. Rendered under "Tracked (not scored)" |
| N/A cascade | `oauth-discovery` is N/A when `public-api` fails and no MCP endpoint exists. `mcp-auth` is a sentinel on `mcpEndpoint`. `pkce-s256` is re-keyed from `oauth-support` to `oauth-discovery`: it is N/A when both `oauth-discovery` and `developer-portal` fail or are N/A. `well-known-ucp` fail becomes N/A unless the site is ecommerce; a pass is kept (non-sentinel) |
| Retired probes | `/.well-known/agents.json`, `ara`, `ai-plugin.json`, `mcp` and `mcp.json` (the 2.0 server-card path) are no longer requested |

### 3.0 tracked additions (no score change)

Added after the 3.0 cutover, at weight 0 and `tracked: true`. No version bump: a tracked check is excluded from category renormalization, `topIssues`, warnings and generate mapping, so it changes no score on any site. Expected median delta: **0, by construction**; no measured delta is owed.

| Check | Category | Weight | Added | Rationale |
|-------|----------|--------|-------|-----------|
| `usage-preference-declared` | bot-accessibility | 0 T | 2026-09-15 (P2-3) | Reports the AI-usage preferences a site declares — `Content-Signal:` and `Content-Usage:` in robots.txt, `Content-Usage` on the homepage response, `License:` (RSL 1.0) and `/.well-known/tdmrep.json` — and whether the robots body is a CDN-managed default. Reported in the same category as `ai-agent-access`, so a deliberate opt-out is visible next to the access result instead of being mistaken for a misconfiguration. Tracked because none of the four vocabularies has been stable for two rubric cycles (the bar above), and because `ai-agent-access`'s D-2 already holds that a training opt-out does not make a site agent-unready — so there is nothing to score here, only something to show |
| `edge-agent-access` | bot-accessibility | 0 T | 2026-09-15 (P2-2) | Compares how a site's edge (CDN/WAF) answers the documented agent user-agents against how it answers our own declared crawler on the same pages. Outcomes: `agent-blocked` (a challenge, 403 or 429 where the control got 2xx), `agent-rejected` (any other non-2xx except 402), `paywalled` (402 — informational), `consistent` (only when some comparable page was answered 2xx by every probed agent UA), `unmeasured` (no comparable control page — non-2xx, failed, or itself challenged — every agent fetch skipped/failed, or no page answered by all probed UAs). Tracked, not scored, because our request carrying `ChatGPT-User` comes from our own network and is therefore not a *verified* ChatGPT request (Cloudflare verifies by IP list, reverse DNS or Web Bot Auth), so the observation is "requests identifying as X from a third-party network" and what the real agent gets may differ in either direction. Promotion to a scored weight is a 3.1 decision, taken on the prevalence this tracked run measures |

### Planned in the improvement plan but not in 3.0

`machine-file-linked` (P3-1), graded `openapi-spec` (P3-2), `ai-catalog-manifest` (P3-3), `agent-skills-index` (P3-4), `acp-discovery` (P3-5). None of them is in `allChecks`. Bot Accessibility stays at 7 scored weight, not 9, and Agent Discovery is 3, not 4 — `usage-preference-declared` and `edge-agent-access` shipped as tracked additions above, and weight 0 leaves those sums untouched.

### Expected median delta

- API and dev-tool sites: **up**. OAuth discovery now follows real chains and the MCP probe finds real servers, so the Auth & Access bucket activates.
- Content sites: **roughly flat**.
- Sites that passed on catch-all 200s: **down**.
- Agent Discovery (8 → 3) and Agent Protocols (11.25 → 6.0/6.5) now rest on fewer checks, so single checks swing those category scores more.

### Measured delta

Dual-run on 2026-09-15 over the 359 leaderboard sites (`scripts/rescore-all.ts --rubric-compare --leaderboard-only` in the platform repo): the frozen 2.0 engine and the 3.0 engine each crawled every site live, back to back. 345 sites produced both scores. 14 failed in at least one engine: bot protection or unreachable (e.g. reuters.com, expedia.com, nasa.gov); zillow.com, wayfair.com and uber.com failed only on the second (3.0) crawl.

Median delta, 3.0 minus 2.0, in points:

| Site type | Sites (scored) | Overall | Auth & Access | Agent Discovery | Agent Protocols | Bot Accessibility | Structured Data | Content Quality | Technical |
|---|---|---|---|---|---|---|---|---|---|
| All | 359 (345) | +0 | +3 | −2 | −7 | +2 | +0 | +0 | +0 |
| Ecommerce | 60 (60) | +0 | +3 | −1 | −8 | +1 | +0 | +0 | +0 |
| Local business | 98 (98) | +0 | +3 | −1 | −6 | +2 | +0 | +0 | +0 |
| Other | 201 (187) | +0 | +3 | −2 | −8 | +2 | +0 | +0 | +0 |

Overall spread: mean 53.6 → 52.7; p10 −9, p25 −3, p75 +2, p90 +6. 33 sites fell 10 or more points and 7 rose 10 or more.

Largest check transitions:
- `llms-txt-exists` pass → fail on 47 sites and `robots-txt-exists` pass → fail on 21 (e.g. linkedin.com, office.com): these sites answer the file path with an HTML page (a bot challenge, a login redirect or a soft-404), which 2.0 credited.
- `mcp-discovery`: fail → pass 61, partial → pass 9, partial → fail 59 (real `server/discover`/`initialize` probes replace path existence).
- `well-known-ucp`: 285 now N/A (not ecommerce); 6 ecommerce passes → fail (no `payment_handlers`).
- `well-known-agent-card`: pass → partial 10 (stub cards), pass → fail 3.
- `content-negotiation`: fail → pass 20.
- `response-time` moved in both directions on about 140 sites: live timing noise on top of the new buckets.

Single-site swings of 15+ points that re-crawl differently (e.g. aliexpress.com −38, where the 3.0 crawl got a bot-challenge page) are crawl variance rather than rubric change; the post-cutover rescore re-crawls every site.
