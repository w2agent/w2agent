# Adapter System Architecture

**Status**: Implemented
**Last updated**: 2026-03-12

## Overview

The adapter system provides platform-specific behavior for auditing, code generation, and installation. Each adapter knows how to detect a platform (WordPress, Next.js, etc.), run platform-specific audit checks, generate integration files, and plan installation steps. Adapters are pluggable — adding a new platform requires implementing the `PlatformAdapter` interface and registering it.

## Design Decisions

- **Compiled-in adapters, not plugins** — adapters are imported and registered at module load time, not discovered dynamically. Simpler, faster, and fully tree-shakeable. Plugin discovery would add complexity for a small number of adapters.
- **Detection by confidence** — each adapter returns a confidence score (0–1). Highest confidence wins. This handles ambiguous cases (e.g., a Nuxt site on a Docker container that also serves WordPress-like headers).
- **Self-contained modules** — each adapter is a directory with `index.ts`, `checks.ts`, `install.ts`, `templates.ts`. No cross-adapter imports. Easy to add or remove without touching other code.
- **Generated files, not config** — adapters produce complete files (`GeneratedFile[]`), not configuration fragments. The file content is ready to write to disk. This keeps the generate pipeline simple — it just writes files.

## How It Works

```
┌──────────────┐     ┌──────────────────┐
│ Audit Engine │────▶│ detectPlatform() │
│  or Generate │     │  (registry.ts)   │
└──────────────┘     └────────┬─────────┘
                              │
                     ┌────────▼─────────┐
                     │  For each adapter │
                     │  adapter.detect() │
                     │  → confidence     │
                     └────────┬─────────┘
                              │ highest wins
                              ▼
                     ┌─────────────────┐
                     │ PlatformAdapter │
                     │  .checks        │──▶ merged into audit
                     │  .generateInt() │──▶ platform files
                     │  .resolveInst() │──▶ install plan
                     └─────────────────┘
```

### Detection Flow

1. `detectPlatform(pages, metadata)` in `packages/core/src/adapters/registry.ts` iterates all registered adapters
2. Each adapter's `detect()` examines fetched pages and metadata for platform signals
3. Returns `PlatformDetectionResult` with confidence, or `null` if not detected
4. Highest confidence result wins (ties go to first registered)

### Detection Signals by Platform

| Platform | Primary Signals | Confidence |
|----------|----------------|------------|
| WordPress | `wp-content` in HTML, `X-Powered-By: WordPress` | 0.9–1.0 |
| Next.js | `__NEXT_DATA__` script, `_next/static` paths | 0.8–0.95 |
| Nuxt | `__NUXT__` script, `_nuxt/` paths | 0.8–0.95 |
| Astro | `astro-island` components, Astro generator meta | 0.8–0.9 |
| Shopify | `cdn.shopify.com` resources, Shopify headers | 0.9–1.0 |
| Docusaurus | `docusaurus` class names, `/docs/` structure | 0.7–0.9 |

## Data Model

### PlatformAdapter Interface

```typescript
// packages/core/src/adapters/types.ts
interface PlatformAdapter {
  id: PlatformId;
  name: string;
  description: string;
  detect(pages: FetchedPage[], metadata: SiteMetadata): PlatformDetectionResult | null;
  checks: Check[];
  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[];
  resolveInstall?(files: GeneratedFile[], projectDir: string): InstallPlan;
}

type PlatformId = "wordpress" | "shopify" | "nextjs" | "docusaurus" | "nuxt" | "astro";
```

### Registry

```typescript
// packages/core/src/adapters/registry.ts
const adapters = new Map<PlatformId, PlatformAdapter>();

registerAdapter(adapter)   // Add adapter to registry
getAdapter(id)             // Get adapter by platform ID
allAdapters()              // List all registered adapters
detectPlatform(pages, md)  // Run detection across all adapters
```

## Implemented Adapters

### WordPress (`packages/core/src/adapters/wordpress/`)
- **Generates**: PHP plugin (`w2agent-plugin.php`) with dynamic `llms.txt` from DB, admin settings page, `robots.txt` filter, JSON-LD Schema.org blocks
- **Checks**: PHP syntax validity, WordPress-specific SEO patterns
- **Install**: Plugin activation instructions

### Next.js (`packages/core/src/adapters/nextjs/`)
- **Generates**: App Router route handlers (`app/llms.txt/route.ts`, `app/.well-known/agent-card.json/route.ts`), middleware for content negotiation, ISR revalidation
- **Checks**: Content negotiation, route handler presence
- **Install**: File placement in app directory

### Nuxt (`packages/core/src/adapters/nuxt/`)
- **Generates**: Nitro server routes (`server/routes/llms.txt.ts`), middleware, nuxt.config.ts additions
- **Checks**: Nitro route availability, Nuxt-specific patterns
- **Install**: File placement + config merge

### Astro (`packages/core/src/adapters/astro/`)
- **Generates**: Static files (`public/llms.txt`, `public/.well-known/agent-card.json`), middleware for content negotiation
- **Checks**: Static file presence, Astro-specific patterns
- **Install**: File placement

### Shopify (`packages/core/src/adapters/shopify/`)
- **Generates**: Liquid snippets, Product JSON-LD, theme configuration
- **Checks**: Liquid syntax structure, JSON-LD presence
- **Install**: Theme file instructions

### Docusaurus (`packages/core/src/adapters/docusaurus/`)
- **Generates**: Build plugin that reads `docs/` directory, static files
- **Checks**: Docs structure, build plugin presence
- **Install**: Plugin registration in `docusaurus.config.js`

## How to Write a New Adapter

1. **Create directory**: `packages/core/src/adapters/<name>/`

2. **Implement files**:
   - `index.ts` — main adapter implementing `PlatformAdapter`
   - `checks.ts` — platform-specific audit checks
   - `templates.ts` — generated file content (template strings)
   - `install.ts` — (optional) `resolveInstall()` implementation

3. **Detection**: Implement `detect()` to examine `FetchedPage[]` and `SiteMetadata`. Return `null` if not detected, or `{ platform, confidence, version?, details }`.

4. **Checks**: Create 3-4 checks specific to the platform. Each follows the standard `Check` interface — receives `(pages, metadata)`, returns `CheckResult`.

5. **Code generation**: `generateIntegration(ctx, coreFiles)` receives the generate context (site info, pages, markdown) and core-generated files. Return `GeneratedFile[]` with platform-native code.

6. **Register**: Import and register in `packages/core/src/adapters/index.ts`:
   ```typescript
   import { myAdapter } from "./my-platform/index.js";
   registerAdapter(myAdapter);
   ```

7. **Test**: Create fixture in `packages/core/tests/fixtures/platforms/<name>/` and add integration test in `packages/core/tests/integration.test.ts`.

## Integration Testing

Each adapter has integration tests that:
1. Copy a minimal fixture project to a temp directory
2. Run `generateIntegration()` to produce platform files
3. Write generated files into the fixture
4. Build the project (for JS platforms)
5. Start preview server and run `runAudit()` against it
6. Assert that platform-specific checks pass

Fixtures in `packages/core/tests/fixtures/platforms/` are the **smallest valid project** for each platform.

## Error Handling

| Scenario | Behavior | Recovery |
|----------|----------|----------|
| No platform detected | `detectPlatform()` returns `null` | Audit runs core checks only; generate produces generic files |
| Multiple platforms detected | Highest confidence wins | Tie-breaking: first registered adapter |
| Detection throws | Adapter skipped silently | Other adapters still run |
| `generateIntegration()` throws | Generate pipeline fails | CLI/API returns error |

## Anti-Patterns

❌ **WRONG**: Importing from one adapter directory into another.
✅ **CORRECT**: Adapters are self-contained. Share code via `packages/core/src/shared/`.

❌ **WRONG**: Hardcoding platform detection into `engine.ts`.
✅ **CORRECT**: Use the adapter registry. Detection logic lives in the adapter.

❌ **WRONG**: Returning file fragments that need assembly.
✅ **CORRECT**: `generateIntegration()` returns complete, ready-to-write files.

## Known Limitations

- **6 platforms only** — WordPress, Next.js, Nuxt, Astro, Shopify, Docusaurus. No support for custom/unknown platforms beyond generic output.
- **Detection requires crawled data** — can't detect platform from URL alone. Need at least homepage HTML.
- **No runtime adapter loading** — adapters are compiled in. Can't add a platform without modifying the package source.
- **Shopify validation is static** — no local Shopify runtime for testing. Integration tests check file structure and Liquid syntax, not actual serving.
- **WordPress/Shopify testing requires Docker/PHP** — integration tests for these platforms are limited on machines without the runtime.
