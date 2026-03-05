# `w2agent integrate --install` — Implementation Notes

## Architecture

The `--install` mode uses an **InstallPlan framework** that separates planning from execution:

1. **Planner** (`packages/core/src/install/planner.ts`) — analyzes the project directory and generated files, produces an `InstallPlan`
2. **Executor** (`packages/core/src/install/executor.ts`) — writes files according to the plan, returns a summary
3. **Per-platform resolvers** — each adapter implements `resolveInstall()` with platform-specific conflict detection

```
integrate command
  → runGenerate() → detect platform → get adapter
  → planInstall(adapter, files, projectDir) → InstallPlan
  → executeInstallPlan(plan, projectDir) → summary
```

### InstallPlan Structure

```ts
interface InstallPlan {
  platform: PlatformId;
  actions: InstallAction[];      // write | skip | manual
  warnings: string[];            // non-fatal issues
  postInstallSteps: string[];    // things user must do after
}
```

Each action has a `type`, `dest` (relative path), optional `content`, and optional `reason` (for skip/manual).

## CLI Flags

```
--install              Install files directly into your project
--project-dir <dir>    Project root for --install (default: .)
--dry-run              Show what --install would do without writing files
```

## Per-Platform Install Resolvers

Each platform adapter implements `resolveInstall(files, projectDir)` that detects the project layout and produces an appropriate plan.

### Next.js (`packages/core/src/adapters/nextjs/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| `src/app/` layout | `src/app/` dir exists | Adjusts all `app/` paths to `src/app/` |
| Pages Router only | Has `pages/` but no `app/` | Skip all with warning |
| Existing `app/llms.txt/route.ts` | File exists | Skip + warn |
| Existing middleware (with w2agent) | Read file, check content | Skip |
| Existing middleware (no w2agent) | Read file, check content | Write as `.w2agent.ts` + merge instructions |
| Existing `public/llms.txt` | File exists | Skip + warn |
| Existing `w2agent-build.mjs` | File exists | Skip + warn |

### Nuxt (`packages/core/src/adapters/nuxt/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| Nuxt 2 project | `package.json` nuxt version < 3 | Skip all with warning |
| Existing server routes | File exists | Skip + warn |
| Existing middleware (with w2agent) | Read file, check content | Skip |
| Existing middleware (no w2agent) | Read file | Write as `.w2agent.ts` |

### Astro (`packages/core/src/adapters/astro/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| Static mode (default) | `astro.config.*` output setting | Only install `public/` files, skip SSR endpoints |
| SSR/hybrid mode | `output: "server"` or `"hybrid"` | Install all files |
| No config found | Missing `astro.config.*` | Warn + proceed with public/ files |
| Existing `public/llms.txt` | File exists | Skip + warn |

### Docusaurus (`packages/core/src/adapters/docusaurus/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| Plugin already in config | Read config for "w2agent" | Skip plugin + warn |
| Existing `static/llms.txt` | File exists | Skip + warn |
| Missing `gray-matter` dep | Check `package.json` | Post-install step |
| No config found | Missing config | Warn + install to static/ |

### WordPress (`packages/core/src/adapters/wordpress/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| Standard WP root | `wp-content/plugins/` exists | Install to `wp-content/plugins/w2agent/` |
| Custom plugin dir | `WP_PLUGIN_DIR` in wp-config.php | Use custom path |
| Not in WP root | Missing markers | Warn + still write files |
| Existing plugin | `wp-content/plugins/w2agent/` exists | Skip all + warn to remove old version |

### Shopify (`packages/core/src/adapters/shopify/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| In theme dir | Has `layout/theme.liquid` or `config/settings_schema.json` | Write snippets + templates |
| Not in theme dir | Missing markers | Warn + still write |
| Existing head snippet | File exists | Skip + warn |
| Existing `robots.txt.liquid` | File exists | Skip + provide merge instructions (never overwrite) |

## Testing

### Unit tests (35 tests across 7 test files)

- `tests/install-planner.test.ts` — framework: fallback planner, custom resolveInstall (10 tests)
- `tests/install-nextjs.test.ts` — src/app, pages-router, middleware merge, existing files (9 tests)
- `tests/install-nuxt.test.ts` — Nuxt 2/3, server routes, middleware (6 tests)
- `tests/install-astro.test.ts` — static/SSR/hybrid, config detection (6 tests)
- `tests/install-docusaurus.test.ts` — plugin config, gray-matter (6 tests)
- `tests/install-wordpress.test.ts` — WP root, existing plugin (4 tests)
- `tests/install-shopify.test.ts` — theme dir, robots.txt merge (4 tests)

All tests use temp directories with fixture files — fast, no network.

### Dry run testing

```bash
# Preview what would be installed
w2agent integrate https://example.com --platform nextjs --install --dry-run --project-dir /path/to/project
```

## File Map

```
packages/core/src/install/
├── types.ts      # InstallAction, InstallPlan types
├── planner.ts    # planInstall() + fallback logic
└── executor.ts   # executeInstallPlan(), formatInstallSummary()

packages/core/src/adapters/
├── nextjs/install.ts
├── nuxt/install.ts
├── astro/install.ts
├── docusaurus/install.ts
├── wordpress/install.ts
└── shopify/install.ts
```
