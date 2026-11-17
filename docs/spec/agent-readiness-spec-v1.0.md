# Agent-Readiness Score — Methodology Specification

> Version 1.1. Mechanical catalog of every check, every weight, the scoring algorithm, the NA cascade, audit-level failure handling, the emerging-standards policy, **and per-check rationale** (how each check detects its signal, its evidence boundary, the maturity of the standard it measures, why it earns its weight, where it came from, and what it doesn't catch).

| Field | Value |
|---|---|
| Spec version | 1.1 |
| Engine version | `RUBRIC_VERSION = "3.1"` in `packages/core/src/audit/types.ts`, exported from the `w2agent-core` package index |
| Status | Published 2026-09-17 (v1.0) · revised 2026-10-16 (v1.1, rubric 3.1) |
| Created | 2026-05-07 (v0.1) · rationale layer 2026-05-08 (v0.2) · rubric 3.0 update 2026-09-14 (v1.0-draft) · published 2026-09-17 (v1.0) · rubric 3.1 revision 2026-10-16 (v1.1) |
| Implements | `w2agent-core` 0.2.0 audit engine, rubric 3.1 |
| Canonical copy | `docs/spec/agent-readiness-spec-v1.0.md` in the w2agent OSS repo ([github.com/interskh/w2agent](https://github.com/interskh/w2agent/blob/main/docs/spec/agent-readiness-spec-v1.0.md)); the w2agent platform renders a copy at `/methodology`, kept byte-identical by the platform's `scripts/sync-spec.ts` (`--check` exits non-zero when the copies differ) |
| License | Spec text: Creative Commons Attribution 4.0 International (CC BY 4.0), see [`docs/spec/LICENSE`](https://github.com/interskh/w2agent/blob/main/docs/spec/LICENSE). Engine code keeps the repo's own license |
| Rubric changelog | `docs/RUBRIC-CHANGELOG.md` in the OSS repo: every check, weight and detection change per rubric version |
| Calibration | **Pending.** Weights and grade thresholds are set by the rationale recorded per check, not by measured agent task success. Outcome calibration (improvement plan item P4-2) has not reported. When it does, weights may change, but only through a rubric version bump logged in `RUBRIC-CHANGELOG.md` (§2) |

---

## 1. Purpose & Scope

**The score this spec defines:** a 0–100 number quantifying how well a website serves the needs of autonomous AI agents — discovery, comprehension, structured action, and authenticated access.

**What it covers:** static-HTML measurement of public-facing surfaces (homepage + crawled pages, well-known endpoints, developer/key documentation). 7 categories, 57 core checks (50 scored, 7 tracked at weight 0), 1 cascade rule set. Two further sets are added to an audit only when the engine detects a site type (6 checks, §6.10) or a site platform (19 checks, §6.11); when added they are scored like core checks. Output: overall score (0–100), letter grade (A–F), per-category breakdown, per-check pass/partial/fail/skip/error status — or, when the homepage cannot be measured at all, a typed failure and no score (§3.5).

**What it does NOT cover (yet):**
- JavaScript-rendered content. Pages whose meaningful prose is hydrated client-side return only their static shell. *This is a known credibility gap, tracked as F3 in the credibility roadmap.*
- Authenticated/paywalled API surfaces. Stripe's actual API at `api.stripe.com` requires keys; we measure only what's public.
- Outcome-correlated agent task success. The score measures **artifact and surface signals**; whether those translate to higher real-world agent success rate is a separate question (credibility roadmap F4, improvement plan P4-2; not yet reported).
- Verified agent traffic. Requests sent under an agent's user-agent string come from w2agent's network, not the vendor's, so they show how a site treats the claim, not how it treats the real agent (§6.1 `edge-agent-access`).

**Reproducing a result.** Every check below states its detection rule and evidence boundary against the inputs defined in §6.0 (crawl, metadata probes, fetch behaviour). Given the same responses from a site, the rules in §3–§6 produce the same score; live re-crawls differ when the site answers differently (timing, bot management, content changes).

## 2. Versioning

The implemented rubric is identified by a single string constant `RUBRIC_VERSION`, defined in `packages/core/src/audit/types.ts` and exported from the `w2agent-core` package index. Current value: **`"3.1"`**. The w2agent platform (a separate, private repo) imports it (`lib/rubric.ts`) and keeps no copy of its own.

Every score persisted by the platform in its `audit_history` table is tagged with the rubric version that produced it. Successful-audit rows written since platform migration `0029` also store each check's `{ status, score }` in `check_results`. This is the basis for "are we improving?" — comparisons are valid only when the rubric version is held constant. A comparison across versions runs both engines on the same sites (platform `scripts/rescore-all.ts --rubric-compare`).

**Bump rule (normative).** Any change that alters numeric scores for the same input MUST bump `RUBRIC_VERSION`:

| Bump | When |
|---|---|
| major | The **scored** check set changes (add, retire, merge, move to or from tracked) or any weight changes |
| minor | A detection fix that changes pass rates without changing what the check is meant to measure |
| patch | Messages or `fixSnippet` text only |

Every bump MUST get an entry in the OSS repo's `docs/RUBRIC-CHANGELOG.md` that lists each changed check (old and new weight, action, rationale) and states the expected median score delta; before a cutover the entry also records the measured delta. The 3.0 entry is the reference for everything in §3, §5 and §6 that differs from 2.0; the 3.1 entry lists the detection fixes since.

Adding a check at weight 0 with `tracked: true` does not bump the version: it is excluded from category renormalization, so it moves no score. It is logged under the current version's "tracked additions" heading in `RUBRIC-CHANGELOG.md` and becomes a version event when it is promoted (§7.2). The same holds for a detection change confined to a tracked check.

This spec carries an independent version string (`Spec version 1.1`) since the prose may iterate ahead of or behind engine changes. Prose-only spec edits do not bump `RUBRIC_VERSION`. Changes to the spec are listed in §9.

**Weights are not yet calibrated (normative disclosure).** Every weight and grade threshold in this version is set by the rationale recorded in §3.4, §4 and §6, not by measured agent task success. Outcome calibration (improvement plan P4-2) is pending. When its results change a weight or threshold, the change ships as a rubric version bump with a `RUBRIC-CHANGELOG.md` entry, never as a silent edit.

## 3. Scoring Algorithm

### 3.1 Per-check status

Every check returns one of five statuses:

| Status | Meaning | Score | Counts in category? |
|---|---|---|---|
| `pass` | Evidence meets the check's criteria | 100, or a graded pass score (e.g. `mcp-discovery` 75, `response-time` 70) | Yes |
| `partial` | Evidence is weakly present | 0 < score < 100 | Yes |
| `fail` | Evidence absent or insufficient | 0 | Yes |
| `skip` | Not applicable to this site (NA cascade, or the check's own applicability test) | n/a | **No** |
| `error` | Unmeasured: the audit could not observe the evidence (e.g. the crawler's time budget ran out, or robots.txt stayed rate-limited through every retry). Not a finding about the site | n/a | **No** |

`skip` is the critical lever: a skipped check is excluded from both numerator and denominator. This is what allows a site to legitimately not be measured against an emerging-standard check that doesn't apply to them, without dragging the score down.

`error` is excluded the same way, and also from impact estimates and `topIssues`. The ids of non-tracked `error` results are listed in the `unmeasured-checks` report warning.

A `skip` result carries a score (usually 0; `forms-structured`, `shopify-product-schema` and `docusaurus-versioned-docs` return 100), but because skipped results are excluded from every computation below, that number is never used.

`error` is a per-check status. It is distinct from an audit-level failure (§3.5), where the homepage itself cannot be measured and no check result, category score or overall score is produced at all.

**Tracked checks.** A check registered with `tracked: true` has weight 0, and its result carries `tracked: true`. Tracked results are reported but excluded from category renormalization (§3.2), from `topIssues` and impact estimates, and from report warnings (warnings are computed over non-tracked results only). The platform renders them under a separate "Tracked (not scored)" heading. §6.8 lists them; §7 defines when a check is tracked.

Implementation: `computeCategoryScore`, `computeTopIssues`, `estimateImpact` and `computeWarnings` in `packages/core/src/audit/engine.ts`.

### 3.2 Category score

```
applicable_checks = [c for c in category.checks
                     if c.status not in ("skip", "error") and not c.tracked]
totalWeight = sum(c.weight for c in applicable_checks)
score = sum(c.score * c.weight / totalWeight for c in applicable_checks)
```

If `applicable_checks` is empty or `totalWeight` is 0, the category score is `null` (rendered as N/A). The category score is rounded to an integer, and §3.3 uses the rounded value.

Implementation: `computeCategoryScore` in `packages/core/src/audit/engine.ts`.

### 3.3 Overall score

```
scored_categories = [c for c in categories if c.score is not None]
overall = sum(cat.score * cat.weight / sum(scored_weight) for cat in scored_categories)
```

The report's `overallScore` is the rounded result; the grade (§3.4) is computed from the unrounded value.

Implementation: `computeOverallScore` in `packages/core/src/audit/engine.ts`.

### 3.4 Grade thresholds

| Score | Grade |
|---|---|
| ≥ 75 | A |
| ≥ 60 | B |
| ≥ 45 | C |
| ≥ 30 | D |
| < 30 | F |

The thresholds apply to the **unrounded** overall score (§3.3), while the report prints the rounded one. A site at 74.6 is therefore graded B and printed as `75/100 (B)`; every grade band edge has this half-point overlap.

These thresholds are **uncalibrated against real-world agent-task success**. They represent intuition, not data. Outcome calibration (P4-2) is pending; any change ships as a rubric bump (§2).

Implementation: `computeGrade` in `packages/core/src/audit/engine.ts`.

### 3.5 Audit-level failures: unscored (normative)

Before any check runs, the engine classifies the **homepage** response — the final response after redirects and retries. When the homepage cannot be measured, the audit MUST NOT produce a score or grade: `runAudit` throws an `AuditError` whose `kind` is one of six values, and no check results exist. A failed audit is not a score of 0 and MUST NOT be presented as one.

| `kind` | Homepage outcome |
|---|---|
| `blocked` | A response matched a challenge fingerprint (below). A matched challenge is not retried |
| `auth_gated` | HTTP 401 with a `WWW-Authenticate` header |
| `rate_limited` | HTTP 429 through every retry |
| `timeout` | The request timed out (`AbortError`, `TimeoutError`, `ETIMEDOUT`, `UND_ERR_HEADERS_TIMEOUT`) through every retry |
| `unreachable` | No response: DNS, connection refused or reset, TLS failure, or any other network error |
| `unknown_failure` | HTTP 403 with no challenge fingerprint, or HTTP 503 through every retry with no challenge fingerprint |

Every other homepage status — 2xx, a terminal 3xx, 404, and 5xx other than 503 — is scored normally (a 404 or 500 homepage lowers `status-codes` and the content checks instead). DNS and TLS failures are deliberately not split out: the distinction matters to an operator reading logs, not to a reader of the score.

**Fetch and retry behaviour.** The crawler's page fetch retries a 429 or 503 up to 3 times with 500 / 1000 / 2000 ms backoff (a 429's `Retry-After` of up to 30 s replaces the backoff), and retries a timeout the same way; network errors are not retried. Before retrying a 429 or 503, the response is fingerprinted, and a challenge stops the retries.

**Challenge fingerprints.** `detectChallenge(status, headers, bodyPrefix)` in `packages/core/src/audit/shared/challenge.ts` reads a table in which every entry cites a vendor document or a dated live capture:

| Vendor | Kind | Pattern | Applies |
|---|---|---|---|
| Cloudflare | header | `cf-mitigated: challenge` | any status |
| AWS WAF | header | `x-amzn-waf-action: challenge` or `captcha` | any status |
| Cloudflare | body | `/cdn-cgi/challenge-platform/h/` | challenge statuses only |
| Cloudflare | body | `window._cf_chl_opt` | challenge statuses only |
| Cloudflare | body | `challenges.cloudflare.com/turnstile/v0/api.js` | challenge statuses only |
| unknown | body | `js.hcaptcha.com/1/api.js` | challenge statuses only |
| unknown | body | `www.google.com/recaptcha/api.js` | challenge statuses only |
| DataDome | body | `geo.captcha-delivery.com` | challenge statuses only |
| PerimeterX | body | `id="px-captcha"` | challenge statuses only |
| Cloudflare | title | `<title>Just a moment...` together with a `cf-ray` header | challenge statuses only |

Header patterns match case-insensitively on any response. Body and title patterns are read only when the status is 403, 429 or 503 or a `cf-mitigated` header is present, and only over the first 4 KB of the body (`CHALLENGE_BODY_PREFIX_BYTES`). So a 200 page that embeds a signup CAPTCHA is not a challenge, and a Cloudflare 403 carrying only bot-detection instrumentation (the `/cdn-cgi/challenge-platform/` path without `/h/`) is not one either. Measured challenge markers often sit beyond 4 KB, so body patterns supplement the header patterns rather than replace them; the PerimeterX entry is kept although its captured marker sits past the prefix. Akamai and Imperva have no entry: the captures showed hard blocks, not challenges, and a hard block is classified `unknown_failure`.

**Edge evidence on failure.** When the multi-UA pass (§6.1, probe set) ran, the thrown error carries a summary of how the homepage answered the agent user-agents (`AuditErrorEvidence.edge`): a verdict of `all-blocked` (no agent with an observed status was served), `agents-allowed` (every such agent was served; the control fetch is not consulted, so a homepage that failed transiently for the page fetch but answered the control and every agent with 200 also reads `agents-allowed`, and the verdict does not show the declared crawler was refused), `mixed` or `unknown` (no agent produced an observed status). An agent is served when its observed status is 2xx and the response did not fingerprint as a challenge. The verdict does not separate policy from outage (a site returning 5xx to everyone reads `all-blocked`), and the requests are unverified, so it is an internal planning signal: it is not scored and not published.

**Platform presentation.** The w2agent platform records the `kind` as the audit status (`ok` for a scored audit; `error` for any other exception; `not_attempted` before a first audit) and shows a site's public score only when its latest audit status is `ok`. Failed statuses carry a label (Anti-bot block, Unreachable, Auth-gated, Rate-limited, Timeout, Couldn't tell) and are listed as unmeasured, never ranked.

Implementation: `classifyHomepage` and `fetchFailureKind` in `packages/core/src/audit/errors.ts`; `retryableFetch` in `packages/core/src/shared/fetcher.ts`; `throwIfUnscorable` in `engine.ts`; platform `lib/audit-status.ts`.

## 4. Categories

Seven categories, with weights summing to 1.00. Source: `CATEGORY_CONFIG` in `packages/core/src/audit/types.ts`.

| ID | Name | Weight | # Checks (incl. tracked) | Total intra-category weight (scored checks) |
|---|---|---:|---:|---:|
| `bot-accessibility` | Bot Accessibility | 0.15 | 8 (2 tracked) | 7.0 |
| `structured-data` | Structured Data | 0.15 | 7 | 7.0 |
| `content-quality` | Content Quality | 0.15 | 8 | 7.5 |
| `agent-discovery` | Agent Discovery | 0.12 | 7 (2 tracked) | 3.0 |
| `agent-protocols` | Agent Protocols | 0.13 | 10 (2 tracked) | 6.5 on ecommerce sites and wherever `well-known-ucp` passes; 6.0 when it becomes N/A |
| `technical` | Technical Foundations | 0.10 | 6 | 6.0 |
| `agent-auth` | Auth & Access | 0.20 | 11 (1 tracked) | 16.5, plus the 0.5 `cimd-support` bonus, which counts only when it passes |

These sums are registry maxima over the 57 core checks; on a given site the NA cascade and `skip`/`error` results shrink the denominator further, and detected site-type (§6.10) or platform (§6.11) checks add to it. `CATEGORY_CONFIG` is unchanged from rubric 2.0, so the 2.0 → 3.0 delta comes from check changes alone.

**Why these weights.** Auth & Access is the heaviest category (0.20) on purpose: authenticated action, not reading, is treated as the highest-leverage signal for whether an agent can *do* something on a site. The three reading-oriented categories (reachability, structure, content) share 0.15 each, the two agent-era categories share 0.25 between them, and web hygiene is 0.10 because it is a precondition more than an agent signal. The allocation is rationale, not measurement (§2): the known risk is that a 0.20 auth bucket over-weights emerging standards (RFC 9728, MCP) against mature platforms that have not adopted them. The NA cascade (§5) is the partial mitigation, and category weights are to be revisited with P4-2 calibration data.

## 5. NA Cascade Rules

Implementation: `applyNaCascade` in `packages/core/src/audit/engine.ts`.

The cascade runs after every check has returned, in the order below. A dependency counts as unmet when that check's result is `fail` or `skip`, or when there is no result for it. There are two kinds of rule:

- **Non-sentinel** (default): when the condition holds, a result that is not `pass` or `partial` becomes `skip`. `pass` and `partial` results are kept.
- **Sentinel**: when the condition holds, the result becomes `skip` whatever its status, and its score is set to 0.

| Check | Becomes skip when | Kind |
|---|---|---|
| `openapi-spec` | `public-api` is fail/skip | non-sentinel |
| `developer-portal` | `public-api` is fail/skip | non-sentinel |
| `agent-auth-docs` | `developer-portal` is fail/skip | non-sentinel |
| `oauth-discovery` | `public-api` is fail/skip AND no MCP endpoint was discovered (`metadata.mcpEndpoint` unset) | non-sentinel |
| `scoped-permissions` | `developer-portal` is fail/skip | non-sentinel |
| `pkce-s256` | BOTH `oauth-discovery` AND `developer-portal` are fail/skip | non-sentinel |
| `mcp-auth` | no MCP endpoint was discovered (`metadata.mcpEndpoint` unset) | **sentinel** |
| `api-catalog-rfc9727` | `public-api` is fail/skip | non-sentinel |
| `well-known-ucp` | the site is not detected as `ecommerce` | non-sentinel: a valid profile on a store the detector missed keeps its pass |

Rules for checks retired in 3.0 are gone (§6.9); tracked checks have no cascade rule. Many checks also return `skip` on their own (for example `llms-txt-valid` with no llms.txt, `cimd-support` without a full OAuth chain); §6 states those per check.

**Why this structure.** Each rule encodes a "does not apply because" argument: a site with no public API has no OpenAPI contract, portal or API catalog to grade; a site with no developer portal has no auth docs or scopes to read; OAuth discovery applies to an API or an MCP endpoint, not a brochure site; PKCE can be read from either the resolved authorization server or the portal, so it is N/A only when both are absent; `mcp-auth` reads the MCP endpoint's 401 challenge, which does not exist without a discovered endpoint; UCP is a commerce protocol. Rules are non-sentinel by default so that a dependent check that finds real evidence keeps its credit even when its parent missed it (a detector false negative should not erase a positive finding). `mcp-auth` is the one sentinel because without an endpoint it has no input at all.

## 6. Check Catalog

Each check is identified by an `id`, has a numeric `weight` within its category, and a `severity` tag (`info` / `warning` / `error`) used for issue prioritization in the report (not for scoring).

Every check entry below carries these fields:
- **What it measures** — the detection rule: which input is read and the pass / partial / fail / skip / error thresholds
- **Evidence boundary** — what counts as evidence and what is deliberately not read
- **Maturity** — the maturity tier of the standard the check measures (M1–M4, or H for a heuristic with no external standard; defined in §7.1)
- **Why this check** and **Why weight N** — the rationale for the check and its weight
- **Provenance** — where the standard or convention comes from
- **Known limitations** — what the check does not catch

Weight `0 (tracked)` marks a tracked check (§3.1). Each category table lists every registered core check in that category, tracked ones included, so the rows match `allChecks` (57). §6.8 lists the tracked checks, §6.9 the ids retired in 3.0, §6.10 the site-type checks and §6.11 the platform checks.

### 6.0 Inputs every check reads

A check is a pure function of the crawled pages, the site metadata probed before the checks run, and (for a few checks) requests of its own. Reproducing a check means reproducing these inputs.

- **Declared crawler.** Page fetches, the robots.txt / sitemap / llms.txt / well-known / OpenAPI probes and the multi-UA control are sent with the user-agent `w2agent/0.1 (+https://w2agent.dev)`. The MCP endpoint probe and requests a check makes on its own (portal, API, OAuth, server-card, script and markdown probes) send no explicit user-agent, so the HTTP client's default applies, unless the check states otherwise. Every request and redirect hop can be refused by the caller's fetch allow-hook (the platform refuses private and metadata addresses); a refused request counts as no response.
- **Crawl profile.** The platform audits with `maxPages = 10` and a 10 s per-request timeout (`AUDIT_CRAWL_PROFILE`); the CLI default is 20 pages. The homepage is page 0. Further pages are selected from `/sitemap.xml` and homepage links, fetched with 3 in parallel and at least 200 ms between request starts (raised to robots.txt `Crawl-delay`, capped at 10 s). Pages with no response are dropped. When fewer than 3 pages result and a sitemap exists, up to 5 same-site sitemap URLs are added within a `min(timeout × 3, 15 s)` budget. "Pages" in §6 means this set.
- **Visible text.** Where a check reads page text (`answer-first`, `token-efficiency`, `content-length`, `faq-content`, `citation-readiness`, `no-js-dependency`), the text is the `<body>` text with every `script`, `style`, `noscript` and `template` subtree removed, whitespace collapsed. Words are whitespace-separated runs of it. Content checks read what a rendering browser shows, so `noscript` content, which is mostly "enable JavaScript" banners and tracking pixels, is excluded. `no-js-dependency` is the exception: it measures the no-JS view, so it adds the words of `noscript` content to the visible word count (§6.6). Each `noscript` body is re-parsed as an HTML fragment and read like visible text: character references are decoded and `template`, `script` and `style` content is skipped. Markup-based checks (JSON-LD, `blockquote`, `time[datetime]`, WebMCP forms) read the full DOM and are not affected. Developer-portal text (§6.7) is a separate extraction and is not visible text.
- **Inline code versus data.** A `<script>` is treated as code only when its `type` is absent or a JavaScript type (`text/javascript`, `application/javascript`, `module`, the `x-` and `ecmascript` variants, `text/rocketscript`, `text/partytown`), after media-type parameters and a leading hex prefix (Rocket Loader) are removed, and its content does not start with `self.__next_f.push(` (Next.js flight data, which serializes page prose). `application/json`, `application/ld+json`, `importmap`, `speculationrules` and other `text/x-*` types are data. Checks that look for tokens in inline scripts (`webmcp-imperative`, ecommerce platform detection) read code scripts only.
- **Page fetch.** Redirects are followed; the body is read up to a cap; 429 and 503 responses and timeouts are retried (§3.5). A page's `responseTime` is measured on this fetch.
- **Metadata probes** (`probeSiteMetadata` in `packages/core/src/audit/crawler.ts`), run once per audit:
  - `/robots.txt` and `/llms.txt` are credited only on HTTP 200 whose body is not an HTML document (a `text/html` body starting with `<`, or empty, counts as absent); `llms.txt` falls back to `docs.`, `developers.` and `developer.` prefixed to the audited host (a leading `www.` removed) in that order, so auditing `app.example.com` probes `docs.app.example.com`, not `docs.example.com`. The robots.txt status is kept for `ai-agent-access`.
  - `/sitemap.xml` is kept on any HTTP 200. robots.txt `Sitemap:` directives are not followed.
  - Well-known files: `agent-card.json`, `ucp`, `oauth-authorization-server`, `oauth-protected-resource`, `http-message-signatures-directory`, `api-catalog`, `ai-catalog.json`, `mcp/server-card.json`, `tdmrep.json`, under the catch-all rule below.
  - OpenAPI discovery (common spec paths plus homepage links), the MCP endpoint probe (§6.5 `mcp-discovery`) and the multi-UA pass (§6.1, probe set).

`ai-agent-access`, `edge-agent-access`, the `reach-*` checks and the site-type robots checks read these inputs only; other checks that make requests of their own state them.

**Evidence rule: catch-all and soft-404 responses (normative).** Before the checks run, the crawler requests a random-UUID path at the site root and one under `/.well-known/`. If either answers 2xx, the site is flagged catch-all (`metadata.catchAll`). A `/.well-known/*` file is credited only when it is served 200 with a JSON content-type (for `api-catalog` and `http-message-signatures-directory`, exactly their registered media types) and its body differs from the random `/.well-known/` control. robots.txt and llms.txt served as HTML documents count as absent. On a catch-all site, same-origin developer-portal and key-doc paths are not credited, same-origin MCP server-card and ai-catalog URLs are not fetched, and the report carries the `catch-all-responses` warning. Implementation: `probeSiteMetadata` in `packages/core/src/audit/crawler.ts` (flag and well-known guard); the portal, key-doc and server-card probes in `checks/agent-auth.ts` and `checks/discovery.ts`; the warning in `engine.ts`.

### 6.1 Bot Accessibility (category weight 0.15)

> The "can an agent reach this site at all?" tier. If these fail, nothing else matters.

| ID | Weight | Severity | Maturity | What it measures |
|---|---:|---|---|---|
| `robots-txt-exists` | 1.0 | warning | M1 | `/robots.txt` is fetchable as a text file |
| `ai-agent-access` | 2.0 | error | M1 | robots.txt does not block user-initiated AI agents or AI search fetchers at the root (training crawlers reported, not scored) |
| `sitemap-exists` | 1.5 | warning | M2 | `/sitemap.xml` answers 200 with a `<urlset` or `<sitemapindex` root |
| `response-time` | 1.0 | warning | M1 | Average response time over pages with a measured timing, bucketed |
| `content-negotiation` | 0.5 | info | M2 | Homepage and one docs page serve markdown via `Accept: text/markdown` or a `.md` twin URL |
| `status-codes` | 1.0 | error | M1 | Share of crawled pages that answered below HTTP 400 |
| `usage-preference-declared` | 0 (tracked) | info | M2–M3 | The site declares AI usage preferences (Content-Signal, Content-Usage, RSL License, TDMRep) |
| `edge-agent-access` | 0 (tracked) | error | M1 | The site's edge answers documented agent user-agents no worse than w2agent's declared crawler |

#### `robots-txt-exists` (weight 1.0, warning)

**What it measures.** `/robots.txt` is reachable and returns content. Binary.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** robots.txt is the universal protocol for site-owners to communicate crawl intent. A site without robots.txt isn't *forbidding* agents — but it's also not *signaling*. Agents that respect robots etiquette (most production crawlers) need the file to know what's allowed; without it, conservative bots may crawl less than they could.

**Why weight 1.0.** Modest weight because absence of robots.txt is permissive (well-behaved crawlers default to allow). The real signal lives in `ai-agent-access`, which inspects the file's *content*.

**Provenance.** robots.txt convention since 1994 (Martijn Koster); RFC 9309 (September 2022) formalized the syntax. Universal de facto standard.

**Evidence boundary.** `/robots.txt` returns 200 and is not an HTML document (a `text/html` body starting with `<`, or an empty one, counts as absent) → pass 100. Otherwise fail 0. Existence only; content is read by `ai-agent-access`.

**Known limitations.** Doesn't validate robots.txt syntax — a malformed robots.txt that no parser can read still passes existence.

#### `ai-agent-access` (weight 2.0, error)

**What it measures.** Parses robots.txt with `robots-parser` and evaluates root (`/`) access for every robots token in the vendor-cited table `packages/core/src/audit/shared/bot-tokens.ts`, grouped by purpose: **user-initiated** fetchers (ChatGPT-User, Claude-User, Perplexity-User, Amzn-User, MistralAI-User, Meta-ExternalFetcher), **search** fetchers (OAI-SearchBot, Claude-SearchBot, Googlebot, PerplexityBot, Applebot, Amzn-SearchBot, MistralAI-Index, Meta-WebIndexer) and **training** crawlers (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, Amazonbot, MistralAI-Training, Meta-ExternalAgent, CCBot). Any user-initiated token blocked → fail 0. Otherwise, any search token blocked → partial 50. Otherwise → pass 100. Training tokens are listed in the details as allowed or blocked and never scored. Google-Agent has no robots token (Google says user-triggered fetchers generally ignore robots.txt); the details say so.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** A site that blocks the fetchers agents use on a user's behalf has locked the front door: for an agent that honours robots.txt, nothing else in the rubric matters. Blocking a search fetcher removes the site from AI search answers, which is a partial loss. Blocking training crawlers is a data-licensing decision, not an agent-readiness one (owner decision D-2): a site can opt out of training and still be fully usable by agents, and the training posture is still reported.

**Why weight 2.0.** Highest in category because it's a *gating* signal — failure here makes most downstream checks moot for compliant agents. Severity is `error` (not warning) for the same reason.

**Provenance.** Each token and its purpose come from the vendor's own crawler documentation; the table stores the source URL per token. RFC 9309 (September 2022) defines robots.txt parsing and the unreachable-file rule. Renamed and rebuilt in 3.0 from a check that averaged five hard-coded bots and mixed training crawlers with agents.

**Evidence boundary.** No robots.txt (a 4xx, or a 200 HTML soft-404) → pass 100. robots.txt 5xx, including a 503 that persists through retries → fail 0 (RFC 9309: an unreachable file means complete disallow). A 429 that persists through retries, or no response at all (network error, timeout) → `error` (unmeasured). Root path only.

**Known limitations.** Root-path evaluation only — a `Disallow: /api/` aimed at a user-initiated token still passes. Tokens not in the table are invisible. robots.txt is policy, not enforcement: edge blocking (WAF challenges, 403s to agent user-agents) is scored only by the three `reach-*` checks in §6.5 and observed, unscored, across six agent user-agents by the tracked `edge-agent-access`.

#### `sitemap-exists` (weight 1.5, warning)

**What it measures.** `/sitemap.xml` answers HTTP 200 AND its body contains the substring `<urlset` or `<sitemapindex` → pass 100. Otherwise fail 0.

**Maturity.** M2 (multi-vendor convention or draft with live adoption, §7.1).

**Why this check.** Sitemaps tell agents what pages exist without requiring crawl-the-graph discovery. For agents on a budget (token-limited models, paid-API crawlers), a sitemap is the cheapest path to content inventory. Sites with thousands of pages but no sitemap force agents to either crawl exhaustively (expensive) or sample (incomplete).

**Why weight 1.5.** Higher than the other 1.0 checks because sitemaps materially compress agent discovery cost — a 1KB sitemap can replace 100s of HTTP requests. Lower than `ai-agent-access` because absence of sitemap is recoverable (agent can crawl) while bot-block is not.

**Provenance.** Sitemaps protocol (sitemaps.org, 2008) — co-authored by Google, Yahoo, Microsoft. De facto standard, supported by all major crawlers.

**Evidence boundary.** `/sitemap.xml` only: a sitemap declared solely through a robots.txt `Sitemap:` directive, or served at another path, is not fetched and fails. Substring match, not XML parsing: an empty `<urlset>` passes (no minimum URL count), and so does any 200 body that contains the root tag.

**Known limitations.** Doesn't follow robots.txt `Sitemap:` directives, which the sitemaps protocol explicitly allows — a real miss for sites that publish only there. Doesn't validate sitemap freshness, URL count, or whether listed URLs are reachable. Doesn't follow a sitemap index to its sub-sitemaps.

#### `response-time` (weight 1.0, warning)

**What it measures.** Average response time over crawled pages that carry a measured timing (`responseTime > 0`). Buckets: <500 ms → pass 100; <1500 ms → pass 70; <3000 ms → partial 35; otherwise fail 0. No timed page → skip.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** Slow sites cost agents real money — every additional 500ms of response time is multiplied by every page the agent fetches. For multi-page tasks, slow sites become economically infeasible for agent integration even when they're functionally correct.

**Why weight 1.0.** Modest weight because response time is a *gradient* signal, not binary. Sites in the 1-2s range are usable; only sites consistently >3s (typically anti-bot interstitials or under-provisioned origin) become problematic.

**Provenance.** Web performance literature consensus — Google PageSpeed, Lighthouse, Core Web Vitals all cite ~500ms as the "good" floor and ~2-3s as the "needs improvement" threshold.

**Evidence boundary.** Step buckets at 500 / 1500 / 3000 ms. Pages with a 0 ms timing (e.g. externally supplied pre-fetched pages) are left out of the average and counted in the message; when no page is timed the check skips instead of awarding full marks (2.0 scored untimed pages as 100).

**Known limitations.** Doesn't measure per-region latency — a site that's fast from us-east-1 but slow from EU/APAC scores well here. Doesn't measure tail-latency (p99) which agents care more about than average.

#### `content-negotiation` (weight 0.5, info)

**What it measures.** Probes the homepage and one docs page (the first 2xx crawled page under `/docs` or `/documentation`, or on a `docs.` host) two ways: `GET` with `Accept: text/markdown`, and the `.md` twin URL (`/` → `/index.md`, otherwise trailing slash stripped + `.md`). A hit is a 2xx `text/markdown` (or `text/x-markdown`) response with a non-empty body that is not an HTML document and does not merely reproduce the crawled page. Any `.md` hit, or a negotiation hit that sends `Vary: Accept` → pass 100; negotiation hits without `Vary: Accept` only → partial 50; no hit → fail 0.

**Maturity.** M2 (multi-vendor convention or draft with live adoption, §7.1).

**Why this check.** A handful of agent-forward sites support Markdown content negotiation — agent fetches the same URL with `Accept: text/markdown` and gets a clean Markdown rendering instead of HTML. Saves the parsing step entirely. Cheap to implement (most static-site generators already produce both formats).

**Why weight 0.5 (lowest in category).** Adoption is *very* sparse — supporting this is a forward-looking optimization, not a baseline. Floor signal: passing earns recognition; failing is the universal default.

**Provenance.** RFC 7231 §5.3.2 (HTTP content negotiation, 2014; now RFC 9110 §12.5.1) and `Vary` (RFC 9110 §12.5.5). Markdown as a negotiated or `.md` alternative is a convention shipped by Cloudflare, Vercel and Mintlify, not a spec.

**Evidence boundary.** A negotiation request that redirects is judged on the redirect target; `Vary: Accept` on either response counts. Each `.md` hit is confirmed with a control request to a random-UUID `.md` path in the same directory (and in the final URL's directory after a redirect); if a control also passes the hit test, or is refused, fails or times out, that directory's `.md` hits don't count. The copy test applies when the site is flagged catch-all or the crawled page was not itself served as markdown or plain text. Full detection detail: OSS `docs/CHECKS.md`.

**Known limitations.** Two URLs only — negotiation on other docs pages isn't sampled. Doesn't validate the returned Markdown is structurally equivalent to the HTML.

#### `status-codes` (weight 1.0, error)

**What it measures.** Over the crawled pages (final status after redirects): score = (pages with status below 400 / total) × 100. No page with status ≥ 400 → pass 100; otherwise partial with that score (the status is `partial` even at score 0).

**Maturity.** M1 (standardized, §7.1).

**Why this check.** A page that returns 404 or 500 to a crawler is invisible to agents. Error rates above zero indicate either (a) broken internal links surfacing pages that no longer exist, (b) anti-bot 403s that conflate "blocked" with "missing", or (c) origin failures. All three are agent-hostile.

**Why weight 1.0.** Modest weight because most well-maintained sites pass trivially. Severity is `error` because the signal — when it fires — is genuine breakage, not preference.

**Provenance.** HTTP status code semantics (RFC 9110, June 2022). 2xx-success and 3xx-redirect are the "agent should keep going" classes; 4xx/5xx are "agent should stop or retry."

**Evidence boundary.** Status ≥ 400 counts as an error page. The check reads the crawl set (§6.0): a page that returned no response at all is dropped from the crawl, and a homepage that is blocked, rate-limited, auth-gated or unreachable stops the audit before this check runs (§3.5). Score scales linearly with the error rate.

**Known limitations.** Anti-bot 403s on non-homepage pages still register as errors here, conflating "blocked" with "broken"; only the homepage is classified into typed failures (§3.5).

#### `usage-preference-declared` (weight 0, info)

**Tracked (not scored).** Added 2026-09-15 as a 3.0 tracked addition; no version bump (§2).

**What it measures.** Whether the site declares how AI may use its content, in any of four vocabularies: `Content-Signal:` lines in robots.txt (`key=yes|no`, Cloudflare's Content Signals Policy); `Content-Usage:` lines in robots.txt and the `Content-Usage` header on the homepage response (IETF AIPREF `draft-ietf-aipref-attach`, a structured-field dictionary with `y`/`n` values); `License:` lines in robots.txt (RSL 1.0 §4.4); and `/.well-known/tdmrep.json` (W3C TDMRep, `tdm-reservation` 1 = reserved). Pass 100 = at least one declaration found; skip = none. The message names the vocabularies and adds `CDN-managed default` when the robots body contains Cloudflare's delimited managed block. `details` reports `sources`, `trainingOptOut`, `managedDefault` and one line per parsed signal. `trainingOptOut` is true when any source forbids training (`ai-train=no`, `train-ai=n`, `tdm-reservation: 1`), false when one permits it and none forbids, otherwise null — one "no" outweighs any number of "yes".

**Evidence boundary.** Reads only the robots.txt body and homepage headers the crawl already fetched, plus the one `tdmrep.json` probe, which passes through the catch-all rule (§6). Scoping (user-agent groups, paths, TDMRep `location`) is recorded in `details` but not evaluated.

**Maturity.** M2–M3: AIPREF is an IETF working-group draft whose vocabulary is still moving; Content Signals is a single-vendor (Cloudflare) convention; RSL 1.0 and TDMRep are published but thinly adopted. None has been stable for two rubric cycles.

**Why this check.** A site that opts out of AI training has made a deliberate licensing choice, not a misconfiguration. Reporting the declaration next to `ai-agent-access` lets a reader tell "blocked training on purpose" from "locked agents out by accident".

**Why weight 0 (tracked).** It fails §7.1 criterion (b), and there is nothing to score: owner decision D-2 (see `ai-agent-access`) holds that a training opt-out does not make a site agent-unready. Values are also often CDN defaults rather than the owner's choice, which `managedDefault` exposes.

**Provenance.** Cloudflare Content Signals Policy; IETF AIPREF working group (`draft-ietf-aipref-attach`); RSL 1.0 (Really Simple Licensing); W3C TDM Reservation Protocol (Community Group report).

**Known limitations.** Only four vocabularies; declarations in HTML `<meta>` tags or page-level headers other than the homepage are not read. A preference is not enforcement.

#### `edge-agent-access` (weight 0, error)

**Tracked (not scored).** Added 2026-09-15 as a 3.0 tracked addition; probe set widened 2026-09-17; no version bump (§2). Its severity is `error` because the finding, when real, is as serious as a robots.txt block; being tracked, it never raises a warning or a top issue.

**What it measures.** Whether the site's edge (CDN, WAF, bot management) answers the documented agent user-agents worse than w2agent's own declared crawler on the same pages, using the multi-UA pass below. A page is **comparable** only when its control fetch received a response that is 2xx and carries no challenge fingerprint (§3.5). Outcomes, in priority order, are reported on the first `details` line (`outcome: …`):

| Outcome | Status | When |
|---|---|---|
| `unmeasured` (no control) | error | No comparable page |
| `agent-blocked` | fail | On a comparable page, some agent user-agent got a challenge, a 403 or a 429 — including a status observed before a body-read error |
| `unmeasured` (no response) | error | Every agent fetch on the comparable pages was budget-skipped, timed out or errored |
| `agent-rejected` | fail | Some agent user-agent got another non-2xx status, other than 402 |
| `paywalled` | pass | Some agent user-agent got a 402 (informational: a declared paywall is not an edge block) |
| `consistent` | pass | Some comparable page was answered 2xx by every agent user-agent probed on that page, **and** every probed user-agent got a 2xx on at least one comparable page |
| `unmeasured` (incomplete) | error | Otherwise: no comparable page was answered by every user-agent probed on it, or some probed user-agent has no 2xx answer on any comparable page |

`details` also carries `<url>.control: <status>` and `<url>.<token>: <status>[ <vendor> <signal>]` for every probed page, a `notProbed:` line naming the documented user-initiated tokens with no fetch anywhere (today `Claude-User`), and `<url>.notProbed: <tokens> (extra-pages-only)` on an extra page for the homepage-only tokens.

**The multi-UA pass (probe set).** `fetchUnderUas` in `packages/core/src/audit/crawler.ts`, run once during metadata probing, feeds this check and the three `reach-*` checks:

- **Probed user-agents** (`AGENT_UAS`): a pinned head of the three tokens that back a scored `reach-*` check — `ChatGPT-User`, `Perplexity-User`, `Google-Agent`, in that order and under fixed keys — followed by every other `purpose: "user"` token in `packages/core/src/audit/shared/bot-tokens.ts` that has a documented UA string, in registry order: today `Amzn-User`, `MistralAI-User`, `Meta-ExternalFetcher`. `Claude-User` is not probed: Anthropic publishes the robots token but no UA string. The head is pinned because the pass is budget-gated per fetch, so a token's queue position decides whether its scored check is measured at all; a registry reorder must not move a score.
- **Pages.** The homepage under all six user-agents, then up to 2 extra pages — the crawl's own top two selections — under the head only (`EDGE_EXTRA_PAGE_TOKENS` = 3).
- **Control.** Each page also gets one single-shot fetch under `w2agent/0.1 (+https://w2agent.dev)` through the same reader, never the retrying page fetch (a flaky 503 retried to 200 would otherwise fake a rejection). The homepage control runs after the agent fetches; an extra page whose control is not comparable gets no agent fetches.
- **Budget.** The pass has a wall-clock budget of `min(timeout × 3, 15 s)`, checked before each gated fetch; a fetch that would start past it is recorded as `budget-skipped` without a request. Homepage agent fetches are unpaced; controls and extra-page agent fetches wait `requestDelay` (200 ms) first. robots.txt `Crawl-delay` is not consulted.
- **Per fetch.** Redirects are followed; up to 64 KB of body is read; the first 4 KB is fingerprinted with `detectChallenge`; `cf-mitigated`, `server` and `retry-after` headers are kept.

**Evidence boundary.** The requests carrying an agent token come from w2agent's network, so they are **not verified agent requests**: bot managers that verify by published IP ranges, reverse DNS or Web Bot Auth signatures (as Cloudflare does) may treat the real agent differently, in either direction. What is observed is "requests identifying as X from a third-party network". Three pages at most; the homepage carries all six user-agents.

**Maturity.** M1: vendor-documented user-agent strings and observable HTTP behaviour (status codes, challenge fingerprints).

**Why this check.** Since 2026 the edge, not robots.txt, is the dominant barrier between agents and sites: a site can allow every agent in robots.txt and still challenge them at the CDN. The rubric-change table planned it as scored at weight 2.

**Why weight 0 (tracked).** Because the requests are unverified (above), a scored result could penalise a site for treating an impostor correctly. It is tracked so that stored results measure prevalence first; promotion, and consolidation with the `reach-*` checks so the same fact is not counted twice, are rubric 3.1 decisions (§7.2).

**Provenance.** Phase 2 failure-honesty design (decision D-3, owner decision 2026-09-15); UA strings from each vendor's crawler documentation (source URLs stored per token in `bot-tokens.ts`); Cloudflare verified-bots documentation for the evidence boundary.

**Known limitations.** Unverified requests (above). Budget pressure on slow sites turns results into `unmeasured`, more so since the homepage carries six user-agents. A challenge whose marker sits beyond the 4 KB prefix, or a hard block that is not a challenge, is read only by its status code.

### 6.2 Structured Data (category weight 0.15)

> The "can an agent understand the structure of this content?" tier.

| ID | Weight | Severity | Maturity | What it measures |
|---|---:|---|---|---|
| `schema-org-present` | 2.0 | warning | M2 | Share of pages with at least one JSON-LD block |
| `schema-org-type` | 1.0 | info | M2 | Share of pages whose JSON-LD `@type` names one of 16 recognized Schema.org types |
| `schema-org-completeness` | 1.0 | info | M2 | Average share of 7 common fields on each page's first JSON-LD block |
| `schema-org-valid` | 1.0 | error | M2 | Share of JSON-LD pages carrying a schema.org `@context` and a string `@type` |
| `og-meta-tags` | 1.0 | warning | M3 | Average share of `og:title`, `og:description`, `og:image` per page |
| `heading-hierarchy` | 0.5 | info | H | Share of pages with exactly one h1 and no skipped heading level going down |
| `semantic-html` | 0.5 | info | H | Average share of `<article>`, `<section>`, `<nav>`, `<main>`, `<aside>` present per page |

#### `schema-org-present` (weight 2.0, warning)

**What it measures.** Counts pages with at least one `<script type="application/ld+json">` block. Score = (pages_with_JSON-LD / total_pages) × 100. Pass = 100% (all pages have JSON-LD). Partial = 1–99%. Fail = 0%.

**Maturity.** M2 (multi-vendor convention or draft with live adoption, §7.1).

**Why this check.** Schema.org JSON-LD is the universal structured-data layer agents rely on to understand "what is this page about" without parsing prose. A product page with `Product` JSON-LD lets the agent extract price, brand, availability in 100ms; a product page without it forces the agent to scrape, infer, and frequently err. Foundation primitive for content comprehension.

**Why weight 2.0 (highest in category).** Highest because all four downstream Schema.org checks (`schema-org-type`, `schema-org-completeness`, `schema-org-valid`) depend on having JSON-LD to evaluate. A site that ships zero JSON-LD fails this check and renders the other three uninformative.

**Provenance.** Schema.org (founded 2011, joint project of Google/Bing/Yahoo/Yandex). JSON-LD as the preferred encoding endorsed by Google Search since 2017.

**Evidence boundary.** Pure presence — any `application/ld+json` block that parses as JSON counts. Validity is the separate `schema-org-valid` check. No crawled pages → fail 0.

**Known limitations.** Doesn't measure semantic quality — a JSON-LD block declaring `@type: WebPage` with only a `name` field passes equivalently to one declaring `Product` with full specs. The downstream completeness/type checks partially address this.

#### `schema-org-type` (weight 1.0, info)

**What it measures.** A page counts as typed when any of its top-level JSON-LD blocks has a string `@type` that contains one of 16 recognized Schema.org type names (`WebPage`, `Article`, `BlogPosting`, `Product`, `LocalBusiness`, `Organization`, `Person`, `FAQPage`, `HowTo`, `Recipe`, `Event`, `Course`, `SoftwareApplication`, `WebSite`, `ItemList`, `BreadcrumbList`). Score = (typed pages / **all** crawled pages) × 100. Pass ≥ 50; partial 1–49; fail 0.

**Maturity.** M2 (multi-vendor convention or draft with live adoption, §7.1).

**Why this check.** A page with JSON-LD that doesn't declare a recognized type is signaling "I have structured data but I don't know what kind" — agents can't dispatch to the right comprehension routine. The 16-type whitelist covers the vast majority of agent-relevant content (commerce, editorial, business listings, SaaS).

**Why weight 1.0.** Half the weight of `schema-org-present` because typing is a refinement, not a precondition. Sites with rich-but-untyped JSON-LD still extract better than sites with no JSON-LD at all.

**Provenance.** Schema.org type vocabulary. The 16-type list is curated from highest-volume agent use cases; it's not exhaustive — `MedicalEntity`, `JobPosting`, `Vehicle` etc. exist in Schema.org but aren't in our pass list.

**Evidence boundary.** Substring match on a **string** `@type`: `"NewsArticle"` matches because it contains `Article`, while an array `@type` such as `["BlogPosting", "Article"]` never matches. Only top-level blocks are read: types nested inside `@graph`, or inside a block that is itself a JSON array, are not. The denominator is every crawled page, so pages without JSON-LD lower this score too.

**Known limitations.** 16-type whitelist is partial — a site with `MedicalEntity` typing fails this check despite using a well-formed Schema.org type. Array `@type` values and `@graph` wrappers (common in WordPress/Yoast output) are missed. Candidate for a later rubric (not changed in 3.0): expand the list, read arrays and `@graph`, or invert the logic to "any registered Schema.org type."

#### `schema-org-completeness` (weight 1.0, info)

**What it measures.** For each page with JSON-LD, takes the first block on the page and counts how many of 7 top-level fields (`name`, `description`, `author`, `datePublished`, `dateModified`, `image`, `url`) are defined. Page score = (present / 7) × 100; check score = average over pages with JSON-LD. Pass ≥ 70; partial 1–69; fail 0, including when no page has JSON-LD.

**Maturity.** M2 (multi-vendor convention or draft with live adoption, §7.1).

**Why this check.** A `Product` declaration with no `name`/`description`/`image` is functionally useless — the agent gets the type but no content. Completeness is the "is this Schema.org block actually informative?" check.

**Why weight 1.0.** Equal weight with `schema-org-type` and `schema-org-valid` — these three together evaluate JSON-LD quality from three angles (typing, content, structure).

**Provenance.** Field list is our authorship — drawn from the union of common required-fields across the 16 typed entities. v0.2+ refinement: per-type required field sets (e.g., `Product` requires `offers`, `Article` requires `headline`).

**Evidence boundary.** A field counts when it is defined at the top level of the page's first JSON-LD block (any value, including an empty string). Later blocks, `@graph` members and nested properties are not read, so a page whose first block is a `BreadcrumbList` scores low even when a later `Article` block is complete.

**Known limitations.** Doesn't validate field *content* — `name: ""` passes equivalently to `name: "Acme Widget"`. Single field-set across types is too loose for agents that want type-specific richness.

#### `schema-org-valid` (weight 1.0, error)

**What it measures.** Per page with JSON-LD: the page is valid when some block's `@context` stringifies to text containing `schema.org` AND some block (not necessarily the same one) has a string `@type`. Score = (valid pages / pages with JSON-LD) × 100. Pass = 100; partial 1–99; fail 0. Skip when no page has JSON-LD (avoids penalizing sites with no JSON-LD twice — `schema-org-present` already handles that).

**Maturity.** M2 (multi-vendor convention or draft with live adoption, §7.1).

**Why this check.** Malformed JSON-LD (missing context, missing type) is parser-hostile — agents using off-the-shelf JSON-LD libraries will reject these blocks, treating the page as having no structured data. A site investing in JSON-LD but shipping invalid blocks is wasting that investment.

**Why weight 1.0.** Same weight as type and completeness. Severity is `error` because invalid structured data is a bug, not a preference.

**Provenance.** JSON-LD spec (W3C, 2014) plus Schema.org context conventions. The two-field requirement (`@context` + `@type`) is the minimum for a JSON-LD parser to dispatch the block.

**Evidence boundary.** A block that is not valid JSON is dropped by the parser before any JSON-LD check sees it, so malformed JSON counts as no JSON-LD rather than as invalid JSON-LD. The check is per page, not per block: one good block makes the page valid even if others lack `@context` or `@type`.

**Known limitations.** Doesn't validate against actual Schema.org schema (no required-field enforcement per type). An array `@type` counts as invalid, although JSON-LD allows it. Broken JSON is invisible here (see boundary).

#### `og-meta-tags` (weight 1.0, warning)

**What it measures.** Three OpenGraph tags (`og:title`, `og:description`, `og:image`, as `<meta property>` with non-empty `content`) per page. Page score = (present / 3) × 100; check score = average over crawled pages. Pass ≥ 80; partial 1–79; fail 0.

**Maturity.** M3 (single-vendor, or path or schema still changing, §7.1).

**Why this check.** OpenGraph is the social-card protocol but it's also a fast agent-friendly metadata signal — an agent that needs page-summary information can fetch `og:title` + `og:description` + `og:image` in a single parse pass instead of attempting full HTML comprehension. Universally adopted across content sites.

**Why weight 1.0.** Lower than `schema-org-present` (2.0) because OG is per-page metadata while JSON-LD can carry richer typed entities. Equal to other "decent metadata" checks in the category.

**Provenance.** Open Graph protocol (Facebook, 2010). Adopted by virtually every social platform and most search/AI ingestion pipelines.

**Evidence boundary.** A page with 2 of 3 tags scores 67, so a site that ships 2 of 3 everywhere is partial, not pass; pass needs most pages to carry all three. A site with no OG tags on any page fails.

**Known limitations.** Doesn't validate `og:image` URL resolves. Doesn't check `og:url` (excluded from required set since canonical-urls covers similar ground).

#### `heading-hierarchy` (weight 0.5, info)

**What it measures.** Per page: at least one heading, exactly one `<h1>`, AND no step down the outline by more than one level between consecutive headings (h1 → h3 is a skip; h4 → h2 is not). Score = (passing pages / all crawled pages) × 100. Pass ≥ 80; partial 1–79; fail 0.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** Agents parsing document outlines use heading levels to build the table of contents. A page with three h1s leaves the agent guessing "which is the title?"; a page that jumps h1 → h4 disrupts the navigation structure. Both are content-comprehension hazards. Also strongly correlated with accessibility — screen readers face the same structural problem.

**Why weight 0.5 (lowest in category).** Aesthetic concern more than data concern — pages with bad heading structure are still readable, just less navigable. Lower than the JSON-LD/OG family because those carry richer payloads.

**Provenance.** WCAG 2.1 (W3C) heading-structure guidelines. HTML5 spec on heading semantics.

**Evidence boundary.** Two hard requirements: `h1.length === 1` AND, for every consecutive pair of headings in document order, `level[i] − level[i−1] ≤ 1`. A page with no headings counts as failing.

**Known limitations.** Doesn't check heading content quality. Doesn't catch multiple distinct outlines on a single page (which HTML5 sectioning permits but most parsers misinterpret).

#### `semantic-html` (weight 0.5, info)

**What it measures.** Per page: how many of 5 semantic elements (`<article>`, `<section>`, `<nav>`, `<main>`, `<aside>`) appear at least once. Page score = (found / 5) × 100; check score = average over crawled pages. Pass ≥ 60; partial 1–59; fail 0.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** Semantic HTML5 elements give agents free landmark detection — `<main>` is the primary content, `<nav>` is the navigation menu, `<article>` is a self-contained piece. Without these, the agent has to use heuristics (CSS class names, position-on-page) to find content boundaries — much less reliable.

**Why weight 0.5.** Same logic as `heading-hierarchy` — soft signal, related to accessibility, not data-rich.

**Provenance.** HTML5 sectioning elements (W3C, 2014). Long-stable spec, universally available.

**Evidence boundary.** Element appears anywhere on page. Doesn't validate that `<main>` wraps the actual main content.

**Known limitations.** Presence != correctness — a site that wraps everything in `<article>` passes; a site that omits all semantic elements but has clear visual structure fails. The 60% threshold tolerates partial adoption.

### 6.3 Content Quality (category weight 0.15)

> The "is the content actually useful for an agent to read?" tier.

| ID | Weight | Severity | Maturity | What it measures |
|---|---:|---|---|---|
| `answer-first` | 1.5 | info | H | Share of pages with ≥ 20 words in the first 500 characters of visible text (§6.0) and a meta description |
| `token-efficiency` | 1.0 | info | H | Average visible-text-to-HTML length ratio, bucketed |
| `content-length` | 1.0 | warning | H | Share of pages with ≥ 200 visible words |
| `list-and-table-usage` | 1.0 | info | H | Share of pages with a `<ul>`/`<ol>` or `<table>` |
| `faq-content` | 0.5 | info | H | Number of pages with an FAQ indicator |
| `citation-readiness` | 1.0 | info | H | Composite of numbers, quotes, reference vocabulary and authorship cues |
| `freshness-signals` | 1.0 | info | M1 | Share of pages with `time[datetime]`, `article:published_time`/`modified_time`, or JSON-LD dates |
| `author-attribution` | 0.5 | info | M1 | Share of pages with JSON-LD `author`, `<meta name="author">` or `rel="author"` |

#### `answer-first` (weight 1.5, info)

**What it measures.** Per page: the first 500 characters of the visible text (§6.0: `<body>` text without `script`, `style`, `noscript` and `template` content, whitespace collapsed) contain ≥ 20 words, AND the page has a non-empty `<meta name="description">`. Score = (qualifying pages / crawled pages) × 100. Pass ≥ 70; partial 1–69; fail 0.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** Agents working under token budgets read top-of-page first. A page that buries the answer below 800px of nav, hero, and CTA chrome forces the agent to scroll-and-extract — often missing the answer when the budget runs out. Sites that put the substantive answer in the first 500 chars (and signal it via meta description) work better with retrieval-augmented generation pipelines.

**Why weight 1.5 (highest in category).** Highest because content-extraction efficiency multiplies through every agent interaction. A 10-page-summary task where each page has 20 words of preamble runs cheaper than the same task where each page has 200 words of preamble.

**Provenance.** No formal spec — convention informed by retrieval-augmented-generation (RAG) literature. The 500-char / 20-word threshold is our tuning, not standards-derived.

**Evidence boundary.** Two conditions ANDed: word count of first 500 chars of visible text ≥ 20, AND meta description not empty. JSON-LD or other script content placed in the body ahead of the content no longer fills the window.

**Known limitations.** Heuristic — doesn't measure whether those 20 words are actually substantive (could be footer-style "we are a leading provider..."). Meta-description requirement is a stand-in for "this page knows what it's about."

#### `token-efficiency` (weight 1.0, info)

**What it measures.** Per page: ratio of visible text length (§6.0, whitespace collapsed) to raw HTML length; averaged over crawled pages. Score steps: ≥ 25% → 100, ≥ 15% → 80, ≥ 10% → 60, ≥ 5% → 30, < 5% → 0. Pass = score ≥ 60; partial 30; fail 0.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** Pages with very low text-to-HTML ratios are mostly chrome, scripts, and styling — agents fetching them spend tokens on payload that can't be read. A page that's 5% text and 95% scripts costs the agent 20× the tokens to extract the same content as a page that's 25% text. Also a strong indicator of CSS-in-JS bloat or analytics overload.

**Why weight 1.0.** Modest because the gradient is real — sites in the 10–15% range are usable, just less efficient. Most professional content sites land 15–25%.

**Provenance.** Web performance / SEO literature consensus. Specific thresholds are our tuning.

**Evidence boundary.** Step function at 25/15/10/5%, applied to the average ratio (not per page). Pass at score 60 = an average ratio of at least 10%. Lengths are JavaScript string lengths (UTF-16 code units), not bytes.

**Known limitations.** Penalizes structurally-heavy markup (data tables, complex forms) even when the data is accessible. Doesn't distinguish "valuable HTML" (ARIA, structured data) from "chrome HTML" (analytics scripts).

#### `content-length` (weight 1.0, warning)

**What it measures.** Pages whose visible text (§6.0) has ≥ 200 whitespace-separated words. Score = (qualifying / crawled pages) × 100. Pass ≥ 70; partial 1–69; fail 0.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** Pages under 200 words are typically navigation hubs, redirects, or thin landing pages — they don't contain the substantive content agents are typically retrieving. A site whose audited sample is mostly thin pages signals either (a) homepage-heavy crawling didn't reach the real content, or (b) the site doesn't have much.

**Why weight 1.0.** Modest weight — content length is a coarse signal. Many legitimate pages (login, contact, status) are correctly thin.

**Provenance.** SEO content-length conventions (~300+ for "substantive"). Our 200 threshold is intentionally lenient to avoid penalizing concise documentation pages.

**Evidence boundary.** Word count of visible text (§6.0). 70% pass threshold is "most pages should clear the bar."

**Known limitations.** Doesn't measure content quality. A 200-word footer "About us" passes equivalently to a 200-word substantive paragraph. Heavily-illustrated pages (case studies with screenshots) may legitimately have under 200 words.

#### `list-and-table-usage` (weight 1.0, info)

**What it measures.** Pages with at least one `<ul>`/`<ol>` or `<table>` element anywhere (navigation lists included). Score = (qualifying / crawled pages) × 100. Pass ≥ 50; partial 1–49; fail 0.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** Lists and tables are the markup primitives for structured information — pricing tiers, feature comparisons, step sequences, data points. An agent extracting pricing from a `<table>` works orders-of-magnitude better than from a paragraph that mentions prices inline. Sites that markup their structured info as actual structured HTML are agent-friendly.

**Why weight 1.0.** Modest — many legitimate page types don't need lists/tables (essay-style blog posts, image-heavy galleries). The 50% pass threshold reflects that.

**Provenance.** HTML semantics (long-standing). No specific spec on "use lists for lists."

**Evidence boundary.** Any list or table element on the page → qualifies. Doesn't measure list quality (length, depth) or table quality (header rows, scope attributes).

**Known limitations.** Doesn't catch CSS-styled-as-table content that isn't actually `<table>` markup (common in modern design systems). Doesn't distinguish data tables from layout tables, or content lists from the `<ul>` navigation menus most sites render on every page, so nearly every site passes.

#### `faq-content` (weight 0.5, info)

**What it measures.** A page is an FAQ page when any one of these holds: an element with `itemtype` containing `FAQPage`; 2 or more `<details>` elements; 2 or more `<dt>` elements; visible text containing "frequently asked"; or 3 or more occurrences of `?` followed by whitespace in the visible text. Script content is not searched. Score = `min(faq_pages × 33, 100)`. Any FAQ page → **pass** (even at score 33); none → fail 0. There is no partial.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** FAQ pages are pure-form agent-friendly content — they're already in question-then-answer format that maps directly to agent retrieval. Agents handling FAQ content can quote-and-cite the answer with high confidence. Sites that structure their support/help/about content as FAQs are giving agents a free win.

**Why weight 0.5 (lowest tier in category).** Floor signal — not all sites need FAQ content (e-commerce product pages, news sites, technical docs are all legitimately non-FAQ). Lower weight reflects "bonus, not baseline."

**Provenance.** Schema.org `FAQPage` type (2018, read here only as microdata `itemtype`) + heuristic prose detection. The five indicators are our authorship.

**Evidence boundary.** The five indicators above, OR-ed. Score scales 33 per FAQ page: 1 → 33, 2 → 66, 3 → 99, 4 or more → 100. FAQPage declared only in JSON-LD is not one of the indicators.

**Known limitations.** Heuristic and permissive — any page with three questions in its text, or two `<details>` disclosure widgets, registers, so false positives are common. FAQPage JSON-LD alone is not detected.

#### `citation-readiness` (weight 1.0, info)

**What it measures.** Composite per-page score (0–100) with 25 points each for: a percentage or decimal number in the visible text (`\d+%` or `\d+\.\d+`); a `<blockquote>` or a straight-double-quoted string of ≥ 20 characters; reference vocabulary in lower-cased visible text (`source`, `reference`, `according to`, `study`); and an authorship cue (a `rel="author"` element, or the visible text containing `by ` or `author`). Averaged across crawled pages. Pass ≥ 50; partial 1–49; fail 0.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** Agents performing retrieval-augmented generation cite sources back to users — pages with structured supporting evidence (numbers, quotes, citations, bylines) make better citable sources than pages of unsourced opinion. RAG systems that rank citation-worthy content over generic prose perform better.

**Why weight 1.0.** Modest — composite-of-four nature means partial credit is the norm. Most professional content (journalism, technical docs) hits 50%+.

**Provenance.** No formal spec — composite indicator inspired by E-A-T (Expertise / Authoritativeness / Trustworthiness) literature from search-quality research.

**Evidence boundary.** Four channels, 25 points each, summed and averaged across pages.

**Known limitations.** Vocabulary-driven ("source", "study") is English-only, and substring matching is loose: "resource" contains "source" and almost any English page contains "by ", so two of the four channels fire on most pages. Curly quotation marks are not matched. Doesn't validate that cited sources are real.

#### `freshness-signals` (weight 1.0, info)

**What it measures.** Pages with ≥ 1 of: a top-level JSON-LD block with a truthy `datePublished` or `dateModified`, `<meta property="article:published_time">` or `article:modified_time`, or a `<time datetime>` element. Score = (qualifying / crawled pages) × 100. Pass ≥ 50; partial 1–49; fail 0.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** Agents need to know when content was published to assess freshness — a 2018 doc on "the latest ML benchmarks" is much less useful than a 2025 one. Sites that surface dates in machine-readable form let agents filter out stale content. Sites that hide dates (or worse, lie about them) frustrate retrieval pipelines.

**Why weight 1.0.** Modest — many legitimate page types are date-insensitive (about pages, contact pages, privacy policies). The 50% pass threshold reflects this.

**Provenance.** Schema.org date properties + W3C `<time>` element + Open Graph article extension. Three orthogonal mechanisms; we accept any.

**Evidence boundary.** Any of the three date sources → qualifies. Doesn't validate date is recent or correctly formatted.

**Known limitations.** Doesn't enforce dates are accurate or current. Doesn't distinguish published vs modified timestamps. Doesn't catch sites that bury dates in plain text only.

#### `author-attribution` (weight 0.5, info)

**What it measures.** Pages with ≥ 1 of: a top-level JSON-LD block with an `author` field, `<meta name="author">`, or any element with `rel="author"`. Score = (qualifying / crawled pages) × 100. Pass ≥ 50; partial 1–49; fail 0.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** Authored content is more trustable than unauthored content for agents weighing source credibility. Agents that cite back to users do better when they can name the author ("according to Jane Smith at acme.com..."). Many sites have author info in their visual byline but never expose it via metadata.

**Why weight 0.5.** Lower because most homepage / product / corporate pages are legitimately authorless. Strongest signal on editorial content (blogs, articles, docs); irrelevant on product/tooling pages.

**Provenance.** Schema.org `author` (2011+), HTML5 `<meta name="author">`, and `rel="author"` link relation.

**Evidence boundary.** Any of three sources → qualifies. Doesn't validate author identity.

**Known limitations.** Doesn't distinguish brand authorship ("by Acme Inc.") from individual authorship. Doesn't validate author profile links resolve.

### 6.4 Agent Discovery (category weight 0.12)

> The "does the site self-describe via emerging agent-discovery conventions?" tier.

| ID | Weight | Severity | Maturity | What it measures |
|---|---:|---|---|---|
| `llms-txt-exists` | 0.5 | warning | M3 | `/llms.txt` (or a docs-subdomain fallback) is served as a text file |
| `llms-txt-valid` | 0.5 | info | M3 | `/llms.txt` carries the format's four elements |
| `llms-txt-links-resolve` | 0.5 | warning | M3 | Up to 10 URLs in `/llms.txt` answer 200–399 |
| `well-known-agent-card` | 1.0 | info | M1 | `/.well-known/agent-card.json` validates against A2A v1.0 (v0.3 shape or homepage stub = partial) |
| `mcp-server-card` | 0 (tracked) | info | M3 | MCP server card at `<endpoint>/server-card`, an ai-catalog entry, or the legacy well-known path |
| `agent-skills-index` | 0 (tracked) | info | M3 | `/.well-known/agent-skills/index.json` validates against the Agent Skills Discovery RFC v0.2.0 (absent `$schema` = partial) |
| `markdown-alternate` | 0.5 | info | M2 | Pages carry `<link rel="alternate">` with a markdown type |

**Per-check rationale.** Every weight in this category is anchored in first-principles reasoning + observed vendor adoption + the convention's standards-track maturity — not in outcome calibration (P4-2), which is pending.

#### `llms-txt-exists` (weight 0.5, warning)

**What it measures.** `/llms.txt` answers HTTP 200 with a body that is not an HTML document (§6.0) → pass 100; otherwise `docs.`, `developers.` and `developer.` prefixed to the audited host (a leading `www.` removed) are tried in that order, and the first that qualifies passes. None → fail 0. Pure existence — content quality is measured by `llms-txt-valid` separately.

**Maturity.** M3 (single-vendor, or path or schema still changing, §7.1).

**Why this check.** `/llms.txt` is the emerging convention for "agent-readable site overview" — a Markdown index a model can fetch in one round-trip instead of crawling marketing HTML. Without it, an agent that lands on the site has to follow homepage links, parse the dynamic top-nav, and reconstruct the IA from scratch. With it, the agent gets a curated Markdown TOC pointing at canonical doc URLs in <2KB. The most common discovery failure pattern we observe in the audited dataset is "agent crawls 30 pages and still can't find the API reference" — `llms.txt` exists to short-circuit that.

**Why weight 0.5.** Reweighted 2.0 → 0.5 in 3.0. `llms.txt` has no governing body and a narrow set of consumers (mainly coding agents such as Claude Code and Cursor); Google ignores it. It stays scored because it is cheap to ship and those consumers are real — a documented exception to §7 criterion (a).

**Provenance.** Proposed by Jeremy Howard (Answer.AI) at llmstxt.org, September 2024. Not standards-track (no IETF/W3C). Adoption verified 2026-05-08: `stripe.com`, `vercel.com`, `cloudflare.com` ship at apex (200). `anthropic.com` apex returns 404 but `docs.anthropic.com/llms.txt` returns 200 — they ship only on the docs subdomain. `openai.com/llms.txt` returns 403 (anti-bot — we cannot distinguish "absent" from "blocked"). `google.com/llms.txt` returns 404.

**Evidence boundary.** `pass` = `/llms.txt` returns 200 with a body that is not an HTML document; when the audited host has none, `docs.<host>`, `developers.<host>` and `developer.<host>` are tried in that order, where `<host>` is the audited host without `www.`; on a subdomain audit such as `app.example.com` this probes `docs.app.example.com`, not the apex's docs host. `fail` = none of those. Binary.

**Known limitations.** A 403 on `/llms.txt` (OpenAI's case) collapses two distinct realities — "no file" and "file behind anti-bot" — into a single `fail`; the typed failures of §3.5 classify only the homepage, not individual files. Doesn't measure freshness — a stale `llms.txt` pointing at dead URLs passes existence (caught downstream by `llms-txt-links-resolve`).

#### `llms-txt-valid` (weight 0.5, info)

**What it measures.** Scores the llms.txt body (whichever file `llms-txt-exists` credited) on four line patterns: an H1 line `^#\s+.+` (30 pts), a blockquote line `^>\s+.+` (20 pts), any `https?://\S+` URL (30 pts), and an H2 line `^##\s+.+` (20 pts). `pass` ≥ 70, `partial` 1–69, `fail` 0; skip when there is no llms.txt.

**Maturity.** M3 (single-vendor, or path or schema still changing, §7.1).

**Why this check.** `llms-txt-exists` only proves a file is there. The format spec exists so agents can rely on a predictable structure — "the H1 is the site name, the blockquote is the elevator pitch, the `## Section` headers carve the index by category." A site that puts random Markdown at `/llms.txt` defeats the convention's value.

**Why weight 0.5.** All three llms.txt checks are 0.5 since 3.0 (see `llms-txt-exists`). Validity is a refinement, not a precondition. Skips itself when there is no llms.txt (no file to validate).

**Provenance.** Same as `llms-txt-exists` — Jeremy Howard's spec at llmstxt.org. The four-element scoring rubric is our interpretation of the spec's required elements; the spec itself does not enumerate "you must have these four sections."

**Evidence boundary.** Heuristic regex match per element. The 70% pass threshold is intentional latitude — sites with 3 of 4 elements still get credit.

**Known limitations.** Regex-based; doesn't validate that section headers actually point at the right kinds of content. Doesn't follow links to verify referenced URLs are about the topic claimed.

#### `llms-txt-links-resolve` (weight 0.5, warning)

**What it measures.** Absolute URLs are extracted from the llms.txt body with `https?://[^\s)>\],:]+`; the first 10 (duplicates included) are fetched with GET under the user-agent `w2agent/0.1`, a 5 s timeout and the page-fetch retry rules (§3.5). Score = (resolved / fetched) × 100, where resolved = a response with status 200–399. `pass` = 100, `partial` 1–99, `fail` 0 or no URL found; skip when there is no llms.txt.

**Maturity.** M3 (single-vendor, or path or schema still changing, §7.1).

**Why this check.** The convention's whole value is the index pointing at canonical content. Broken links in `llms.txt` are worse than no `llms.txt` at all — the agent thinks it has a reliable map and instead chases dead URLs. This catches stale specs the maintainer hasn't updated.

**Why weight 0.5.** Same weight as validity — a `llms.txt` with bad links is functionally indistinguishable from no `llms.txt`. Skips itself when there is no llms.txt; an llms.txt with no URLs fails.

**Provenance.** Operational implication of the llmstxt.org spec, not directly enumerated by it.

**Evidence boundary.** 5s timeout per URL, 200–399 status counts as resolved. Capped at 10 URLs to avoid penalizing large index files unequally.

**Known limitations.** Doesn't measure content freshness — a 200 response with stale content passes. Only the first 10 URLs are sampled, so a large index is judged by its head. The URL pattern stops at `,` and `:`, so a URL containing a port or a comma is truncated and may fail. A link host that blocks w2agent's user-agent counts as broken.

#### `well-known-agent-card` (weight 1.0, info)

**What it measures.** `/.well-known/agent-card.json` validated against A2A v1.0. Pass 100 = `name`, `description`, `version`, a non-empty `supportedInterfaces[]` whose entries each carry an absolute http(s) `url`, `protocolBinding` and `protocolVersion`, a `capabilities` object, `defaultInputModes`/`defaultOutputModes`, and `skills[]` entries each with `id`/`name`/`description`/`tags`. Partial 50 = the v0.3 shape (`name` + absolute `url`, plus `preferredTransport` or a `capabilities` object + `skills[]`), or a stub whose only interface URL is the site homepage. Fail 0 = absent, not JSON, or neither shape.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** `agent-card.json` is the artifact of the **A2A (Agent-to-Agent) protocol** — the discovery descriptor that lets one agent learn another agent's name, capabilities, and authentication mode. A site that publishes it is signaling "I am addressable by other agents, here's the contract." A placeholder card (for example a docs-platform stub pointing at the homepage) is not an agent, so it earns only partial credit.

**Why weight 1.0.** Twice each llms.txt check since 3.0: A2A is IANA-registered and Linux Foundation–governed, and a valid card describes a callable agent, while `llms.txt` is an ungoverned convention. A site can be very agent-friendly without a card, so it stays at 1.0.

**Provenance.** A2A protocol — canonical source is the [a2a-protocol.org](https://a2a-protocol.org) spec; validated against v1.0, with v0.3 accepted as partial. Linux Foundation–stewarded; no IETF/W3C track. Adoption verified 2026-05-08: tends to live on per-agent endpoints rather than corporate apex — `claude.ai/.well-known/agent-card.json` returns 200, but `anthropic.com/.well-known/agent-card.json` returns 404. Same shape applies elsewhere (`google.com` 404, `gemini.google.com` 404 — the agent-card pattern is ahead of vendor adoption at the host level we audit). Apex-only auditing systematically under-measures vendors who scope their agent card to the agent host rather than the company host.

**Evidence boundary.** The file is credited only under the §6 catch-all rule. Presence and type of the listed fields are checked; other fields are ignored, so a card with future fields is not penalized.

**Known limitations.** Doesn't verify the interface URLs answer A2A requests. F4 will tell us whether a valid card correlates with task success.

#### `mcp-server-card` (weight 0, info)

**Tracked (not scored).** Moved from Auth & Access to Agent Discovery in 3.0.

**What it measures.** The first valid card among: `<MCP endpoint>/server-card`; up to 3 `/.well-known/ai-catalog.json` entries of type `application/mcp-server-card+json` (fetched off-origin too, through the fetch allow-hook); the legacy `/.well-known/mcp/server-card.json`. Pass 100 = a JSON object with `name`, `version` and `description`. Fail 0 = a card was found but misses a field (the message names it and where). Skip = no card.

**Maturity.** M3 (single-vendor, or path or schema still changing, §7.1).

**Why this check.** The MCP server card is the static-discoverable counterpart to runtime MCP `initialize` — it lets agents learn server identity and capabilities without opening a transport connection. Cheap to publish; high signal for MCP-aware sites.

**Why weight 0 (tracked).** SEP-2127, which defines the card, is unmerged and three card shapes are live, so the check fails §7 criteria (a) and (b). It was weight 1.0 in 2.0.

**Provenance.** MCP SEP-2127 (server card) and the ai-catalog `application/mcp-server-card+json` entry type. Not merged into the MCP spec.

**Evidence boundary.** On a catch-all site, same-origin endpoint and catalog URLs are not fetched. All fetches share a 10 s budget. Field presence only.

**Known limitations.** Doesn't verify the declared capabilities are accurate. The shape may change when SEP-2127 merges.

#### `agent-skills-index` (weight 0, info)

**Tracked (not scored).** Added 2026-10-14 as a 3.0 tracked addition; no version bump (§2).

**What it measures.** `/.well-known/agent-skills/index.json`, read from the crawler's well-known fetch (a JSON content type is required: `application/json` or a `+json` type, though the RFC requires servers to use `application/json`; a catch-all body counts as absent). Skip = no index. Fail 0 = the body is over 256 KB, is not a JSON object, has a `$schema` that is not a string or is not the known v0.2.0 URI (`https://schemas.agentskills.io/discovery/0.2.0/schema.json`; clients SHOULD NOT process an unrecognized one), has a missing, non-array or empty `skills`, or has an invalid entry. An entry needs `name` (1-64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`), `type` (`skill-md` or `archive`), `description` (1-1024 chars, not blank), `url` (a non-blank string that resolves to an http(s) URL against the index URL, other than the index URL itself, e.g. a fragment-only url) and `digest` (`^sha256:[0-9a-f]{64}$`). The message names the first 3 problems. Partial 50 = every entry valid but `$schema` absent: v0.2.0 requires it, and clients treat such an index as v0.1.0. Pass 100 = valid with the known `$schema`; details list up to 10 `name (type)` lines. Unknown fields are ignored.

**Maturity.** M3 (single-vendor, or path or schema still changing, §7.1).

**Why this check.** The index lets an agent find a site's skills (SKILL.md files or archives) without crawling. Vercel, Cloudflare Developers and isitagentready.com serve one.

**Why weight 0 (tracked).** The RFC is a Cloudflare-led draft, not an IETF document or foundation standard, and v0.1 to v0.2 already renamed the path and replaced the schema, so the check fails §7 criteria (a) and (b).

**Provenance.** Agent Skills Discovery via Well-Known URIs, draft v0.2.0: https://github.com/cloudflare/agent-skills-discovery-rfc

**Evidence boundary.** Never fetches a skill `url` or checks a `digest` against its artifact; the index body is read from the crawler's fetch and is capped at 1 MB there, 256 KB by the check. The legacy v0.1 path `/.well-known/skills/` is not probed.

**Known limitations.** Shape only: it does not confirm the skills exist, match their digests, or are useful.

#### `markdown-alternate` (weight 0.5, info)

**What it measures.** Counts crawled pages with a `<link rel="alternate">` whose `type` contains `markdown` and whose `href` is non-empty. Score = `min(pages_with_alt × 25, 100)`. Any such page → **pass** (even at score 25); none → fail 0.

**Maturity.** M2 (multi-vendor convention or draft with live adoption, §7.1).

**Why this check.** Lets agents skip HTML parsing — fetch the Markdown alt and read prose directly. Most useful for documentation pages where Markdown is already the source format (mdx, docusaurus compile from .md).

**Why weight 0.5.** Optional optimization, not gating. A site with no Markdown alternates is fine if its HTML is parseable. Same weight as each llms.txt check since 3.0: a per-page convenience rather than a site-level overview.

**Provenance.** Standard HTML `<link rel="alternate">` mechanism (HTML5). No agent-specific RFC; surfaced because the convention exists and is cheap to ship.

**Evidence boundary.** Link presence only, on `rel="alternate"` exactly (a multi-valued `rel` is not matched). Score scales 25 per page; 4 or more pages → 100.

**Known limitations.** Doesn't validate the Markdown URL resolves or has parity with the HTML version.

### 6.5 Agent Protocols (category weight 0.13)

> The "can an agent take structured action via emerging protocols?" tier. Mix of forward-looking standards + agent user-agent reachability.

**Category framing.** Agent Protocols is the most heterogeneous category in the rubric — three conceptually different families share this 0.13 weight:

1. **Native agent-protocol surfaces** (`mcp-discovery`, `action-schemas`, `well-known-ucp`; tracked: `webmcp-declarative`, `webmcp-imperative`) — tests for actual structured-action mechanisms a model can invoke programmatically. The forward-looking core.
2. **API discoverability + form structure** (`api-endpoints`, `forms-structured`) — tests for generic agent-friendliness: can an agent see the API surface, can a form be filled by a non-human caller. Less "protocol", more "well-formed HTML for non-human use."
3. **Agent user-agent reachability** (`reach-openai-user-agent`, `reach-perplexity-user-agent`, `reach-google-user-agent`) — does the homepage answer a vendor-documented user-initiated agent user-agent with content.

**Honest disclosure on reach-\* checks.** They are HTTP only: no model is invoked and no claim about task success is made. They replaced the 2.0 per-platform simulation checks, which named outcomes ("can this model use the site?") that they measured with a UA string plus a surrogate fingerprint (§6.9). The reach checks keep only the observable part.

| ID | Weight | Severity | Maturity | What it measures |
|---|---:|---|---|---|
| `mcp-discovery` | 1.5 | info | M1 | MCP endpoint found via homepage links, `/mcp` or `mcp.<domain>`, confirmed by a handshake or an OAuth 401 challenge |
| `api-endpoints` | 1.0 | info | H | Links on crawled pages to OpenAPI, Swagger, GraphQL or API docs, or `<link rel="api">` |
| `forms-structured` | 1.0 | info | M1 | Share of forms whose fields all have a name and a label |
| `well-known-ucp` | 0.5 | info | M2 | `/.well-known/ucp` profile with `ucp.version`, `services` and `payment_handlers` (N/A unless ecommerce) |
| `action-schemas` | 1.0 | info | M2 | Number of pages with JSON-LD `potentialAction`, `SearchAction` or `OrderAction` |
| `webmcp-declarative` | 0 (tracked) | info | M3 | HTML forms declaring WebMCP tools via `toolname` |
| `webmcp-imperative` | 0 (tracked) | info | M3 | `document.modelContext` / `navigator.modelContext` tool registration in page or same-site scripts |
| `reach-openai-user-agent` | 0.5 | info | M1 | Homepage returns 2xx with a body to OpenAI's ChatGPT-User UA |
| `reach-perplexity-user-agent` | 0.5 | info | M1 | Homepage returns 2xx with a body to Perplexity's Perplexity-User UA |
| `reach-google-user-agent` | 0.5 | info | M1 | Homepage returns 2xx with a body to Google's Google-Agent UA |

#### `mcp-discovery` (weight 1.5, info)

**What it measures.** Probes candidate MCP endpoints — same-site MCP links on the homepage, `/mcp`, `mcp.<domain>/mcp`, `mcp.<domain>/` — with `server/discover` (MCP 2026-07-28), falling back to `initialize` (2025-11-25) and then the legacy HTTP+SSE transport. Pass 100 = a handshake (or a modern protocol error) from a Streamable HTTP endpoint. Pass 75 = a 401 with a `WWW-Authenticate: Bearer` challenge carrying `resource_metadata` (auth-gated). Partial 50 = the deprecated HTTP+SSE transport only (auth-gated included). Fail 0 = no endpoint. The discovered endpoint becomes `metadata.mcpEndpoint`, the N/A sentinel for MCP-tier auth checks (§5).

**Maturity.** M1 (standardized, §7.1).

**Why this check.** MCP is the structural primitive for agent ↔ tool communication — Anthropic's bid for the "USB-C of agent integrations." Sites that ship a working MCP endpoint signal first-class agent affordance; sites that don't force agents to fall back to scraping. As the protocol matures (target 2026+), the gap between MCP-native and non-MCP sites will widen.

**Why weight 1.5 (highest in category).** Highest because (a) MCP is a *protocol*, not a static artifact — passing it requires actual server runtime behavior, not just publishing a JSON file; (b) the endpoint it discovers is what the MCP-tier auth checks read: `mcp-auth` is N/A without it, and `oauth-discovery` stays applicable on an MCP-only site.

**Provenance.** MCP spec at modelcontextprotocol.io, governed under the Linux Foundation's Agentic AI Foundation (AAIF); not IETF/W3C. Rewritten in 3.0: the 2.0 probe requested `/.well-known/mcp`, a path no MCP revision defines, so real servers such as `mcp.stripe.com` scored 0.

**Evidence boundary.** Only 307/308 redirects are followed. A 401 counts as an auth-gated endpoint only with the Bearer `resource_metadata` challenge. `/.well-known/mcp` is no longer requested.

**Known limitations.** Only the listed candidates are probed: an MCP server linked only from docs pages or hosted on another domain is missed. Doesn't validate the MCP server actually responds to `tools/list` or other post-init calls.

#### `api-endpoints` (weight 1.0, info)

**What it measures.** Scans every `<a href>` on every crawled page. An indicator is a link whose `href` contains `openapi`, `swagger`, `api-docs` or `graphql`, or whose text matches `\b(rest|graphql)\s+api\b` or `\bapi\s+(reference|docs?|documentation|explorer)\b` (case-insensitive); a page with a `<link rel="api">` element also counts. Any indicator → pass 100; none → fail 0.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** A homepage that visibly advertises its API surface is signaling "agents are welcome." A homepage that hides its API behind hover menus, subdomains, or unlabeled buttons makes the agent's discovery problem materially harder. This pairs with the structural `openapi-spec` check (in agent-auth) to cover both the surface signaling layer and the spec layer.

**Why weight 1.0.** Lower than `mcp-discovery` because this is a soft signal — many serious-API sites don't link to `/api-docs` from the homepage and are no less agent-friendly.

**Provenance.** No spec — observed convention. The "API reference" link-text pattern was added 2026-05-07 after Stripe scoring miss (Stripe's homepage links to "API reference" but not to a `openapi.json` URL).

**Evidence boundary.** Single indicator suffices for pass — we don't require multiple. Binary. Link targets are not fetched, so a dead "API docs" link still passes.

**Known limitations.** Only the crawled pages are scanned — a site that surfaces its API only deeper than the crawl reaches registers fail. Substring matching on `href` is loose (any URL containing `graphql`, such as a blog post slug, counts). SPA-rendered pages whose links are hydrated client-side are penalized (F3).

#### `forms-structured` (weight 1.0, info)

**What it measures.** Every `<form>` on every crawled page. A form is well-structured when each of its `input`, `select` and `textarea` elements, other than `type="hidden"` and `type="submit"`, has a `name` attribute AND a label: a `label[for=<id>]` on the page when the field has an `id`, otherwise an enclosing `<label>`; or `aria-label` / `aria-labelledby`. Score = (well-structured forms / forms) × 100. Pass ≥ 80; partial 1–79; fail 0. Skip when no page has a form.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** An agent filling out a form needs to know what each field means — if inputs lack labels or names, the agent has to infer from placeholders or DOM context, which is unreliable. General accessibility hygiene with high agent-utility carryover.

**Why weight 1.0.** Modest weight because (a) not all sites have forms, (b) the check is most relevant to interactive sites (booking, search, e-commerce). Skipped (`status: skip`, `score: 100`) when no forms found — note the scoring shape: skip credits the site rather than penalizing.

**Provenance.** WCAG 2.1 (W3C) — label/name requirements. The 80% pass threshold is intentional latitude — sites have legitimate exceptions (decorative inputs, hidden sentinels).

**Evidence boundary.** Two requirements per field: label-or-aria AND name. Only `type="hidden"` and `type="submit"` are excluded (`button`, `reset` and `image` inputs still need a name and label). A field with an `id` but no matching `label[for]` is not rescued by an enclosing label. One unlabeled field fails its whole form.

**Known limitations.** Doesn't measure form *purpose* — a labeled "subscribe" form passes equivalently to a labeled "place order" form. Doesn't catch JS-driven dynamic forms hydrated post-render (F3).

#### `well-known-ucp` (weight 0.5, info)

**What it measures.** `/.well-known/ucp` served as JSON with a top-level `ucp` object carrying `version` (a `YYYY-MM-DD` date), a non-empty `services` object and a non-empty `payment_handlers` object whose values are arrays. Pass 100 when all hold; otherwise fail 0, with a message naming what is missing or invalid. Applicable only to sites detected as ecommerce (§5, non-sentinel): elsewhere a fail becomes N/A, while a valid profile still passes and counts.

**Maturity.** M2 (multi-vendor convention or draft with live adoption, §7.1).

**Why this check.** UCP (Universal Commerce Protocol) describes a merchant's commerce services and payment handlers to agents in a machine-readable profile. It is the only merchant protocol with live default-on deployment (every Shopify store).

**Why weight 0.5 (lowest in category).** The profile schema had a breaking change in the 2026-08-25 release, so the check does not meet §7 criterion (b); it is scored under a documented exception (owner decision D-1, §7.3) at the lowest weight, and only where commerce applies.

**Provenance.** Shipped spec under Google/Shopify governance. 2.0 checked existence only, which in practice measured "is this a Shopify store".

**Evidence boundary.** Structural validation of `ucp.version`, `services` and `payment_handlers`; the contents of individual services and handlers are not checked. The §6 catch-all rule applies.

**Known limitations.** Ecommerce detection is heuristic: a content site misdetected as ecommerce is scored on UCP, and a store the detector misses is not penalized for a missing profile. If the next UCP release breaks the profile schema again, the check is demoted to tracked (§7.3).

#### `action-schemas` (weight 1.0, info)

**What it measures.** A page counts when a top-level JSON-LD block has a `potentialAction` property or an `@type` exactly equal to `SearchAction` or `OrderAction`. Score = `min(pages_with_actions × 33, 100)`. Any such page → **pass** (even at score 33); none → fail 0.

**Maturity.** M2 (multi-vendor convention or draft with live adoption, §7.1).

**Why this check.** Schema.org Action types are the static-document equivalent of MCP — they declare "this page supports this kind of programmatic action" in a discoverable, parseable way. A search results page with `SearchAction` JSON-LD lets agents construct queries without parsing HTML; a product page with `OrderAction` declares the buy flow's contract.

**Why weight 1.0.** Equal to `api-endpoints` because both test "can the agent see what actions are available." Lower than `mcp-discovery` because Action JSON-LD is a static declaration, not a runtime protocol — easier to ship, lower engineering bar to clear.

**Provenance.** Schema.org Actions vocabulary (Google-led, Schema.org-stewarded). 2014+ but underused — most sites that ship JSON-LD ship type-of-content metadata, not actions.

**Evidence boundary.** Score scales 33 per page: 1 page → pass at 33, 2 → 66, 3 → 99, 4 or more → 100. Properties nested in `@graph` are not read. A sitewide `WebSite` block carrying `potentialAction` repeats on every page, so it reaches 100 once 4 pages are crawled.

**Known limitations.** Doesn't validate action targets or schemas. Doesn't verify the declared actions actually function. Common false-positive: search forms that declare `SearchAction` but don't accept agent-friendly query parameters.

#### `webmcp-declarative` (weight 0, info)

**Tracked (not scored)** since 3.0 (was 0.75).

**What it measures.** HTML `<form>` elements with a `toolname` attribute (e.g., `<form toolname="searchFlights">`). Pass 100 = at least one found; skip = none. The message reports `n/m task forms declare WebMCP tools`: every `toolname` form counts in both n and m, and unannotated forms count in m unless they are search, login or newsletter forms.

**Maturity.** M3 (single-vendor, or path or schema still changing, §7.1).

**Why this check.** WebMCP-declarative marks up existing HTML forms with agent-tool metadata — `toolname`, `tooldescription`, `toolparamdescription` attributes that turn a form into a callable tool without JavaScript. The lowest-friction agent affordance: site author adds three attributes to existing markup, agents can call the form like a function.

**Why weight 0 (tracked).** WebMCP is in a Chrome origin trial with an API still in motion, so it fails §7 criterion (b). No shipping agent is known to consume the declarative attributes (ChatGPT's browser supports imperative WebMCP only), and Lighthouse also weights WebMCP 0.

**Provenance.** WebMCP — W3C Web Machine Learning Community Group draft (webmachinelearning.github.io/webmcp, 2026-09-10); Chrome origin trial. Not standards-track.

**Evidence boundary.** `toolname` attribute presence on any crawled form. The task-form ratio is informational only.

**Known limitations.** Static HTML only — forms rendered client-side are missed (F3). Presence doesn't show that the declared tool works.

#### `webmcp-imperative` (weight 0, info)

**Tracked (not scored)** since 3.0 (was 0.5).

**What it measures.** `document.modelContext` (CG draft 2026-09-10), the deprecated `navigator.modelContext` alias, or `modelContext.registerTool` in inline code scripts on crawled pages (inline data payloads and Next.js flight data are not scanned, §6.0; a page that only quotes the API in prose or JSON no longer matches). If none is found, up to 5 unique same-site `<script src>` files (resolved against `<base href>`, ≤256 KB each, fetched through the fetch allow-hook, redirects followed only within the site, max 3 hops) are scanned. An `origin-trial` meta token whose feature names WebMCP also counts. Pass 100 = detected; skip = none.

**Maturity.** M3 (single-vendor, or path or schema still changing, §7.1).

**Why this check.** WebMCP-imperative is the JavaScript-API counterpart to webmcp-declarative — sites register tools at runtime via `document.modelContext.registerTool({...})`. Same agent-affordance value, harder to ship than the declarative form.

**Why weight 0 (tracked).** Same origin-trial status as `webmcp-declarative` (§7 criterion (b)); the API moved from `navigator` to `document` during the trial.

**Provenance.** Same WebMCP Community Group draft as `webmcp-declarative`.

**Evidence boundary.** Substring match in inline code scripts (§6.0) and fetched same-site scripts; nothing is executed, and detection is not validation that a registration is well-formed.

**Known limitations.** Registrations in bundles beyond the first 5 same-site scripts, or served from a CDN host, are missed. Static detection can't show that the tool actually registers at runtime (F3 would).

#### `reach-openai-user-agent` (weight 0.5, info)

**What it measures.** Reads the homepage fetch made under OpenAI's documented ChatGPT-User UA string in the multi-UA pass (§6.1, probe set; first in the queue). Pass 100 = final response (redirects followed) 2xx with a non-empty body. Fail 0 = non-2xx (403, 429, 5xx), empty body, timeout or fetch error. `error` (unmeasured) = the pass's time budget ran out before this fetch, or no fetch was recorded.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** ChatGPT-User is the user-agent OpenAI documents for fetches made on a user's request. A site that answers it with a challenge page or a 403 is unusable to that agent whatever its robots.txt says. This measures the edge (WAF, bot management), which `ai-agent-access` cannot see.

**Why weight 0.5.** New signal in 3.0, so it enters at 0.5 or less (§7.2). The three reach checks together weigh 1.5, the same as `mcp-discovery`.

**Provenance.** UA string from OpenAI's crawler documentation (the source URL is stored in `bot-tokens.ts`). Vendor-documented observable HTTP behaviour qualifies under §7 criterion (a).

**Evidence boundary.** HTTP only — robots.txt posture is scored by `ai-agent-access`. One homepage request, single shot (no retries), judged on status and body length only: the challenge fingerprint recorded for the same response is not read here, so a challenge page served with a 2xx passes (the tracked `edge-agent-access` does read it).

**Known limitations.** A UA string is not the vendor's real traffic: bot managers that verify IP ranges or request signatures may treat the real agent differently, in either direction. Homepage only. No control comparison, so a site that is simply down fails all three reach checks. No model is invoked.

#### `reach-perplexity-user-agent` (weight 0.5, info)

**What it measures.** Same test as `reach-openai-user-agent`, on the homepage fetch made under Perplexity's documented Perplexity-User UA string (second in the queue).

**Evidence boundary.** Same as `reach-openai-user-agent`.

**Maturity.** M1: vendor-documented user-agent string, observable HTTP behaviour.

**Why this check.** Perplexity-User is the user-agent Perplexity documents for fetches made on a user's request; same reasoning as `reach-openai-user-agent`.

**Why weight 0.5.** Same as `reach-openai-user-agent`.

**Provenance.** UA string from Perplexity's crawler documentation (source URL stored in `bot-tokens.ts`).

**Known limitations.** Same as `reach-openai-user-agent`.

#### `reach-google-user-agent` (weight 0.5, info)

**What it measures.** Same test as `reach-openai-user-agent`, on the homepage fetch made under Google's documented Google-Agent UA string (third in the queue), sent verbatim including its `Chrome/W.X.Y.Z` version placeholder.

**Evidence boundary.** Same as `reach-openai-user-agent`.

**Maturity.** M1: vendor-documented user-agent string, observable HTTP behaviour.

**Why this check.** Google-Agent has no robots.txt token, so this is the only scored check that sees how a site treats it. There is no Claude-User reach check: Anthropic publishes the robots token but no UA string.

**Why weight 0.5.** Same as `reach-openai-user-agent`.

**Provenance.** UA string from Google's user-triggered fetchers documentation (source URL stored in `bot-tokens.ts`).

**Known limitations.** Same as `reach-openai-user-agent`; in addition, being third in the queue, it is the first of the three to become `error` on a site slow enough to exhaust the pass budget.

### 6.6 Technical Foundations (category weight 0.10)

> The "table-stakes web hygiene" tier. Not agent-specific but a precondition for everything else.

| ID | Weight | Severity | Maturity | What it measures |
|---|---:|---|---|---|
| `https` | 2.0 | error | M1 | Every crawled page URL is `https://` |
| `security-headers` | 1.0 | warning | M1 | Share of HSTS, CSP, X-Content-Type-Options, X-Frame-Options on the homepage response |
| `canonical-urls` | 1.0 | warning | M1 | Share of pages with `<link rel="canonical">` |
| `mobile-viewport` | 0.5 | warning | M2 | Share of pages with a non-empty `<meta name="viewport">` |
| `charset-utf8` | 0.5 | warning | M1 | Share of pages declaring UTF-8 in markup or the Content-Type header |
| `no-js-dependency` | 1.0 | warning | H | Share of pages that are not SPA shells and carry enough words without JS |

#### `https` (weight 2.0, error)

**What it measures.** Every crawled page's URL starts with `https://` → pass 100; otherwise fail 0. Binary.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** HTTPS is universal-baseline web hygiene as of 2024. A site serving content over HTTP is opting out of modern browser security (HSTS, secure cookies, mixed-content protection) and signaling broader infrastructural neglect. For agents, HTTP is also a liability — credentials sent over HTTP can be stolen, and agents acting on behalf of users may inadvertently leak data.

**Why weight 2.0 (highest in category).** Highest because HTTPS is binary and the negative case is genuinely disqualifying. Severity is `error` — there is no acceptable reason for a public-facing API or content site to serve HTTP in 2024+.

**Provenance.** TLS / HTTPS — universally adopted since 2018 (Google's HTTPS-everywhere push, Let's Encrypt's free certs). Browsers now mark HTTP sites as "Not Secure."

**Evidence boundary.** URL prefix match on the URL each page was requested at (the audited URL and the sitemap or link URLs the crawl selected), not the final URL after redirects. An `http://` audit URL that redirects to HTTPS therefore fails, and an `https://` URL that redirects down to HTTP passes.

**Known limitations.** Doesn't validate certificate trust chain or expiration, although a TLS failure on the homepage stops the audit as `unreachable` (§3.5). Redirect targets are not inspected (see boundary).

#### `security-headers` (weight 1.0, warning)

**What it measures.** On the homepage page fetch (page 0), counts which of 4 headers are present with a non-empty value: `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`. Score = (present / 4) × 100. Pass ≥ 75 (3 of 4); partial 25–50; fail 0. Skip when there are no pages.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** Security headers protect users from common attack patterns (XSS, clickjacking, MIME sniffing, downgrade attacks). For agents acting on behalf of users, these protections carry through — an agent submitting credentials to a site that's vulnerable to clickjacking is putting the user at risk.

**Why weight 1.0.** Lower than HTTPS because the headers are hardening, not gating. Sites missing all 4 headers are still functional; they're just leaving security wins on the table.

**Provenance.** Each header has its own spec — CSP (W3C), HSTS (RFC 6797), X-Frame-Options (RFC 7034), X-Content-Type-Options (browser-vendor consensus, formalized in MDN). Modern best-practice ships all four.

**Evidence boundary.** Header names are matched case-insensitively on the final homepage response. `Content-Security-Policy-Report-Only` does not count as CSP. Values are not parsed.

**Known limitations.** Only checks homepage — doesn't sample headers across multiple pages (which can differ for app subroutes vs static pages). Doesn't validate header *values* (a permissive CSP that allows `unsafe-eval` passes equivalently to a strict one).

#### `canonical-urls` (weight 1.0, warning)

**What it measures.** Pages with `<link rel="canonical">` carrying a non-empty `href`. Score = (qualifying / crawled pages) × 100. Pass ≥ 80; partial 1–79; fail 0.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** Canonical URLs tell agents and crawlers which URL is the "real" version when multiple paths serve the same content (trailing slashes, tracking parameters, www vs apex, mobile vs desktop). Without canonicals, an agent indexing a site may double-count duplicate content or pick the wrong URL to cite back.

**Why weight 1.0.** Modest because the impact is mostly on aggregation / citation quality, not on basic agent function. Most well-maintained sites ship canonicals universally; sites that don't are typically also missing OpenGraph and other metadata hygiene.

**Provenance.** `rel="canonical"` link relation — Google/Yahoo/Microsoft joint introduction (2009), formalized in HTML5.

**Evidence boundary.** Presence of `<link rel="canonical">` on the page. Doesn't validate the href is well-formed or matches the page itself.

**Known limitations.** Doesn't catch pages that ship canonical pointing at the wrong URL (e.g., all pages claiming the homepage as canonical — a real anti-pattern). Doesn't validate canonical href is reachable.

#### `mobile-viewport` (weight 0.5, warning)

**What it measures.** Pages with `<meta name="viewport">` carrying a non-empty `content`. Score = (qualifying / crawled pages) × 100. Pass ≥ 80; otherwise **fail** with that score (there is no partial).

**Maturity.** M2 (multi-vendor convention or draft with live adoption, §7.1).

**Why this check.** Mobile viewport meta tag is universal-baseline modern web (>10 years). Sites missing it are probably also missing other modern hygiene. Mostly indirect signal of "is this a maintained site?"

**Why weight 0.5.** Low because the agent impact is minimal — agents don't render mobile-vs-desktop. The check is more "site is maintained" than "agent-ready."

**Provenance.** W3C Mobile Web Best Practices + Apple's iOS 1 viewport meta (2007). Google has flagged sites without viewport for ~10 years.

**Evidence boundary.** Tag present. Doesn't validate the content attribute (`width=device-width, initial-scale=1` is the standard, but anything passes).

**Known limitations.** Pure presence check. Some legitimately desktop-only legacy sites won't have it and aren't necessarily failing — though in 2024+ those sites are vanishingly rare.

#### `charset-utf8` (weight 0.5, warning)

**What it measures.** A page qualifies when its first `<meta charset>` value equals `utf-8` (case-insensitive), or — when there is no `<meta charset>` — a `<meta http-equiv="Content-Type">` content contains lowercase `utf-8`, or its HTTP `Content-Type` header contains `utf-8` (case-insensitive). Score = (qualifying / crawled pages) × 100. Pass ≥ 80; otherwise **fail** with that score (there is no partial).

**Maturity.** M1 (standardized, §7.1).

**Why this check.** Without explicit UTF-8 declaration, parsers fall back to byte-sniffing or platform defaults — leading to mojibake on non-ASCII content (smart quotes, accents, emoji, non-Latin scripts). Agents extracting prose from such pages get corrupted text. UTF-8 declaration is one-line code change; missing it is an artifact of legacy markup.

**Why weight 0.5.** Low because most content ASCII-only and would be parsed correctly even without the declaration. Still flagged because the failure mode (mojibake) is silent and hard to debug.

**Provenance.** HTML5 spec recommends UTF-8 universally. Backed by RFC 3629 (UTF-8 encoding) and HTML5 § parsing.

**Evidence boundary.** Either source → qualifies (markup OR HTTP header). `utf8` without the hyphen does not match, and an `http-equiv` value written `UTF-8` in upper case is not read (the header or `<meta charset>` still count).

**Known limitations.** Doesn't validate that page bytes are actually valid UTF-8 — only that the charset is declared. A page declaring UTF-8 but shipping ISO-8859-1 bytes registers as pass here.

#### `no-js-dependency` (weight 1.0, warning)

**What it measures.** Per page, on the raw HTML and the visible-text word count plus the `noscript` word count (§6.0):
- Framework markers (substring): `__NEXT_DATA__`, `window.__nuxt__`, `ng-app`, `ng-version`, `data-reactroot`, `data-v-app`, `__svelte`, `ember-application`.
- SPA shell = all three of: an empty mount point (`<div id="__next|root|app|__nuxt">` or a `data-reactroot` div with only whitespace inside); fewer than 5 `<a … href=` tags; and ((visible + `noscript` word count) × 5) / (total bytes of `<script>…</script>` tags) < 0.2 (a page with no script tags is never a shell).
- A page qualifies if it is NOT a shell AND has ≥ 100 words (visible + `noscript`) when a framework marker is present, or ≥ 50 words otherwise.

Score = (qualifying / crawled pages) × 100. Pass ≥ 70; partial 1–69; fail 0. The report adds the `js-heavy-site` warning when this score is ≤ 30, or ≤ 50 with `token-efficiency` ≤ 30.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** This is the *load-bearing* check for our entire static-audit methodology. A site whose content is hydrated client-side delivers an empty (or near-empty) shell to non-JS-executing crawlers — which is what we are. We can detect this and avoid scoring such sites against signals they ship via JS, but we can't actually *measure* their content. The check fails such pages, but the more important framing is: this check is the credibility roadmap's F3 (JS-render layer) wedge — it tells us where our methodology has a known measurement gap.

**Why weight 1.0.** Modest because the failure case is "we couldn't measure" not "site is broken." Sites scoring 0 here may actually be fine for agents that do execute JS (Claude with browser-use, ChatGPT with retrieval). The score is honest about our static-audit limitation, not the site's quality.

**Provenance.** Heuristics are our authorship. SPA-shell thresholds (5 anchors, 0.2 text-to-script ratio) calibrated against openai.com / anthropic.com / perplexity.ai (true positives) and tech-doc pages (true negatives).

**Evidence boundary.** Three-signal AND for shell detection (mount point + low anchors + script-dominated). Word-count threshold differs by framework presence (100 with, 50 without) — sites using a framework are held to a higher bar because their pre-hydration HTML can be misleadingly word-rich.

**Known limitations.** **This is the F3 roadmap item.** Static-only auditing systematically under-measures SPA-rendered sites. Modern docs platforms (Stripe, Anthropic, Vercel, Cloudflare developer portals) ship as SPAs with hydrated content — we measure ~5–10% of their actual content and call it "agent readiness." F3's headless-browser layer would close this. Until then, this check is the *honest disclosure* of where the methodology breaks.

### 6.7 Auth & Access (category weight 0.20)

> The "can an agent authenticate and act, not just read?" tier. Heaviest category — also the most contentious. The 11 checks (10 scored, 1 tracked) split across an explicit tiering: T1 (universal API fundamentals), T2 (OAuth discovery), T3+ (MCP authorization, CIMD, API catalog, operator signing).

**Tier philosophy.** This category is the heaviest (0.20) because authenticated action — not reading — is the agentic capability that matters for enterprise use cases. The 11 checks partition into:

- **T1 — universal API fundamentals (weights 2.0 / 1.5).** What any serious public API ought to expose in 2024+. Failures here are real failures.
- **T2 — OAuth discovery (weights 3.0 / 1.5).** The RFC 9728 → RFC 8414 discovery chain and PKCE (RFC 7636). Real failures *for sites exposing an API or an MCP endpoint*; other sites are NA-cascaded.
- **T3+ — emerging agent-era (weights 1.5 / 1.0 / 0.5 bonus / 0 tracked).** MCP authorization, Client ID Metadata Documents, RFC 9727 API catalogs, Web Bot Auth operator signing. NA-cascaded, skip-unless-present or tracked, so sites that haven't claimed these standards aren't punished.

Tier identity is implicit in weight values — candidate work item: formalize as a `tier` property on `Check` and surface in the report UI. These T1–T3 weight tiers are unrelated to the M1–M4 maturity tiers of §7.1.

**Shared probes.** Several checks in this category share per-audit probes, each a GET with a 5 s timeout, retried once after 2 s on a 5xx or a network error, body read up to 256 KB:
- **API probes:** `<origin>/api/` and `https://api.<last two labels of the host>/`.
- **Portal probe:** the paths `/developers`, `/developer`, `/api`, `/docs/api`, `/api-docs` on the audited origin (in parallel; the first in that list order that answers 2xx with an HTML or missing `content-type` wins; skipped entirely on a catch-all site), then `https://docs.`, `developers.`, `developer.` + apex host, one at a time under the same rule. A 2xx reply whose `content-type` is JSON, YAML, XML or plain text is a machine endpoint, not a portal, and is passed over; it still counts as a response, so a site where only such replies came back scores fail 0, not skip. The portal text is the HTML with `<script>`/`<style>` blocks and tags removed. When no probe got any response, the portal probe "had no network".
- **Key-docs probe:** `/keys`, `/api-keys`, `/docs/keys` on the audited origin (skipped on a catch-all site), then on `docs.` + apex host; first 2xx wins, same text extraction.

#### T1 — Universal API fundamentals

> What any serious public API ought to expose.

| ID | Weight | Severity | Maturity | What it measures |
|---|---:|---|---|---|
| `public-api` | 2.0 | info | H | An API probe answers 2xx/4xx with a JSON or YAML content type, or the homepage links to `/api` paths or the `api.` host |
| `openapi-spec` | 2.0 | info | M1 | An OpenAPI/Swagger JSON document was discovered, with at least one operation |
| `developer-portal` | 2.0 | info | H | The portal probe found a page, with ≥ 1000 characters of text for a pass |
| `agent-auth-docs` | 2.0 | info | H | Portal, key-docs and homepage text pair API-key/OAuth/rate-limit terms with agent/bot/scope/permission/token terms |
| `scoped-permissions` | 1.5 | info | H | Portal and key-docs text show scope syntax, scope wording or graduated-access vocabulary |

##### `public-api` (weight 2.0, info)

**What it measures.** Reads the two API probes (above). Pass 100 = either answers 2xx or 4xx with a `Content-Type` containing `json` or `yaml` (a real API correctly returns 4xx with a structured error when called without auth). Otherwise counts, in the homepage HTML (lower-cased), `href` values containing `/api/` or ending in `/api`, plus `href` values containing `api.<host>`: 3 or more → pass 100; 1–2 → partial 50; 0 → fail 0.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** A site's *machine-callable surface* is the foundational primitive for everything else in this category. Without a public API, no agent can transact — they can only read. Our probe accepts auth-required 4xx responses because that's how mature APIs respond to unauthenticated requests; rejecting them would unfairly penalize platforms doing the right thing.

**Why weight 2.0 (highest tier).** Equal-weight with `openapi-spec`, `developer-portal`, `agent-auth-docs` because all four are co-required: a public API with no portal docs is unusable, and a portal with no real API is hollow. Failure here cascades (§5): `openapi-spec`, `developer-portal` and `api-catalog-rfc9727` become N/A, `oauth-discovery` too when no MCP endpoint exists, and the portal's dependents follow. These rules are non-sentinel, so a dependent check that passes or partially passes keeps its result.

**Provenance.** Convention rather than spec — `/api/` and `api.<host>` are observed defaults across major SaaS platforms (Stripe, Twilio, GitHub, OpenAI all match). Not standards-track.

**Evidence boundary.** Content type and status only; the body is not parsed. The `api.` host is formed from the last two labels of the audited host, so on a `.co.uk`-style domain it points at the wrong host. The link count reads the homepage only.

**Known limitations.** Sites that serve their API only from another subdomain (e.g., `developers.<host>`, `cloud.<host>/api`) may register as fail. A JSON 404 at `/api/` from a generic web framework passes. Doesn't validate the API responds usefully — only that *something* structured is at the conventional path.

##### `openapi-spec` (weight 2.0, info)

**What it measures.** Whether the audited site exposes an OpenAPI/Swagger specification with at least one endpoint defined. Spec discovery happens upstream during crawling; this check reads `metadata.openapi`. Pass = ≥1 endpoint. Partial = spec found but no endpoints. Fail = no spec.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** OpenAPI is the lingua franca of machine-readable API contracts. Without it, an agent has to scrape docs prose to learn endpoint shapes — slow, lossy, error-prone. With it, the agent gets typed inputs/outputs in 2KB. Critical primitive for action-taking agents.

**Why weight 2.0.** Co-equal with `public-api` — having an API surface and having a contract for it are paired requirements. NA-cascaded when `public-api` fails, unless it passes or partially passes (non-sentinel, §5).

**Provenance.** OpenAPI Initiative (Linux Foundation), spec at openapis.org. Originated 2010 as Swagger; OpenAPI 3.x is the modern form. Widely adopted; one of the most CIO-recognized standards in this category.

**Evidence boundary.** Discovery (`probeOpenAPIPaths` in `packages/core/src/shared/openapi.ts`) runs during metadata probing in three phases, first hit wins: (1) 15 conventional paths on the audited origin — `/openapi.json`, `/swagger.json`, `/.well-known/openapi`, `/api-docs`, `/api/docs`, `/v3/api-docs`, `/v2/api-docs`, `/swagger/v1/swagger.json`, `/swagger/doc.json`, `/api/v3/openapi.json`, `/api/openapi.json`, `/api/swagger.json`, `/spec.json`, `/api-docs.json`, `/docs/openapi.json`; (2) the spec URL embedded in a Swagger UI page returned by one of those paths; (3) homepage `href` values containing `openapi`, `swagger`, `api-docs`, `api/docs` or `spec.json`. A candidate counts only when it answers 200 with a JSON body that has an `openapi` or `swagger` field; YAML specs are not parsed. Phases 2 and 3 follow only same-origin URLs unless the caller allows other hosts. Up to 200 operations are read.

**Known limitations.** Doesn't validate the spec is current, complete, or syntactically conformant — just that it parses and has endpoints. A spec listing 100 deprecated endpoints passes equivalently to one listing 100 live endpoints. YAML-only specs and specs hosted on another origin (commonly an `api.` or `docs.` host) are missed. A graded OpenAPI check (operationId coverage, descriptions, security schemes) is planned but not in 3.0.

##### `developer-portal` (weight 2.0, info)

**What it measures.** Reads the portal probe (above). Portal found with ≥ 1000 characters of text → pass 100; found with less → partial 50; not found → fail 0; skip when the portal probe had no network.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** The portal is where humans build the integration. An agent that needs to understand a platform's auth model, rate limits, idempotency keys, webhook signatures — they all live in the portal prose, not the OpenAPI spec. Without a portal, agentic integration is materially harder.

**Why weight 2.0.** Co-equal with `public-api` and `openapi-spec` — these three are the universal-fundamental triad. Failure NA-cascades `agent-auth-docs` and `scoped-permissions`, and, together with a failing `oauth-discovery`, `pkce-s256`; a dependent that passes or partially passes keeps its result (non-sentinel, §5).

**Provenance.** No formal spec — convention. The 8 path/subdomain probes are observed-defaults across SaaS platforms. Pattern verified against Stripe, Twilio, OpenAI, GitHub, Cloudflare.

**Evidence boundary.** Post-strip text length is the gate: 1000 chars is roughly "full first page of meaningful prose." Below that, the portal is likely a CSS-shell SPA whose content is hydrated client-side (which JS-render F3 will fix). Same-origin portal paths are not requested on a catch-all site (§6), where only the subdomains can pass. A 2xx counts as found only when its `content-type` contains `html` or is missing (unknown, not penalised): a `docs.` host that serves a login page or a marketing page is credited by its text length, but a JSON index at `/api` is not, and no longer shadows an HTML page at a later path. `agent-auth-docs`, `scoped-permissions` and the `pkce-s256` documentation fallback read this text, so they now see the HTML page, not a JSON index.

**Known limitations.** SPA portals (which most modern docs sites are) return CSS shell + 200–600 chars of meaningful static HTML, hitting partial when the underlying portal is rich. F3 closes this. Doesn't follow homepage links to non-conventional portal locations.

##### `agent-auth-docs` (weight 2.0, info)

**What it measures.** Joins the portal text, the key-docs text and the homepage text (tags stripped) into one lower-cased corpus. For every occurrence of an anchor term, a pair is counted when any qualifier term appears as a substring within 200 characters before the anchor's start or after its end. Pass 100 = ≥ 3 pairs; partial 50 = 1–2; fail 0 = none; skip when the portal probe had no network.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** A site that documents its API but never mentions agents/bots/permissions in proximity to its auth section is signaling "this API was designed for human-developer integration only." Agentic use cases need explicit treatment of bot identity, scoped tokens, and permission boundaries — not as afterthought, but in the auth chapter itself.

**Why weight 2.0.** Equal to other T1 checks because *agent-aware documentation* is qualitatively different from *general API documentation*. A site can have a perfect OpenAPI spec and a thick developer portal and still leave agents unsupported if the docs treat "third-party integration" only as "human dev pulls token, hardcodes it in their app."

**Provenance.** No spec. Pattern is observed in agent-friendly platforms (Stripe's restricted-keys docs, OpenAI's API key permissions, Anthropic's agent-builder docs). Co-occurrence heuristic is our authorship; the choice of vocabulary is open to calibration (P4-2).

**Evidence boundary.** `countNearbyPairs(text, anchors, qualifiers, 200)`. Anchors: `api key`, `oauth`, `rate limit`. Qualifiers: `agent`, `bot`, `ai`, `scope`, `permission`, `token`. One anchor occurrence counts at most once, however many qualifiers are near it. Homepage text is included even when no portal was found.

**Known limitations.** Substring matching is loose: the qualifier `ai` matches inside words such as "email", "detail" or "maintain", so almost any anchor occurrence in real prose forms a pair. False-positive risk also from negation: docs that say "agents must never access this API" still match. Vocabulary list is English-only. Could be tightened with embedding-based semantic match in a later rubric (not changed in 3.0).

##### `scoped-permissions` (weight 1.5, info)

**What it measures.** Joins the portal and key-docs text (not the homepage). Signals, summed: (a) each match of `\b(read|write|admin|delete|update):\w+`; (b) each occurrence of `scope` with `permission`, `token` or `access` within 200 characters; (c) each line matching `^[-*]\s+\w+:\w+`; (d) one per matching graduated-access pattern — `restricted (api )?keys`, `read-only` / `read or|and|& write`, `custom|limited|scoped|restricted|granular permissions`, `limit(s|ed) access`. Total ≥ 3 → pass 100; 1–2 → partial 50; 0 → fail 0. No portal or key-docs text → fail 0, or skip when the portal probe had no network.

**Maturity.** H (heuristic with no external standard, §7.1).

**Why this check.** Agents acting on behalf of users need scoped credentials — a "post tweets" token shouldn't be able to delete the account. Sites that document granular permission tiers (Stripe's restricted keys, GitHub's fine-grained PATs) are agent-friendly by design. Sites with only one all-powerful API key force the agent to be over-privileged.

**Why weight 1.5 (lower than other T1).** Half-weight from the universal-fundamental triad because *some* APIs are inherently single-tier (read-only public data APIs, e.g.) and don't need scopes — we didn't want to penalize those at the same level as missing OpenAPI. Still T1 because for any auth-requiring transactional API, scoped permissions are a 2024-baseline expectation.

**Provenance.** OAuth scopes (RFC 6749 §3.3), GitHub fine-grained PATs (2022), Stripe restricted keys (2017), per-app permissions (Slack, Notion). The graduated-access regex patterns are tuned against Stripe's restricted-keys page specifically — added 2026-05-07 after Stripe scoring miss.

**Evidence boundary.** Four signal channels (regex scope syntax, scope-keyword pairs, bullet patterns, graduated-access vocabulary). Threshold = 3 for pass to require *some breadth* of signal — a single mention isn't enough, but three matches of one channel (three `read:x` scopes) also pass. Channel (c) rarely fires: tag stripping collapses the text to one line, so the pattern can match only at its very start.

**Known limitations.** English-only vocabulary. Doesn't measure whether documented scopes are *actually enforced* by the auth system.

#### T2 — OAuth discovery

> The discovery chain an agent follows from a 401 to a token endpoint, plus PKCE.

| ID | Weight | Severity | Maturity | What it measures |
|---|---:|---|---|---|
| `oauth-discovery` | 3.0 | info | M1 | 401 / protected resource metadata → issuer-matched authorization server metadata (RFC 9728 → RFC 8414) |
| `pkce-s256` | 1.5 | info | M1 | `S256` declared by the resolved authorization server, or PKCE + S256 mentioned in docs |

##### `oauth-discovery` (weight 3.0, info)

**What it measures.** Entry points, in precedence order: a 401 from `/api/`, `api.<domain>/` or the discovered MCP endpoint (the Bearer `resource_metadata` URL if present, else path-inserted then root `/.well-known/oauth-protected-resource`), then the crawled root protected resource metadata (PRM). The first entry that resolves a full chain wins; otherwise the first valid PRM is scored. A PRM must be JSON with a `resource` covering the requested URL (same origin, path prefix) and non-empty `authorization_servers`. Authorization server (AS) metadata is tried in the MCP 2026-07-28 order (RFC 8414 and OpenID Connect discovery, with path insertion), off-origin allowed; `issuer` must be the identical string (only an origin-only issuer may differ by a trailing `/`). Pass 100 = full chain to AS metadata with `authorization_endpoint` and `token_endpoint`. Partial 50 = a valid PRM but no usable AS, or no PRM but a valid root AS whose issuer is the site origin. Fail 0 otherwise.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** The chain is how an agent that hits a 401 learns where to get a token: RFC 9728 metadata names the authorization server, and RFC 8414 / OIDC metadata gives its endpoints. The 2.0 checks probed only the site root, so APIs whose issuer lives on Auth0, Okta or another origin under-scored, and one of them only checked that a file parsed.

**Why weight 3.0.** A merge of three 1.5 checks that each measured part of this one fact. A merge of already-scored facts is not a promotion (§7.2); the weight was set in the 3.0 rubric-change table.

**Provenance.** RFC 9728 (April 2025) Protected Resource Metadata; RFC 8414 (June 2018) Authorization Server Metadata; OpenID Connect Discovery; discovery order per the MCP 2026-07-28 authorization spec. IETF standards-track.

**Evidence boundary.** Off-origin PRM and AS documents are fetched through the fetch allow-hook (SSRF guard). An issuer-matched document without both endpoints does not stop the walk. 15 s budget for the whole chain. NA-cascaded when `public-api` fails and no MCP endpoint was found, unless it passes or partially passes (non-sentinel, §5).

**Known limitations.** Doesn't exercise the endpoints (no token request). An API that returns 401 only on paths other than `/api/`, `api.<domain>/` or the MCP endpoint, and publishes no root PRM, is missed.

##### `pkce-s256` (weight 1.5, info)

**What it measures.** `code_challenge_methods_supported` includes `S256` on the complete authorization server (issuer match + both endpoints) resolved by `oauth-discovery`, or by its root-AS fallback → pass 100. Otherwise, when the portal probe found a portal whose text contains both `pkce` and `s256` (case-insensitive) → partial 50. Otherwise fail 0; skip when no AS was resolved and the portal probe had no network. Key-docs text is not read.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** PKCE with S256 is the OAuth security baseline for public clients (mobile apps, SPAs, agents). RFC 6749 + RFC 7636 + the OAuth 2.1 BCP all require it. A site offering OAuth without PKCE is offering a token-leak vulnerability.

**Why weight 1.5.** Unchanged from 2.0 — RFC 7636 is a 2015 spec, ratified, no excuse. NA-cascaded when BOTH `oauth-discovery` AND `developer-portal` fail (because we can detect it from either source), unless it passes or partially passes (non-sentinel, §5). Absorbs the 2.0 MCP-specific PKCE check, which measured the same fact a second time.

**Provenance.** RFC 7636 (September 2015) — Proof Key for Code Exchange. Required by OAuth 2.1 (BCP 240, in progress). S256 is one of two methods (the other, "plain", is deprecated for security reasons).

**Evidence boundary.** Direct declaration in `code_challenge_methods_supported` on the resolved AS is the gold signal — including an off-origin AS, which 2.0 never read. Portal mention without declaration is partial — it suggests the platform supports it but isn't advertising via the canonical mechanism.

**Known limitations.** Portal-text fallback is regex-based — false-positives possible if docs discuss PKCE in the negative ("we don't support PKCE yet").

#### T3+ — Emerging standards (subject to NA cascade)

> Forward-looking artifacts. NA cascade, skip-unless-present and tracking ensure sites that haven't claimed these standards aren't punished.

| ID | Weight | Severity | Maturity | What it measures | Cascades on |
|---|---:|---|---|---|---|
| `mcp-auth` | 1.5 | info | M1 | The MCP endpoint's 401 Bearer challenge links valid protected resource metadata of its own | no `metadata.mcpEndpoint` (sentinel) |
| `cimd-support` | 0.5 | info | M1 | Bonus: the resolved AS sets `client_id_metadata_document_supported: true` | *(none — skips unless it passes)* |
| `agent-operator-signing` | 0 (tracked) | info | M1 | Web Bot Auth signing directory whose `signature_agent` is the audited origin | *(none — tracked)* |
| `api-catalog-rfc9727` | 1.0 | info | M1 | `/.well-known/api-catalog` RFC 9727 linkset | `public-api` |

##### `mcp-auth` (weight 1.5, info)

**What it measures.** On an MCP endpoint that answers 401 with a `WWW-Authenticate: Bearer` challenge: pass 100 when the linked protected resource metadata is valid for the endpoint and is not the document `oauth-discovery` already scored; partial 50 when no valid PRM is found; fail 0 when the 401 carries no Bearer challenge. Skip when there is no endpoint or recorded handshake, when the endpoint answers without authorization, or when its PRM is the document `oauth-discovery` scored (the usual case on an MCP-only site).

**Maturity.** M1 (standardized, §7.1).

**Why this check.** MCP authorization requires a protected server to answer unauthenticated requests with a Bearer challenge that points at its protected resource metadata; without it a client can't start OAuth. It is measured apart from `oauth-discovery` only when the MCP endpoint has its own PRM, so the shared case skips instead of counting one document twice.

**Why weight 1.5.** A merge of two 1.0 checks from 2.0; not a promotion (§7.2). The weight was set in the 3.0 rubric-change table.

**Provenance.** MCP authorization spec, built on RFC 9728 and RFC 6750 Bearer challenges. The 2.0 check read `capabilities.auth.type`, a field that exists in no MCP schema.

**Evidence boundary.** Sentinel cascade on `metadata.mcpEndpoint` (§5): without a discovered endpoint the result is skip with score 0.

**Known limitations.** Doesn't continue to the authorization server (`oauth-discovery` does that from its own entry points). Doesn't test that a token is accepted.

##### `cimd-support` (weight 0.5, info)

**What it measures.** Pass 100 when `oauth-discovery` resolved a full chain and the authorization server metadata sets `client_id_metadata_document_supported: true`. Every other case is skip, including a server that offers only a `registration_endpoint` (Dynamic Client Registration), which is neutral.

**Maturity.** M1 (standardized, §7.1): an IETF OAuth working-group document, still a draft.

**Why this check.** Client ID Metadata Documents let an agent identify itself with a URL-hosted client document instead of registering with every authorization server. MCP 2026-07-28 deprecates Dynamic Client Registration in its favour.

**Why weight 0.5 (bonus).** A new signal enters at 0.5 or less (§7.2). Because it can only pass or skip, it never lowers a score: it enters the denominator only when it also adds a full score. Scored under a documented exception (§7.3).

**Provenance.** IETF OAuth working-group draft (Client ID Metadata Document); preferred by the MCP 2026-07-28 authorization spec.

**Evidence boundary.** The AS metadata flag only, on a full `oauth-discovery` chain.

**Known limitations.** Doesn't fetch or validate a client metadata document, and doesn't test that the server accepts one.

##### `agent-operator-signing` (weight 0, info)

**Tracked (not scored).** Added in 3.0 in place of the 2.0 signing-directory check (weight 1.0).

**What it measures.** `/.well-known/http-message-signatures-directory` served as `application/http-message-signatures-directory+json`. Pass 100 = a `keys` array with an Ed25519 JWK (`kty` OKP, `crv` Ed25519, `x`) and a `signature_agent` whose origin is the audited origin. Fail 0 = no such key, or `signature_agent` missing or on another origin. Skip = no directory.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** Web Bot Auth lets a bot operator sign its requests (RFC 9421) and publish the keys in this directory. The directory describes the operator of a signing agent, not the site being audited, so it says nothing about whether agents can use that site. It is reported for sites that operate signing agents.

**Why weight 0 (tracked).** Wrong subject for an agent-readiness score, although the underlying spec is IETF-track. The 2.0 check scored any parseable file at this path.

**Provenance.** RFC 9421 (February 2024) — HTTP Message Signatures; the directory and `signature_agent` come from the IETF Web Bot Auth drafts.

**Evidence boundary.** Media type exact match and the §6 catch-all rule. Key shape and origin match only.

**Known limitations.** Doesn't verify signatures or that the operator's traffic uses these keys.

##### `api-catalog-rfc9727` (weight 1.0, info)

**What it measures.** `/.well-known/api-catalog` served as `application/linkset+json` whose `linkset` array has at least one entry with an `anchor` and a non-empty `item`, `service-desc` or `service-doc` array of `href` objects → pass 100. Absent, wrong media type, no `linkset` array, or no such entry → fail 0.

**Maturity.** M1 (standardized, §7.1).

**Why this check.** RFC 9727 (API Catalog) is a standards-track approach to exposing "here is the list of APIs this organization runs and where to find them." Useful for multi-API platforms (e.g., a single bank exposing accounts + payments + cards APIs). An agent that wants to find the right API for a task can read one file instead of crawling the dev portal.

**Why weight 1.0.** T3+ baseline. Cascades on `public-api` (no APIs = no catalog). Adoption is currently very sparse — included to give the convention presence rather than to materially penalize sites that haven't shipped one.

**Provenance.** RFC 9727 — IETF standards-track. New enough that adoption is mostly experimental.

**Evidence boundary.** The request sends `Accept: application/linkset+json`; the response media type must match exactly and the body must differ from a random `/.well-known/` control fetched with the same `Accept` (§6 catch-all rule). The 2.0 `apis[]` format is not RFC 9727 and now fails.

**Known limitations.** Doesn't verify the cataloged URLs resolve. Doesn't verify the cataloged APIs are accessible to agents.

### 6.8 Tracked (not scored)

Tracked checks run on every audit and appear in the report under "Tracked (not scored)" with weight 0 (§3.1). They never affect a category score, `topIssues` or warnings. The platform hides a tracked check that skipped (nothing detected). Changing a check's state follows §7.

| ID | Category | Why tracked (§7) |
|---|---|---|
| `mcp-server-card` | `agent-discovery` | SEP-2127 is unmerged and three card shapes are live: criteria (a) and (b) |
| `agent-skills-index` | `agent-discovery` | Cloudflare-led draft RFC outside a standards body, and v0.2 already renamed the path and replaced the schema: criteria (a) and (b) |
| `webmcp-declarative` | `agent-protocols` | Chrome origin trial, API still changing: criterion (b) |
| `webmcp-imperative` | `agent-protocols` | Same as `webmcp-declarative` |
| `agent-operator-signing` | `agent-auth` | The directory describes the bot operator, not the audited site |
| `usage-preference-declared` | `bot-accessibility` | No vocabulary stable for two cycles: criterion (b); a training opt-out is not a readiness defect (D-2) |
| `edge-agent-access` | `bot-accessibility` | Requests under agent user-agents are unverified, so a score could penalise correct treatment of an impostor; promotion is a 3.1 decision |

### 6.9 Retired in 3.0

These ids are no longer registered and are not part of the current catalog; they are listed only so 2.0 reports can be read. The paths `/.well-known/agents.json`, `/.well-known/ara/manifest.json`, `/.well-known/ai-plugin.json`, `/.well-known/mcp` and `/.well-known/mcp.json` are no longer requested. Old weights and rationale: RUBRIC-CHANGELOG 3.0.

| Retired id | 2.0 category / weight | In 3.0 |
|---|---|---|
| `robots-txt-ai-bots` | bot-accessibility / 2.0 | renamed and rebuilt as `ai-agent-access` |
| `well-known-agents-json` | agent-discovery / 1.0 | removed: three incompatible formats, dormant upstream |
| `well-known-ara` | agent-discovery / 0.5 | removed: no adopters |
| `well-known-ai-plugin` | agent-discovery / 1.0 | removed: its consumer went away in 2024 |
| `sim-claude` | agent-protocols / 1.0 | removed: Anthropic publishes no Claude-User UA string |
| `sim-chatgpt` | agent-protocols / 1.0 | replaced by `reach-openai-user-agent` |
| `sim-gemini` | agent-protocols / 1.0 | replaced by `reach-google-user-agent` |
| `sim-perplexity` | agent-protocols / 1.0 | replaced by `reach-perplexity-user-agent` |
| `sim-deepseek` | agent-protocols / 1.0 | removed: no vendor-documented UA |
| `oauth-support` | agent-auth / 1.5 | merged into `oauth-discovery` |
| `oauth-protected-resource` | agent-auth / 1.5 | merged into `oauth-discovery` |
| `oauth-metadata-rfc9728` | agent-auth / 1.5 | merged into `oauth-discovery` |
| `mcp-auth-mechanism` | agent-auth / 1.0 | merged into `mcp-auth` |
| `mcp-oauth-metadata` | agent-auth / 1.0 | merged into `mcp-auth` |
| `mcp-pkce-s256` | agent-auth / 1.0 | merged into `pkce-s256` |
| `web-bot-auth-directory` | agent-auth / 1.0 | replaced by tracked `agent-operator-signing` |
| `agent-allowlist` | agent-auth / 1.0 | merged into `ai-agent-access` |

### 6.10 Site-type checks

> Checks that apply only to one kind of site. They are not in `allChecks`; the engine adds them to an audit when it detects the site type, and from then on they are scored exactly like core checks in their category (§3.2).

**Site-type detection.** After the crawl, each registered detector (`packages/core/src/site-types/`) scans every crawled page and collects signals, each counted once per audit with a fixed weight. Confidence = 1 − ∏(1 − weight) over the matched signals; below 0.5 the detector reports nothing. When both detectors report, the higher confidence wins (on an exact tie, `ecommerce`, registered first). At most one site type is added per audit.

| Site type | Signals (weight) |
|---|---|
| `ecommerce` | Shopify, WooCommerce, BigCommerce or Magento markup markers (0.8 each; bound to markup or code, see below); a top-level JSON-LD block with `@type` exactly `"Product"` (0.7); `og:type` = `product` (0.5); the page URL or any link matching `/(cart\|checkout\|products?\|shop\|store\|collection\|category)\b` (0.4); `itemprop="price"` (0.4); a commerce control (0.3): a `<form>` button or submit/button input whose text or value matches "add to cart", "buy now" or "add to bag", or a link to a `/cart` or `/checkout` path whose text matches |
| `local-business` | JSON-LD (including `@graph` children) whose `@type` is `LocalBusiness` or one of 31 subtypes such as `Restaurant`, `Dentist`, `Plumber` (0.8); one of `resy.com`, `calendly.com`, `acuityscheduling.com`, `booksy.com`, `vagaro.com`, `mindbodyonline.com` (case-insensitive) in an `iframe[src]`, `script[src]` or `a[href]`, or `opentable` (case-insensitive) in an `iframe[src]`, `script[src]` or an element `id` (0.6; prose and data payloads do not count, and a plain link to an opentable.com restaurant page does not); `itemprop="streetAddress"` or `itemprop="telephone"` (0.6); a Google Maps embed in an `iframe[src]` or `a[href]` (0.5); `itemprop="openingHours"` or day-name-then-`hh:mm` text outside `script` and `style` (0.5); a URL or link containing menu, services, treatments, appointments, reservations or booking (0.4); a `tel:` link (0.3) |

**Platform marker rules.** A marker counts only in markup or in code scripts (§6.0), never in page prose or data payloads. Shopify: `cdn.shopify.com` in a `script[src]` or `link[href]`, `Shopify.theme =` in a code script, or the `shopify-checkout-api-token` meta tag. WooCommerce: a `woocommerce`, `woocommerce-page`, `woocommerce-js` or `woocommerce-no-js` class on `<body>`, `/plugins/woocommerce/` or `wc-ajax=` in a script src or link href, `wc-ajax=` in an `a[href]` or `form[action]`, or `?wc-ajax=` or `&wc-ajax=` in a code script. BigCommerce: an asset host `cdn<N>.bigcommerce.com/` in a script src, link href or image src. Magento: `script[type="text/x-magento-init"]`, a `data-mage-init` attribute, `mage/cookies` in a script src, or `Mage.Cookies` or `mage/cookies` in a code script. The words Shopify, WooCommerce, BigCommerce or Magento in prose, or a link to a vendor's developer site, do not match. Before 3.1 these were substring matches on the raw HTML, which classified documentation and SaaS pages that mention a platform as ecommerce.

A single strong signal is enough (a Shopify marker alone gives 0.8), and two weak ones are too (a commerce path plus a "buy now" form button gives 0.58). The detection result (type, confidence, signals) is reported with the audit. `well-known-ucp` (§6.5) is N/A on any site not detected as `ecommerce` (§5).

| ID | Site type | Category | Weight | Severity | Maturity |
|---|---|---|---:|---|---|
| `ecommerce-product-schema` | ecommerce | `structured-data` | 2.0 | warning | M2 |
| `ecommerce-gtin-valid` | ecommerce | `structured-data` | 1.0 | info | M1 |
| `ecommerce-checkout-accessible` | ecommerce | `bot-accessibility` | 1.5 | warning | M1 |
| `local-business-nap-structured` | local-business | `structured-data` | 2.0 | warning | M2 |
| `local-business-hours-jsonld` | local-business | `structured-data` | 1.5 | warning | M2 |
| `local-business-booking-accessible` | local-business | `bot-accessibility` | 1.5 | warning | M1 |

#### `ecommerce-product-schema` (weight 2.0, warning)

**What it measures.** On each crawled page, takes the first top-level JSON-LD block whose `@type` is `"Product"` (or an array containing it) and has a non-empty string `name`. Such a page is a product page. It is complete when its first offer (`offers`, or `offers[0]`) has a `price` that parses as a number after non-digits are stripped, and a string `availability`. Score = round(complete / product pages × 100): 100 → pass; above 0 → partial; 0 → fail. No product page → skip.

**Evidence boundary.** Top-level JSON-LD blocks only: a `Product` inside `@graph` or nested under another type is not read, and microdata is not read. `priceCurrency` is not required. The reported severity drops to `info` when the score is 50 or more.

**Maturity.** M2: Schema.org vocabulary (§6.2).

**Why this check.** Price and availability are the two facts a shopping agent needs before it can recommend or buy; a `Product` block without them sends the agent back to scraping.

**Why weight 2.0.** Equal to `schema-org-present`, the heaviest structured-data check: on a store, product data is the structured data that matters.

**Provenance.** Schema.org `Product` and `Offer`; the fields match Google's merchant listing requirements.

**Known limitations.** Only the first offer is read, so a product whose first variant lacks a price counts as incomplete. The price value is not validated beyond parsing.

#### `ecommerce-gtin-valid` (weight 1.0, info)

**What it measures.** For each product page found as in `ecommerce-product-schema`, reads the first string among the product's `gtin`, `gtin13` and `gtin12`. After non-digits are stripped, a GTIN is valid when it has 8, 12, 13 or 14 digits and its GS1 mod-10 check digit is correct. Score = round(valid / GTINs found × 100): 100 → pass; above 0 → partial; 0 → fail. No GTIN on any product page → skip.

**Evidence boundary.** One GTIN per product page. `gtin8`, `gtin14` and `mpn` fields are not read, and a GTIN is not looked up in any registry.

**Maturity.** M1: the GS1 General Specifications define GTIN lengths and the check digit.

**Why this check.** A GTIN lets an agent match the same product across stores; a malformed one is worse than none, because it points at the wrong item.

**Why weight 1.0.** Secondary to price and availability, and it applies only to stores that publish GTINs (otherwise it skips).

**Provenance.** GS1 General Specifications, check-digit algorithm; Schema.org `gtin` properties.

**Known limitations.** A number with a valid check digit can still belong to another product.

#### `ecommerce-checkout-accessible` (weight 1.5, warning)

**What it measures.** Collects the distinct paths of every link on the crawled pages, resolved against the site base URL, whose path matches `/(cart|checkout|bag|basket)` followed by `/`, `?` or the end. Each path is tested against robots.txt for the `*` user-agent with `robots-parser`. Score = round(allowed / paths × 100): 100 → pass; above 0 → partial; 0 → fail. No robots.txt → every path allowed. No such link → skip.

**Evidence boundary.** robots.txt `*` group only: a rule aimed at a named agent token is not read here (`ai-agent-access` reads those at the root). Off-origin links are tested as paths on the audited origin. The pages themselves are not requested.

**Maturity.** M1: RFC 9309.

**Why this check.** Store robots.txt defaults commonly disallow `/cart` and `/checkout`, which tells a compliant agent it may not complete a purchase even when the rest of the store is open to it.

**Why weight 1.5.** Buying is the action a commerce agent exists to take; below the product-data check because a disallowed checkout does not stop product discovery.

**Provenance.** RFC 9309 (Robots Exclusion Protocol).

**Known limitations.** Policy only, not edge behaviour. A disallowed checkout is sometimes deliberate (to keep crawlers out of session URLs) and still scores as a loss.

#### `local-business-nap-structured` (weight 2.0, warning)

**What it measures.** On each crawled page, reads two sources. **JSON-LD:** top-level blocks and `@graph` children; the first item whose `@type` (or an entry of an array `@type`) is in the extractor's local-business type list is used, and it must have a non-empty `name`. **Microdata:** the first element whose `itemtype` contains `schema.org/` (or, if none, the whole page), with a non-empty `itemprop="name"`. For each hit, counts name, address (any of `streetAddress`, `addressLocality`, `addressRegion`, `postalCode`; for JSON-LD, the `address` object) and phone (`telephone`). The best count over all pages and both sources gives score = round(count / 3 × 100): 100 → pass; otherwise partial (33 or 67). No hit anywhere → skip.

**Evidence boundary.** The check never fails: without a name it skips, and with a name it scores at least 33. The microdata source accepts any schema.org `itemtype`, not only a local-business type, so a page with generic microdata and an `itemprop="name"` counts as structured data.

**Maturity.** M2: Schema.org vocabulary (§6.2).

**Why this check.** Name, address and phone are what an agent needs to answer "where is it and how do I reach it"; in structured markup they are unambiguous, and in prose they are not.

**Why weight 2.0.** The local-business counterpart of `ecommerce-product-schema`.

**Provenance.** Schema.org `LocalBusiness` and `PostalAddress`; NAP consistency is a long-standing local-search practice.

**Known limitations.** Best page wins, so inconsistent NAP data across pages is not detected. Values are not validated (a phone field of "call us" counts).

#### `local-business-hours-jsonld` (weight 1.5, warning)

**What it measures.** Finds the local-business JSON-LD item as in `local-business-nap-structured`. Pass 100 when, on any page, its `openingHoursSpecification` is an array with at least one entry that has string `opens` and `closes` and at least one string `dayOfWeek`. Otherwise fail 0. No local-business JSON-LD on any page → skip.

**Evidence boundary.** JSON-LD only. The text form `openingHours` (e.g. `"Mo-Fr 09:00-17:00"`), a single non-array `openingHoursSpecification` object, and microdata hours are not read and fail.

**Maturity.** M2: Schema.org vocabulary.

**Why this check.** "Is it open now?" is one of the most common questions an agent answers about a local business, and hours in prose are hard to parse reliably.

**Why weight 1.5.** Below NAP, which identifies the business at all; above a bonus because stale or missing hours produce wrong answers.

**Provenance.** Schema.org `OpeningHoursSpecification`.

**Known limitations.** Holiday hours (`validFrom`, `validThrough`) are not checked, and neither is whether the hours are current.

#### `local-business-booking-accessible` (weight 1.5, warning)

**What it measures.** Over all links on the crawled pages: same-origin links whose path matches `/(book|appointment|reserve|schedule)` followed by `/`, `?` or the end are booking paths; links whose host contains `opentable.com`, `resy.com`, `calendly.com`, `acuityscheduling.com`, `booksy.com`, `vagaro.com` or `mindbodyonline.com`, and `<iframe>` sources containing one of those domains, are external booking. External booking with no booking path → pass 100. With booking paths, each is tested against robots.txt for `*` as in `ecommerce-checkout-accessible`: score = round(allowed / paths × 100), pass / partial / fail as there. Neither → skip.

**Evidence boundary.** The external booking platform itself is not requested or checked. When a site has both an external widget and booking paths, only the paths are scored.

**Maturity.** M1: RFC 9309.

**Why this check.** Booking is the action an agent most often takes for a local business; a disallowed booking path blocks a compliant agent at that step.

**Why weight 1.5.** Mirrors `ecommerce-checkout-accessible`: the transactional step for this site type.

**Provenance.** RFC 9309; the platform list covers widely used restaurant and appointment booking services.

**Known limitations.** Seven platforms only. A booking path on another subdomain of the business is not recognized.

### 6.11 Platform adapter checks

> Checks that apply only to sites built on a detected platform. Like site-type checks, they are added to an audit only on detection and are then scored in their category. Each has weight 1.0.

**Platform detection.** Each adapter's `detect` (`packages/core/src/adapters/<platform>/index.ts`) looks for markers in the parsed markup of a page and records the highest-confidence marker it saw (for example WordPress: a `generator` meta tag 1.0, `/wp-content/` or `/wp-includes/` in `script[src]` or `link[href]` 0.95 on the page's own host and 0.5 on another host, a `https://api.w.org/` link in the HTML or the `Link` header 0.85). Markers are bound to markup: `generator` meta tags, element ids and classes, attribute names, `script[src]` and `link[href]` URLs, `img[src]` and `img[srcset]` for Next.js `/_next/image` (relative or same-host only), response headers, the page host, and code tokens in code scripts (`Shopify.theme`, `__NUXT__`). Words in page prose, escaped code blocks, JSON data scripts, Next.js flight data and `img[src]` media do not count. Any marker is enough; there is no minimum. Detection reads the homepage (the page whose URL equals the base URL's origin and `/`, else the first page) alone, and reads all crawled pages only when the homepage matches no adapter. The adapter with the highest confidence wins. Ties go to the first of Next.js, Nuxt, Astro, Docusaurus, Shopify, WordPress, whatever the registration order: a rendering framework's markers mean the page is rendered by it, and CMS or commerce markers on such a page come from a headless backend. Only the winner's checks are added.

These checks are platform-specific hygiene hints: most read string markers in the HTML and have no external standard (maturity H). They were carried into 3.0 from 2.0 without a §7 review (§7.3).

| ID | Platform | Category | Severity | Detection (pass / partial / fail / skip) | Evidence boundary | Maturity | Why weight 1.0 |
|---|---|---|---|---|---|---|---|
| `wp-rest-api-accessible` | WordPress | `agent-protocols` | warning | Pass 100 when any page has a `Link` header containing `wp-json` or the HTML `rel="https://api.w.org/"`, or a crawled URL contains `/wp-json/`; else fail 0 | The REST API is not requested; the advertisement is taken as availability | H | The platform's built-in API is the cheapest action surface an agent has on WordPress |
| `wp-security-blocking-bots` | WordPress | `bot-accessibility` | warning | Partial 50 when the lower-cased HTML of any page contains `wordfence`, `sucuri`, `ithemes-security`, `all-in-one-wp-security` or `shield-security`; else pass 100 | Plugin presence only; its bot settings are unknown | H | A warning that edge-level blocking is likely; `edge-agent-access` observes the real behaviour |
| `wp-robots-default-blocking` | WordPress | `bot-accessibility` | warning | Counts user-initiated and search tokens (§6.1 `ai-agent-access` table) blocked at the root; 0 → pass 100; n > 0 → fail, score max(0, 100 − 20n) | Root path only, same parser as `ai-agent-access`; training tokens not counted | M1 | Restates `ai-agent-access` for WordPress with a per-token gradient; overlaps it (limitation below) |
| `wp-page-builder-soup` | WordPress | `content-quality` | info | Partial 50 when a page-builder marker (`elementor-widget`, `et_pb_`, `vc_row`, `fl-builder`) is on any page and some page has fewer than 20 characters of tag-stripped text per `<div`; else pass 100 | Marker and ratio may come from different pages | H | Builder markup is a common cause of content that agents extract badly |
| `nextjs-well-known-served` | Next.js | `agent-discovery` | warning | Pass 100 when `/.well-known/agent-card.json` was credited by the metadata probe (§6.0 catch-all rule) and parses as a JSON object with a non-empty string `name`; else fail 0 | The same file `well-known-agent-card` reads, with a looser shape test | M1 | Hint that Next.js needs a route handler or `public/` file to serve `.well-known` |
| `nextjs-static-generation` | Next.js | `technical` | info | Each crawled page is classed. Dynamic (wins over static): `Cache-Control` containing `private` or `no-store`; `__NEXT_DATA__` with `"gssp":true` or `"gip":true`, unless `"nextExport":true` (a static export exempts every flag); or `"appGip":true` without `"gsp":true` or `"nextExport":true`. The script body is parsed as JSON and only top-level booleans are read; nested app data is ignored and a parse failure is no evidence. Static: an `x-nextjs-prerender` header; `x-nextjs-cache` or `x-vercel-cache` with a token of HIT, STALE, PRERENDER or REVALIDATED (comma-separated values split, case-insensitive); `Cache-Control` containing `s-maxage` or `public`; or `__NEXT_DATA__` with `"gsp"`, `"nextExport"` or `"autoExport"` true. Otherwise no evidence (a bare `__NEXT_DATA__`, a cache MISS and a lone `no-cache` are no evidence). Pass 100 when at least half of the pages with evidence are static; else partial 60, also when no page has evidence | Header and `__NEXT_DATA__` flags (read only inside that script tag); no request beyond the crawl. A site that is mostly dynamic stays at partial 60 | H | Cacheable static pages answer agents fast and consistently |
| `nextjs-metadata-api` | Next.js | `structured-data` | info | Ratio of pages with a non-empty `<title>`, a `<meta name="description">` and a `<meta property="og:…">`; score = round(ratio × 100); ≥ 0.8 pass, ≥ 0.5 partial, else fail | Regex on raw HTML; attribute order matters (`name`/`property` must be the first attribute) | H | Page metadata is what agents show as the title and summary of a result |
| `shopify-robots-editable` | Shopify | `bot-accessibility` | warning | Partial 60 when robots.txt contains all of `Disallow: /admin`, `Disallow: /cart`, `Disallow: /checkout` (the Shopify default); else pass 100 | Substring test; a customized file that keeps those three lines still counts as default; no robots.txt passes | H | Hint to add agent rules through `robots.txt.liquid` |
| `shopify-product-schema` | Shopify | `structured-data` | warning | Among crawled URLs containing `/products/`, the ratio whose HTML contains `"@type":"Product"` or `"@type": "Product"`; ≥ 0.8 pass, > 0 partial, 0 fail; no such URL → skip | Exact-string match: other spacing, an array `@type` or microdata is missed; no field is checked | M2 | Overlaps `ecommerce-product-schema` on Shopify stores detected as ecommerce |
| `shopify-theme-app-blocks` | Shopify | `technical` | info | Pass 100 when any page contains `shopify-section`, `data-section-type` or `shopify-block`; else partial 50 | Theme markup markers only | H | Online Store 2.0 themes let owners add integration snippets without editing Liquid |
| `docusaurus-sidebar-coverage` | Docusaurus | `content-quality` | info | Pass 100 when any page contains `theme-doc-sidebar`, `menu__list` or `sidebar_` and at least one page URL contains `/docs/` or its HTML contains `theme-doc-markdown`; else partial 50 | Marker presence; coverage is not measured despite the name | H | A sidebar gives agents the docs structure an llms.txt is built from |
| `docusaurus-versioned-docs` | Docusaurus | `agent-discovery` | info | Pass 100 when any page contains `docsVersionDropdown`, `docs-version-` or `version-`; else partial 60 when a page URL matches `/docs/<n>.<n>` or `/docs/next/`; else skip | `version-` is a loose substring and matches much unrelated markup | H | Version selectors let agents find the docs for the version a user runs |
| `nuxt-seo-module` | Nuxt | `bot-accessibility` | warning | Pass 100 when any page contains `sitemap-index`, `sitemap_index`, `nuxt-seo` or `@nuxtjs/seo`; else fail 0 | Strings in page HTML; the sitemap itself is not requested | H | The module ships sitemap, robots and meta defaults together |
| `nuxt-llms-module` | Nuxt | `agent-discovery` | info | Pass 100 when a crawled page URL ends in `/llms.txt`, or any page contains `nuxt-llms` or `@nuxtjs/llms`; else fail 0 | Does not read the llms.txt probe (limitation below) | M3 | Hint to generate llms.txt with the module |
| `nuxt-schema-org` | Nuxt | `structured-data` | info | Ratio of pages whose HTML contains `application/ld+json`, `useSchemaOrg` or `schema-org`; score = round(ratio × 100); ≥ 0.8 pass, ≥ 0.5 partial, else fail | Substring presence; overlaps `schema-org-present` | M2 | Hint to add JSON-LD with the Nuxt module |
| `nuxt-ssr-hints` | Nuxt | `technical` | warning | Fail 0 when every page either has a `<body>` that starts with an empty `<div id="__nuxt">` or `<div id="app">`, or has under 200 characters of HTML left after `<script>` blocks are removed; else pass 100 | The 200-character count includes markup, not only text | H | A client-only Nuxt app gives static fetchers nothing to read |
| `astro-sitemap-integration` | Astro | `bot-accessibility` | warning | Pass 100 when the metadata probe recorded a `sitemap.xml` or `sitemap-index.xml` well-known entry; else fail 0 | Reads keys the probe never records (limitation below) | M2 | Hint to install `@astrojs/sitemap` |
| `astro-robots-txt` | Astro | `agent-discovery` | warning | No robots.txt → fail 0; any user-initiated or search token blocked at the root → fail 0; else pass 100 | Same token table and parser as `ai-agent-access` | M1 | Restates robots presence and agent access for Astro sites |
| `astro-ssr-mode` | Astro | `technical` | info | Pass 100 when every page has over 200 characters of HTML left after `<script>` blocks are removed; else partial 60 | The count includes markup; the SSR headers it reads only change the message | H | Pre-rendered HTML is directly readable by static fetchers |

**Known limitations (disclosed, not fixed in 3.0).**
- `astro-sitemap-integration` reads `metadata.wellKnown["sitemap.xml"]` and `["sitemap-index.xml"]`, which the metadata probe never records (the sitemap is stored separately), so **it fails on every Astro site**, including sites with a valid sitemap.
- `nuxt-llms-module` reads `metadata.wellKnown["llms.txt"]`, which is also never recorded, so a served llms.txt is credited only when a crawled page URL ends in `/llms.txt` or the module's name appears in the HTML.
- Several adapter checks re-measure a core fact at weight 1.0 (`wp-robots-default-blocking` and `astro-robots-txt` with `ai-agent-access`; `shopify-product-schema` with `ecommerce-product-schema`; `nuxt-schema-org` with `schema-org-present`; `nextjs-well-known-served` with `well-known-agent-card`), so on those platforms the fact counts twice.
- Fixing any of these changes scores, so it needs a rubric bump (§2).

## 7. Emerging-Standards Policy (normative)

The key words MUST, MUST NOT, SHOULD and MAY are to be read as described in RFC 2119. This policy governs checks that detect a published standard or convention.

### 7.1 Maturity tiers and lifecycle

**Maturity tiers.** Every check in §6 records the maturity of what it measures:

| Tier | Meaning | Examples |
|---|---|---|
| M1 | Standardized: IANA-registered, an RFC, an IETF working-group document, governed by a foundation (Linux Foundation / AAIF, W3C, WHATWG, GS1), or vendor-documented observable HTTP behaviour | robots.txt (RFC 9309), OAuth metadata (RFC 9728, RFC 8414), OpenAPI, HTTP status codes |
| M2 | Multi-vendor: a convention or draft implemented by several independent vendors, with live adoption, but outside a standards body's formal track | Schema.org, the sitemaps protocol, Markdown alternates, UCP |
| M3 | Single-vendor, or the path or schema is still changing | llms.txt, Open Graph, WebMCP, MCP server cards |
| M4 | Dormant: no reference-implementation activity for more than 6 months, or its consumer is gone | The checks retired in 3.0 (§6.9) |
| H | Heuristic: no external standard; the detection rule is w2agent's own | `answer-first`, `semantic-html`, `public-api` |

A check that accepts several mechanisms takes the tier of the strongest mechanism that decides its result; where the mechanisms are peers of different maturity, a range is recorded (`usage-preference-declared`, M2–M3). The tier describes the standard, not the quality of the detection rule. An M4 check MUST be retired (below). The lifecycle criteria below govern checks that measure a standard or convention (M1–M3); a heuristic (H) is not governed by them, and its weight rests on the rationale recorded in §6.

Every check is in exactly one of three states.

- **Scored.** A check MUST NOT be scored unless all three criteria hold:
  - (a) the underlying standard is IANA-registered, an RFC, an IETF working-group document, or governed by a foundation (Linux Foundation / AAIF, a W3C or WHATWG Recommendation) — or the check measures vendor-documented, observable HTTP behaviour (user-agent strings, status codes);
  - (b) its path and schema have been unchanged for at least 2 rubric cycles (about 6 months);
  - (c) an applicability gate — an NA cascade rule (§5), a site-type gate, or skip-unless-present — keeps its absence from penalizing sites the standard does not address. A standard that applies to every public website (robots.txt, HTTPS, HTTP status codes, charset) meets (c) without a gate.
- **Tracked.** A check that fails any of (a)–(c) MAY still be detected and reported. It MUST then be tracked: weight 0, shown with a "tracked — not scored" label, and excluded from category renormalization, `topIssues` and warnings (§3.1).
- **Retired.** A check MUST be retired when its reference implementation has been dormant for more than 6 months or its consumer is gone. A retired check is removed from the registry, and its paths MUST NOT be probed.

### 7.2 Changing state

- A check MUST be promoted (tracked → scored), demoted (scored → tracked) or retired only at a rubric version bump, and every such change MUST be logged in `RUBRIC-CHANGELOG.md` (§2). Each is a change to the check set, so the bump is major.
- A newly promoted check — tracked → scored, or a new signal added as scored — MUST enter at weight 0.5 or less for one rubric cycle.
- A merge is not a promotion. A check that replaces scored checks and measures facts they already scored MAY carry a weight set in that version's rubric-change table instead. In 3.0: `oauth-discovery` 3.0 (from three 1.5 checks) and `mcp-auth` 1.5 (from two 1.0 checks).
- Criteria are frozen per rubric version: a standard that renames its path or changes its schema mid-cycle cannot move a score before the next bump.

### 7.3 Documented exceptions (3.0)

A scored check that does not meet §7.1 MUST be listed here with the criterion it misses.

| Check | Criterion missed | Why it stays scored | Ends when |
|---|---|---|---|
| `well-known-ucp` (0.5, ecommerce only) | (b): breaking schema change in the 2026-08-25 release | Owner decision D-1: a shipped spec under Google/Shopify governance with platform-default adoption on every Shopify store | The next UCP release breaks the profile schema again: the check is demoted to tracked |
| `cimd-support` (0.5 bonus) | (b): new IETF draft | MCP 2026-07-28 prefers CIMD over Dynamic Client Registration; scored as a pass-or-skip bonus, so it can raise a score but never lower it | No end condition recorded in 3.0 |
| `llms-txt-exists`, `llms-txt-valid`, `llms-txt-links-resolve` (0.5 each) | (a): no governing body | Carried from 2.0 at reduced weight: cheap to ship and read by coding agents (RUBRIC-CHANGELOG 3.0) | No end condition recorded in 3.0 |
| `sitemap-exists`, `schema-org-present`, `schema-org-type`, `schema-org-completeness`, `schema-org-valid`, `og-meta-tags`, `mobile-viewport`, `content-negotiation`, `markdown-alternate`, `action-schemas` | (a): the sitemaps protocol, Schema.org, Open Graph, the viewport meta tag and Markdown alternates are multi- or single-vendor conventions (M2/M3), not standards-body documents | Carried from 2.0 without a §7 review; these conventions are universal or near-universal on the web, so criterion (b) holds in practice | The first rubric bump that reviews them against §7.1 |
| Site-type checks (§6.10) and platform adapter checks (§6.11) | Not reviewed against §7.1; the M2 site-type checks and several adapter hints miss (a) | Carried from 2.0 without a §7 review; the detection gate keeps them off sites they do not address (criterion (c)) | The first rubric bump that reviews them against §7.1 |

## 8. Open Questions

These are the philosophy and design questions this version does not fully answer. Status notes are current as of v1.0.

1. **Score volatility under rubric churn.** What's the contract for how often `RUBRIC_VERSION` can change? When it does, do we re-score historical entries or freeze old scores at their original rubric? *(Roadmap F2.)* *Partly answered in 3.0: bump rule (§2) and state changes only at a bump (§7.2); re-scoring history is still open.*
2. **JS-rendered measurement.** Do we publish a single "agent-readiness" score that combines static + rendered, or always two? *(Roadmap F3.)*
3. **Outcome correlation.** Empirical evidence that this rubric predicts agent task success rate. *(Roadmap F4.)* *Pending: outcome calibration (improvement plan P4-2) has not reported; weights and thresholds are rationale-set until it does (§2).*
4. **Failure-mode statuses.** Should we add first-class `could-not-measure` / `anti-bot-blocked` / `auth-gated` statuses distinct from `fail`? *(Roadmap F5.)* *Answered in 3.0: per-check `error` (unmeasured, §3.1), and typed, unscored audit-level failures including `blocked` and `auth_gated` (§3.5). Blocked pages other than the homepage are still read as HTTP errors (§6.1 `status-codes`).*
5. **Governance.** Who maintains the spec? What's the change-proposal process? *Partly answered in v1.0: the spec is published in the w2agent OSS repo under CC BY 4.0, and rubric changes follow the bump rule (§2) and §7. There is no public comment process yet.*
6. **The per-platform simulation checks.** *Resolved in 3.0: retired (§6.9) and replaced by HTTP-only `reach-*` checks in `agent-protocols` (§6.5). Invoking real models belongs to F4.*
7. **Tier formalization.** Make the `agent-auth` tier structure explicit in code rather than implied by weight buckets.

## 9. Change Log

- **v0.1 (2026-05-07)** — initial draft. Reflects engine state at OSS commit `d709571` (NA cascade for emerging-MCP checks). 63 checks, 7 categories, 13 cascade rules. Per-check rationale stubbed.
- **v0.2 (2026-05-08)** — rationale layer complete. All 63 checks across 7 categories now carry the six-field schema: *What it measures / Why this check / Why this weight / Provenance / Evidence boundary / Known limitations*. Engine unchanged — no `RUBRIC_VERSION` bump. Filename retained as `v0.1.md` for git-history continuity. Highlights:
  - Agent Discovery (§6.4) — 8 checks. Adoption claims verified live; surfaced two real measurement gaps (apex-vs-subdomain shipping, 403-vs-404 anti-bot conflation) that strengthen the F3 / F5 case in the credibility roadmap.
  - Auth & Access (§6.7) — 16 checks. Tier philosophy block (T1 universal / T2 mature OAuth / T3+ emerging) + per-tier nesting. `oauth-metadata-rfc9728` weight 1.5 (vs T3+ baseline 1.0) explicitly justified by RFC 9728's standards-track maturity.
  - Agent Protocols (§6.5) — 12 checks. Category framing block calls out the three families (native protocols / API discoverability / per-platform sims). Honest disclosure: sim-\* checks do NOT invoke real models — they test reachability + a thin static fingerprint. F4 is the right tool to harden them. Self-stewardship disclosure on `webmcp-*` (we partially authored that convention).
  - Bot Accessibility (§6.1) — 6 checks. `robots-txt-ai-bots` (weight 2.0, error severity) is the gating signal that can invalidate every other agent-friendly choice on a site.
  - Structured Data (§6.2) — 7 checks. The four Schema.org checks evaluate JSON-LD from four orthogonal angles (presence / typing / content / structure).
  - Content Quality (§6.3) — 8 checks. `answer-first` (weight 1.5) carries the load for content-extractability.
  - Technical Foundations (§6.6) — 6 checks. `no-js-dependency` is explicitly framed as the F3 (JS-render) wedge — its three-signal SPA-shell heuristic was calibrated against openai/anthropic/perplexity homepages.

  Total file size: ~1200 lines, ~15K words. Per-check median depth: ~200 words (paragraph for controversial checks, shorter for self-evident ones).
- **v1.0-draft (2026-09-14)** — rubric 3.0 (`RUBRIC_VERSION = "3.0"`, `w2agent-core` 0.2.0, OSS `ce4df45`). Renamed from the v0.1 filename. 54 checks (4 tracked), 7 categories, 9 cascade rules. `error` status and tracked checks (§3); bump rule and changelog pointer (§2); cascade table re-derived from `applyNaCascade`, including the sentinel `mcp-auth` rule and the non-sentinel UCP site-type gate (§5); catch-all / soft-404 evidence rule (§6); 17 checks retired (§6.9); 8 added (`ai-agent-access`, `oauth-discovery`, `mcp-auth`, `cimd-support`, `agent-operator-signing`, `reach-openai-user-agent`, `reach-perplexity-user-agent`, `reach-google-user-agent`); llms.txt checks reweighted to 0.5; `webmcp-declarative`, `webmcp-imperative` and `mcp-server-card` tracked (§6.8); detection rewritten for `mcp-discovery`, `pkce-s256`, `api-catalog-rfc9727`, `well-known-agent-card`, `well-known-ucp`, `response-time`, `content-negotiation`; new normative emerging-standards policy (§7). Rationale for unchanged checks is carried from v0.2. Per-check old/new weights: OSS `docs/RUBRIC-CHANGELOG.md`.
- **v1.0 (2026-09-17)** — published. Engine unchanged: rubric 3.0, no `RUBRIC_VERSION` bump. Canonical copy moved to the OSS repo (`docs/spec/agent-readiness-spec-v1.0.md`, CC BY 4.0); the platform renders a byte-identical copy at `/methodology`. Draft label dropped; calibration disclosed as pending (header, §2, §3.4). Audited line by line against the 3.0 registry: 56 core checks (50 scored, 6 tracked), adding the tracked `usage-preference-declared` and `edge-agent-access` entries (§6.1, §6.8) and correcting detection rules and evidence boundaries where the prose had drifted from the code. New: audit-level failures, retry behaviour, challenge fingerprints and edge evidence (§3.5); inputs every check reads, including the crawl profile and the multi-UA probe set (§6.0, §6.1); a maturity tier on every check, defined in §7.1; rationale prose for category weights (§4) and cascade structure (§5); site-type checks (§6.10) and platform adapter checks (§6.11), with two adapter bugs disclosed; carried exceptions in §7.3; open questions 3–5 updated (§8).
- **v1.1 (2026-10-16)** — rubric 3.1 (`RUBRIC_VERSION = "3.1"`). Detection fixes only (local-business markers are markup-bound too, §6.10); no check, weight, category or tracked status changed (57 core checks, 50 scored, 7 tracked). Visible text defined once (§6.0) and used by `answer-first`, `token-efficiency`, `content-length`, `faq-content`, `citation-readiness` and `no-js-dependency`; inline data payloads are not code (§6.0, `webmcp-imperative`); ecommerce detection rewritten to markup-bound markers and commerce controls (§6.10); `nextjs-static-generation` classifies each page and passes on a static majority (§6.11); `developer-portal` credits only HTML or untyped 2xx responses (§6.7). `/.well-known/mcp.json` stays unprobed (§6.9, §7.1). Measured delta pending: logged in `docs/RUBRIC-CHANGELOG.md` before cutover. The platform copy of this file must be re-synced.
