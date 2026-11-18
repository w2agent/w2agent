# Contributing to w2agent

## Setup

```bash
git clone https://github.com/anthropics/w2agent
cd w2agent
pnpm install
pnpm build
```

## Project Structure

```
packages/core     Audit engine, generators, platform adapters (published as @w2agent/core)
packages/cli      CLI tool (published as w2agent)
```

## Development

```bash
pnpm dev            # Watch mode (core + cli)
pnpm build          # Build all packages
pnpm test           # Unit tests (all packages)
```

## Testing

### Unit Tests

216 unit tests covering the audit engine, checks, adapters, generators, and MCP server.

```bash
pnpm test                                  # All unit tests
pnpm --filter @w2agent/core test           # Core package only
pnpm --filter @w2agent/core test -- -t "discovery"  # Single test file/pattern
```

### Integration Tests

83 integration tests that verify generated code actually works on real platform builds. These tests:

1. Copy minimal fixture projects to temp directories
2. Run `generateIntegration()` for each platform adapter
3. Write generated files into the fixture project
4. Install dependencies and build the project
5. Start a preview server and run `runAudit()` against it
6. Assert that audit checks pass (llms.txt exists, agent-card valid, etc.)

```bash
pnpm --filter @w2agent/core test:integration                    # All integration tests
pnpm --filter @w2agent/core test:integration -- -t "nextjs"     # Single platform
pnpm --filter @w2agent/core test:integration -- -t "negative"   # Negative tests only
pnpm --filter @w2agent/core test:integration -- -t "conformance" # Conformance suite
```

Integration tests take ~75s locally. They're separated from unit tests via `vitest.integration.config.ts` so `pnpm test` stays fast.

#### Fixture Projects

Each platform has a minimal but real project in `packages/core/tests/fixtures/platforms/`:

| Directory | What's inside |
|-----------|--------------|
| `nextjs-app/` | Next.js 14 app with `app/` router, TypeScript |
| `nuxt-app/` | Nuxt 3 with `pages/index.vue` |
| `astro-app/` | Astro with `src/pages/index.astro` |
| `docusaurus-site/` | Docusaurus with `docs/` + `src/pages/` |
| `wordpress-theme/` | Minimal WP theme (`style.css`, `functions.php`, `index.php`) |
| `shopify-theme/` | Liquid theme (`layout/`, `templates/`, `config/`) |

Fixtures are the **smallest valid project** for each platform — just enough to build and serve.

#### What Integration Tests Verify

For JS platforms (Next.js, Nuxt, Astro, Docusaurus):
- Build succeeds with generated files injected
- Preview server starts and responds on localhost
- `runAudit()` finds and validates `/llms.txt`
- `runAudit()` finds and validates `/.well-known/agent-card.json`
- Platform-specific checks pass (e.g., content negotiation for Next.js)
- Audit ran >0 checks (guards against silent no-ops)

For non-JS platforms (WordPress, Shopify):
- Generated files have valid syntax (PHP lint, Liquid structure)
- File structure matches platform conventions
- Required content (llms.txt blocks, schema.org markup) is present

Negative tests confirm the audit catches real problems:
- Missing `llms.txt` → `llms-txt-exists` check fails
- Invalid `llms.txt` content → `llms-txt-valid` check fails
- Invalid `agent-card.json` → `well-known-agent-card` check fails

#### Adding a New Platform

1. Create a minimal fixture in `packages/core/tests/fixtures/platforms/<name>/`
2. Add a `describe` block in `packages/core/tests/integration.test.ts`
3. Add the platform to the CI matrix in `.github/workflows/integration-tests.yml`

### CI

Unit tests run on every push. Integration tests run on PRs to `main` that touch adapter code:

- **Unit tests**: `.github/workflows/` (all pushes)
- **Integration tests**: `.github/workflows/integration-tests.yml` (PRs only, 6 platforms × 2 Node versions)

The integration CI uses matrix strategy with `fail-fast: false` so all platforms report independently.

## Architecture Overview

Detailed architecture documentation for each major component:

- **[Audit Engine](docs/architecture/audit-engine.md)** — check registry, scoring algorithm, crawl flow, platform check merging, top issues calculation
- **[Adapter System](docs/architecture/adapter-system.md)** — `PlatformAdapter` interface, detection logic, code generation, how to write a new adapter
- **[Generate Pipeline](docs/architecture/generate-pipeline.md)** — `runGenerate()` flow, 10+ output formats, platform integration hooks
- **[Crawl Discovery](docs/architecture/crawl-discovery.md)** — multi-source URL discovery, page scoring, selection strategy
- **[Design Tradeoffs](docs/TRADEOFFS.md)** — cross-cutting design decisions and rationale

### Quick Reference

**Audit Engine** — `packages/core/src/audit/engine.ts`

`runAudit(url, options, onProgress?, checksOverride?)` orchestrates: crawl → detect platform → merge checks → run checks (parallel) → score → grade → top issues.

**Platform Adapters** — `packages/core/src/adapters/<platform>/`

Each adapter implements `PlatformAdapter`: `detect(pages, metadata)` returns confidence 0–1, `checks` array for platform-specific auditing, `generateIntegration(ctx, coreFiles)` returns `GeneratedFile[]`.

**Check Registry** — `packages/core/src/audit/checks/`

47 core checks across 6 categories. Each check: `id`, `category`, `weight`, `run(pages, metadata) → CheckResult`.

**Generate Pipeline** — `packages/core/src/generate/engine.ts`

`runGenerate(url, options, onProgress?)` produces: llms.txt, agent-card.json, FAQ, schema-org, markdown, agent server, `skills/<name>/SKILL.md`, WebMCP, and more.

## Agentize a Site (Community)

The w2agent directory grows through community contributions. If you know a site that would
benefit from an agentized MCP server, you can document it and submit a PR.

This is a documentation-only contribution — no code changes required.

### What you're contributing

A completed `<slug>.md` site document placed in `sites/`. Each document maps a real website's
routes, components, and data models — the output of following the [AGENTIZE.md](docs/AGENTIZE.md) SOP.

Maintainers review accepted documents and seed them into the w2agent directory.

### Prerequisites

- `npx w2agent` available (no install required)
- The target site is publicly accessible — not paywalled or login-gated
- You've read [AGENTIZE.md](docs/AGENTIZE.md) (the 4-phase SOP) and [SITE_TEMPLATE.md](SITE_TEMPLATE.md)

### Step-by-step

**1. Fork and clone the OSS repo**

```bash
git clone https://github.com/<your-fork>/w2agent
cd w2agent
```

**2. Run the audit**

```bash
npx w2agent audit https://example.com --depth 20
```

Record the overall score, grade, platform detected, and top issues.

**3. Copy and fill `SITE_TEMPLATE.md`**

```bash
cp SITE_TEMPLATE.md sites/<slug>.md
```

Use the domain as the slug (e.g., `stripe-com.md` for `stripe.com`). Fill every section
following the four-phase [AGENTIZE.md](docs/AGENTIZE.md) SOP:

- **Phase 1** — Audit results, Route Map, Component Registry, Data Models
- **Phase 2** — Agent Architecture decisions
- **Phase 3** — skip (maintainers run the `agentize` command after review)
- **Phase 4** — Quality validation: test at least one tool against the live site and record a real response

**4. Open a PR**

Target: `main` on the OSS repo. The only file needed is `sites/<slug>.md`.

PR description should include: site name, URL, category (e.g., developer tools, e-commerce,
documentation), audit score and grade, and one sentence on why this site is useful in an
agent context.

### PR checklist

- [ ] `sites/<slug>.md` is the only file in the PR
- [ ] Audit score and grade are recorded (Phase 1, Step 1)
- [ ] Route Map is filled with routes you actually visited (not inferred from URL patterns)
- [ ] Component Registry lists real interactive elements found on the live site
- [ ] Phase 4 validation completed — at least one tool returned a real response
- [ ] Site is publicly accessible without login
- [ ] Slug matches the domain (e.g., `docs-anthropic-com.md` for `docs.anthropic.com`)

### Acceptance criteria

Maintainers verify:

1. Audit was run — score is present and plausible for the site
2. Routes were visited — Route Map is not inferred from URL patterns alone
3. Phase 4 completed — tool test records a real live response
4. Site is publicly accessible

**Notes:**
- Paywalled or bot-blocking sites are not accepted — the audit can't run against them
- Slug conflicts with existing directory entries are resolved by maintainers
- Once merged, maintainers seed the site to the w2agent directory — it won't appear
  in the public directory immediately

## Code Style

- TypeScript throughout, ESM modules
- Zod for runtime validation
- No external LLM dependencies in core — pure HTTP/HTML analysis
- Prefer explicit over clever; keep adapters self-contained
