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

## 3.1 — 2026-10-16

Minor. Detection and accuracy fixes found by self-auditing w2agent.dev. No check id, weight, category or tracked status changes, so the major row of the rules does not apply, and nothing is added or retired. Each fix changes pass rates without changing what its check is meant to measure, which is the minor row. `allChecks` stays at 57, of which 7 are tracked, read from the registry. Every scored weight, every category intra-weight sum and `CATEGORY_CONFIG` are as in 3.0, so the delta can be attributed to the detection changes alone.

The methodology spec is revised to v1.1 to match (same filename, `docs/spec/agent-readiness-spec-v1.0.md`).

### Changed checks

All weights are unchanged.

| Check | Category | Weight | Action | Rationale (old → new) | Expected direction |
|-------|----------|--------|--------|-----------------------|--------------------|
| `answer-first` | content-quality | 1.5 | fix (detection) | First 500 chars of all body text, including script and JSON-LD placed in `<body>` → first 500 chars of visible text | Up where body-placed JSON-LD or a script filled the window; down where the window held only script |
| `token-efficiency` | content-quality | 1.0 | fix (detection) | Ratio of all body text → ratio of visible text to HTML length | Down on script-heavy pages |
| `content-length` | content-quality | 1.0 | fix (detection) | Words in all body text → words in visible text | Down on script-heavy and SPA pages; unchanged on static HTML |
| `faq-content` | content-quality | 0.5 | fix (detection) | `?` and "frequently asked" matched anywhere in body text → in visible text. The `details`, `dt` and `FAQPage` indicators are unchanged | Down, rarely, where a script supplied the signal |
| `citation-readiness` | content-quality | 1.0 | fix (detection) | Number, quote, reference-word and `by ` patterns matched in all body text → in visible text. `blockquote` and `rel="author"` still read the DOM | Down where scripts supplied the matches |
| `no-js-dependency` | technical | 1.0 | fix (detection) | Word thresholds (50 / 100) and the SPA-shell text-to-script ratio used all body text → visible words plus `noscript` words (the no-JS view) | Down on JS-heavy pages: script text no longer counts, so more fall under the thresholds and look like a shell. A page whose real content sits in `noscript` is not affected |
| `well-known-ucp` | agent-protocols | 0.5 | fix (applicability) | Applies only on ecommerce sites. Ecommerce detection matched platform names and "add to cart" as raw-HTML substrings and prose → markup-bound markers and commerce controls (see below). Non-store pages stop being detected as ecommerce | A failing UCP result becomes N/A on sites that were misdetected: Agent Protocols up. A real store whose only markers were prose now fails detection and gets the same N/A |
| `ecommerce-product-schema` (2), `ecommerce-gtin-valid` (1), `ecommerce-checkout-accessible` (1.5) | structured-data, bot-accessibility | as shown | fix (applicability) | Site-type checks added only on ecommerce detection. They stop running on misdetected sites and, when the detection moves, local-business can win instead | Mixed: on misdetected sites they mostly skipped or failed, so Structured Data and Bot Accessibility move up; they drop out of the denominators |
| `nextjs-static-generation` | technical | 1.0 | fix (detection) | Pass if any page had a cache HIT or `__NEXT_DATA__` and no page had `no-cache` or `private` → per page: dynamic = `private` or `no-store`, `gssp` or `gip` true unless `nextExport` is true (a static export exempts every flag), `appGip` true without `gsp` or `nextExport`; flags are read only at the top level of the parsed `__NEXT_DATA__` JSON; static = `x-nextjs-prerender`, cache HIT / STALE / PRERENDER / REVALIDATED, `s-maxage` or `public`, `gsp` / `nextExport` / `autoExport` true; dynamic wins. Pass (100) when at least half of the pages with evidence are static, else partial 60 | Up for mostly static sites with one dynamic page, App Router prerendered sites and static exports. Down for Pages Router SSR sites that passed on a bare `__NEXT_DATA__`. Mostly dynamic sites stay at 60 |
| `developer-portal` | agent-auth | 2 | fix (detection) | First 2xx on a portal path or docs subdomain → first 2xx whose `content-type` contains `html` or is missing. A JSON, YAML, XML or plain-text reply is a machine endpoint | Down where only a JSON index answered (thin partial to fail). Up where an HTML docs page was shadowed by an earlier JSON path |
| `agent-auth-docs` | agent-auth | 2 | cascade | Reads portal text, so it follows the portal change | Either way; gains signal when the real HTML page is found |
| `scoped-permissions` | agent-auth | 1.5 | cascade | Same | Same |
| `pkce-s256` | agent-auth | 1.5 | cascade | Documentation fallback (partial 50) reads portal text | Same. The authorization-server path is unchanged |

`webmcp-imperative` (tracked, weight 0) also changes: its inline scan skips data payloads and Next.js flight data, so a site that only quoted `modelContext` in prose or JSON goes from pass to skip. It carries no weight, so no score moves.

### Engine-level changes

| Change | Effect |
|--------|--------|
| Visible text | `text`, `wordCount` and `textLength` come from the body DOM with `script`, `style`, `noscript` and `template` subtrees removed. Content checks read what a rendering browser shows, so `noscript` (mostly "enable JavaScript" banners and tracking pixels) is excluded. `no-js-dependency` measures the no-JS view: the parser also exposes `noscriptWordCount` (markup stripped) and that check adds it to the visible words, so a real fallback body in `noscript` still counts there. The shared DOM is untouched, so JSON-LD, `blockquote`, `time[datetime]` and WebMCP scans are unaffected |
| `isCodeScript` | An inline script is code only if its `type` is absent or a JavaScript type (parameters and a Rocket Loader hex prefix are stripped; `text/rocketscript` and `text/partytown` count as code) and its content does not start with `self.__next_f.push(`. Non-JS types (`application/json`, `ld+json`, `importmap`, `speculationrules`, other `text/x-*`) and Next.js flight data, which serializes page prose, are data. Used by `webmcp-imperative` and ecommerce platform markers |
| Local-business detection | The booking-platform (0.6), map-embed (0.5) and business-hours (0.5) signals matched raw-HTML substrings, so a page that names `calendly.com` or `resy.com` in prose (the methodology page) was detected as local-business → booking hosts in `iframe[src]`, `script[src]`, `a[href]` (and an `opentable` element id), the map embed in `iframe[src]` or `a[href]`, and hours text outside `script` and `style`. The OpenTable match is now case-insensitive. Site type only; no check or weight changes |
| Ecommerce detection | Platform markers (weight 0.8, labels unchanged) are bound to markup: Shopify, BigCommerce and Woo asset URLs in `script[src]`, `link[href]` (BigCommerce also `img[src]`, host `cdn<N>.bigcommerce.com`); a `woocommerce*` class on `<body>`; `type="text/x-magento-init"`, `data-mage-init`; `wc-ajax=` in `script[src]`, `link[href]`, `a[href]` and `form[action]`; code tokens (`Shopify.theme =`, `Mage.Cookies`) only in code scripts. The cart signal (0.3) needs a form button (inside the form or tied to it by the `form` attribute) or a link to `/cart` or `/checkout`. Other signals, weights and the 0.5 confidence floor are unchanged. Spec §6.10 has the full list |

### Not changed

- `/.well-known/mcp.json` was considered as a discovery path and not added. 3.0 retired it. It was the early path in MCP SEP-1649, which is a draft; its continuation (unmerged PR #2127) uses `/.well-known/mcp/server-card.json`. Spec §7.1 forbids probing retired paths, and criteria are frozen within a cycle (§7.2). Re-adding it is a major-bump decision. The evidence is in the run handoff, `docs/handoff/2026-10-16-audit-detection-fixes.md`, under "Rejected".
- The `pkce-s256` and `oauth-discovery` applicability issue (a site with no OAuth surface is still measured) is out of scope for 3.1 and unchanged.
- `edge-agent-access` is not promoted. The 3.0 tracked-additions table names promotion as a 3.1 decision; this release does not take it, and the check stays tracked at weight 0.
- Thresholds in `technical.ts` and `content-quality.ts` are not retuned. Only their text input changes.

The minor call for `nextjs-static-generation` is explicit: the pass rule moved from "no sampled page dynamic" to "at least half of evidenced pages static". This is judged a detection fix, because the check's question (does the site use static generation) is unchanged and the 100/60 shape is kept.

### Expected median delta

- Content sites with body-placed JSON-LD (common on Next.js): answer-first **up**.
- JS-heavy and SPA pages: `content-length`, `token-efficiency`, `citation-readiness` and `no-js-dependency` **down**. This is the more accurate result, since the old text was script.
- Non-store content and SaaS sites that were misdetected as ecommerce: `well-known-ucp` N/A, so Agent Protocols **up**; the three ecommerce checks drop out. A misdetected site can now fall to no site type rather than to local-business (the local-business markers are markup-bound too), which is what happens on w2agent.dev.
- Next.js sites with mixed static and dynamic pages: `nextjs-static-generation` **up**. Other sites do not run this check.
- Sites with a JSON `/api` index and an HTML docs page: developer-portal content and the three dependent checks **change**, up when the HTML page is now found.
- Overall median: expected small, because the content checks move in both directions and the adapter and portal changes touch only some sites. This is reasoning, not a measurement.

### Measured delta

Not yet run. This run had no production access. Before cutover the owner must run the dual-run (`scripts/rescore-all.ts --rubric-compare` in the platform repo, as for 3.0) and record the result here. Until then, 3.1 carries only the expected direction above. No numbers are given because none were measured.

## 3.0 — 2026-09-15

Major. `allChecks` 63 → 54 at cutover, of which 4 were tracked. `CATEGORY_CONFIG` is unchanged, so the delta can be attributed to check changes alone. Tracked checks added since cutover (see "3.0 tracked additions" below) bring `allChecks` to 57, of which 7 are tracked; they carry weight 0, so neither the sums below nor the measured delta move.

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
| `agent-skills-index` | agent-discovery | 0 T | 2026-10-14 | Validates `/.well-known/agent-skills/index.json` from the Agent Skills Discovery RFC v0.2.0. The RFC is a Cloudflare-led draft, not governed by the IETF or a foundation, and v0.1 to v0.2 already renamed the path and replaced the schema, so it has not been stable for 2 cycles (§7 criteria (a) and (b)). Tracked at weight 0, no version bump. Absent index = skip; the check reads the crawler's well-known fetch and never fetches a skill URL |

**2026-09-17 — `edge-agent-access` inputs widened, no version bump.** The probed set is now derived from the registry (`crawler.ts`) instead of a hardcoded three, so the homepage is fetched under all six documented user agents that publish a UA string: the three that back a scored `reach-*` check first, pinned in their historical positions and keys (ChatGPT-User, Perplexity-User, Google-Agent), then every other `purpose: "user"` token with a `uaString` in registry order (Amzn-User, MistralAI-User, Meta-ExternalFetcher). Extra key pages stay at the first three (`EDGE_EXTRA_PAGE_TOKENS`), because the pass runs on a `min(timeout*3, 15s)` wall-clock budget and six UAs on every page would buy `unmeasured` results rather than coverage. That forced the completeness rule to become per page — each comparable page judged against the tokens probed *on it* — plus an explicit gate that no probed token went unanswered everywhere, which the old union rule gave for free. `notProbed` is now Claude-User alone; a token probed on the homepage but not on an extra page is reported per page in `details` as `<url>.notProbed: … (extra-pages-only)`.

**Why the scored probe positions are pinned.** The homepage agent loop is budget-gated *per fetch*, and `reach-openai-user-agent`, `reach-perplexity-user-agent` and `reach-google-user-agent` are scored at weight 0.5 each. A token's position in that queue therefore decides whether its check is measured at all on a slow site: had the three simply been reordered into registry order, a site exhausting the budget after two fetches would have moved `reach-perplexity` from `pass/100` to `error/unmeasured` and `reach-google` the other way, on identical input. That is a scored move, and it is exactly what the minor-bump rule exists to catch. Pinning the three by position **and** by key is what keeps this change score-neutral; the derived tail queues behind them and can only cost itself. Keys are literals for the same reason: derived from `vendor`, a registry typo (`"OpenAI "`) would store the result under `"openai "` and zero a scored check with no throw anywhere.

No bump is owed, argued from the rules themselves. The major row covers promotion, demotion and weight changes, and none happened: the check stays `weight: 0` and `tracked: true`, excluded from category renormalization, so it appears in no denominator on any site. The minor row — "a detection fix that changes pass rates" — does apply to `edge-agent-access`, whose pass rate genuinely moves (per-page completeness plus the unanswered gate). It carries no bump here because the rule's purpose, stated in the tracked-arrival row above, is that a *score* move must be attributable to a rubric version, and a weight-0 tracked check feeds no score. The scored checks whose pass rates the same rule protects — the three `reach-*` — are unchanged by construction, which is what the pinning above buys and what the byte-identity check below verifies. Expected median delta: **0**. No measured delta is owed.

**Verified, not asserted:** the three `reach-*` `CheckResult`s were captured over seven fixture scenarios (all-200, mixed 403/empty-200/200, a 500, a challenge to everyone, a 402, budget exhaustion, transport failure everywhere) before the change and re-captured after it; the two dumps are byte-identical (`shasum aac59539fe21fb0e79f0cd683a29c4ac4961a0d2`). Budget exhaustion *between* agent fetches — the case that discriminates the orders — is pinned separately in `tests/edge-probe.test.ts`.

Observable consequences at the next rescore, none of them a score change:

- More `edge-agent-access` results may read `unmeasured`, from two independent causes: the pass now runs 12 agent fetches per site (6 on the homepage, 3 on each of up to 2 extra pages) instead of 9, against the same budget, so `budget-skipped` is likelier; and the unanswered gate fires when a probed token has no comparable page at all — a homepage whose own control is non-comparable leaves Amzn-User, MistralAI-User and Meta-ExternalFetcher with no evidence anywhere, where the pre-change code could still report `consistent` from the extra pages.
- **The population this can move is the ~1225 `ok` sites, and the size of the shift is currently unmeasured.** §5's owner re-run covers the failed statuses only (`--status=blocked,unknown_failure,timeout,unreachable,rate_limited`), so it will not size this: a site can flip `edge-agent-access` from `consistent` to `unmeasured` while its `audit_status` stays `ok`. Sizing it needs a rescore of the `ok` population (or a dry-run comparison over a sample of it) and a before/after count of the tracked check's outcomes. No claim is made here that the shift is small.
- `details` grows: three more `<url>.<token>:` lines on the homepage, and an `<url>.notProbed: … (extra-pages-only)` line on each extra page that carries a probe set. `details` is **not** summarised out of the stored report: the DB column `audit_history.check_results` holds `{status, score}` only, but the platform writes the full report JSON to blob storage (`lib/audit-storage.ts`), so `details` is readable there and in the rendered report — just not in SQL.
- The `EdgeEvidence` payload attached to a failed audit's `AuditError` carries six agents in probe order, and its `notProbed` shrinks to Claude-User.

**2026-09-17 — DataDome and PerimeterX challenge fingerprints, no version bump.** `CHALLENGE_FINGERPRINTS` gains two body entries written from dated live captures: DataDome `geo.captcha-delivery.com` and PerimeterX `id="px-captcha"`, each with a negative control that must not match. Body fingerprints apply only on a challenge status (403/429/503) or a `cf-mitigated` header and read only the first `CHALLENGE_BODY_PREFIX_BYTES` (4 KB), so the PerimeterX entry is dormant today: both captured markers sit past that prefix. Akamai and Imperva get no entry, because their captures were hard blocks, not challenges. Expected median delta: **0**. A matching homepage moves from `unknown_failure` to `blocked`, and both throw before any score is computed; the multi-UA pass feeds the tracked, weight-0 `edge-agent-access`. The one path that can touch a scored input is the shared fetcher, which already stops retrying a matched 429/503 on any fetch (Phase 2); the two new patterns extend that path, with the same result as retries exhausting against a persistent challenge.

**2026-09-17 — methodology spec v1.0 published, no version bump.** [`docs/spec/agent-readiness-spec-v1.0.md`](spec/agent-readiness-spec-v1.0.md) documents rubric 3.0 as the engine runs it: the scoring algorithm, audit-level failures, the N/A cascade, every check's detection rule, evidence boundary, maturity tier and weight rationale, and the emerging-standards policy. The spec text is licensed CC BY 4.0 ([`docs/spec/LICENSE`](spec/LICENSE)); the code keeps the MIT license. Prose only: no check, weight or detection changed. Expected median delta: **0**. Weights remain set by rationale; outcome calibration (P4-2) is pending, and any weight it changes ships as a bump logged here.

### Planned in the improvement plan but not in 3.0

`machine-file-linked` (P3-1), graded `openapi-spec` (P3-2), `ai-catalog-manifest` (P3-3), `acp-discovery` (P3-5). None of them is in `allChecks`. `agent-skills-index` (P3-4) shipped as a tracked addition (see the table above). Bot Accessibility stays at 7 scored weight, not 9, and Agent Discovery is 3, not 4 — `usage-preference-declared`, `edge-agent-access` and `agent-skills-index` shipped as tracked additions above, and weight 0 leaves those sums untouched.

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
