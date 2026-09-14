# Rubric Changelog

`RUBRIC_VERSION` is exported from `w2agent-core` and stamped on every `AuditReport.rubricVersion`. Check ids, categories and weights below are read from `allChecks`; per-check detail lives in [CHECKS.md](CHECKS.md).

## Versioning rules

| Bump | When |
|------|------|
| major | The check set changes (add, retire, merge, move to tracked) or any weight changes |
| minor | A detection fix that changes pass rates without changing what the check is meant to measure |
| patch | Messages or `fixSnippet` text only |

- A check is scored only if its standard is governed (IANA / RFC / IETF WG / foundation, or vendor-documented HTTP behaviour), its path and schema have been stable for 2 or more rubric cycles, and an applicability gate keeps it from penalising sites it doesn't address. Otherwise it is **tracked**: reported with weight 0 and never scored.
- Checks are promoted or demoted only at a version bump, and every bump is logged here. A newly promoted check (tracked → scored, or a new signal) enters at weight 0.5 or less for one cycle. A merge that measures facts already scored by the checks it replaces is not a promotion. The plan's policy section doesn't cover merges; the rubric-change table set their weights (`oauth-discovery` 3 from three 1.5 checks, `mcp-auth` 1.5 from two 1.0 checks).
- Every entry states the expected median score delta. Before cutover, it also records the measured delta.

## 3.0 — 2026-09-14

Major. `allChecks` 63 → 54, of which 4 are tracked. `CATEGORY_CONFIG` is unchanged, so the delta can be attributed to check changes alone.

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

### Planned in the improvement plan but not in 3.0

`edge-agent-access` (P2-2), `machine-file-linked` (P3-1), graded `openapi-spec` (P3-2), `usage-preference-declared` (P2-3), `ai-catalog-manifest` (P3-3), `agent-skills-index` (P3-4), `acp-discovery` (P3-5). None of them is in `allChecks`. Bot Accessibility therefore stays at 7, not 9, and Agent Discovery is 3, not 4.

### Expected median delta

- API and dev-tool sites: **up**. OAuth discovery now follows real chains and the MCP probe finds real servers, so the Auth & Access bucket activates.
- Content sites: **roughly flat**.
- Sites that passed on catch-all 200s: **down**.
- Agent Discovery (8 → 3) and Agent Protocols (11.25 → 6.0/6.5) now rest on fewer checks, so single checks swing those category scores more.

### Measured delta

**Pending: owner-run dual-run.** From the platform repo: `pnpm tsx --env-file=.env.prod scripts/rescore-all.ts --rubric-compare --leaderboard-only`. It runs the frozen 2.0 engine (`vendor/frozen/w2agent-core-rubric-2.0.tgz`) and the 3.0 engine side by side. Record the per-category median delta by site type here before cutover. Per D-4: run it privately, publish the delta here, then cut over once.
