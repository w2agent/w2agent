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
packages/core     Shared engine — audit checks, generate, crawler, platform adapters
packages/cli      CLI tool (npx w2agent audit/generate/integrate)
apps/web          Next.js web UI — audit + generate with platform detection
```

## Development

```bash
pnpm dev            # Watch mode (core + web)
pnpm build          # Build all packages
pnpm test           # Unit tests (all packages)
```

## Testing

### Unit Tests

216 unit tests covering the audit engine, checks, adapters, generators, and MCP server.

```bash
pnpm test                                  # All unit tests
pnpm --filter w2agent-core test           # Core package only
pnpm --filter w2agent-core test -- -t "discovery"  # Single test file/pattern
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
pnpm --filter w2agent-core test:integration                    # All integration tests
pnpm --filter w2agent-core test:integration -- -t "nextjs"     # Single platform
pnpm --filter w2agent-core test:integration -- -t "negative"   # Negative tests only
pnpm --filter w2agent-core test:integration -- -t "conformance" # Conformance suite
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

## Architecture

### Audit Engine

`packages/core/src/audit/engine.ts` — `runAudit(url, options, onProgress?, checksOverride?)` orchestrates:

1. **Crawl** — fetches `/llms.txt`, `/.well-known/agent-card.json`, `/robots.txt`, `/sitemap.xml`, plus HTML pages
2. **Check** — runs registered checks against crawled data, each returning pass/fail/warn with score impact
3. **Score** — aggregates check results into weighted category scores and overall grade

### Platform Adapters

Each adapter in `packages/core/src/adapters/<platform>/` implements `PlatformAdapter`:

- `detect(html, url)` — returns confidence 0-100
- `checks` — platform-specific audit checks
- `generateIntegration(ctx, coreFiles)` — returns `GeneratedFile[]` with platform-native code

### Check Registry

Checks are registered in `packages/core/src/audit/checks/`. Each check has:
- `id` — unique identifier (e.g., `llms-txt-exists`)
- `category` — scoring bucket
- `weight` — score impact
- `run(metadata)` — returns `CheckResult`

## Code Style

- TypeScript throughout, ESM modules
- Zod for runtime validation
- No external LLM dependencies in core — pure HTTP/HTML analysis
- Prefer explicit over clever; keep adapters self-contained
