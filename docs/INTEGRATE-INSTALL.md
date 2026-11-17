# `w2agent integrate --install` — Implementation Notes

## Architecture

The `--install` mode uses an **InstallPlan framework** that separates planning from execution:

1. **Planner** (`packages/core/src/install/planner.ts`) — analyzes the project directory and generated files, produces an `InstallPlan`
2. **Guard** (`packages/core/src/install/guard.ts`) — runs on every plan, custom or fallback, so dry-run and real run show the same skips
3. **Executor** (`packages/core/src/install/executor.ts`) — writes files according to the plan, returns a summary
4. **Per-platform resolvers** — each adapter implements `resolveInstall()` with platform-specific conflict detection

```
integrate command
  → runGenerate() → detect platform → get adapter
  → planInstall(adapter, files, projectDir) → InstallPlan (guarded)
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

### Safety rules (all platforms)

Install never overwrites or deletes files, and never writes outside `--project-dir`. The guard turns a `write` into a `skip` (plus a warning) when:

- `dest` is absolute, escapes the project with `..`, or passes through a symlinked directory that points outside the project.
- `dest` already exists (a dangling symlink counts). An identical file is skipped as "already up to date" without a warning. To replace a file, remove it and re-run.
- A code file with the same name and another extension sits next to it (for example `route.js` beside a planned `route.ts`).

Each resolver runs the guard itself before it builds post-install steps and merge instructions, so those only mention files this run writes. `planInstall` runs it again as a backstop.

The executor re-checks containment and creates files with exclusive-create (`wx`), so a file that appears between planning and writing is also skipped, never overwritten.

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
| Not a Next.js project | No `next` in `dependencies`/`devDependencies` and no `next.config.{js,mjs,ts,cjs,mts}` | No actions; warning names the directory and says to pass `--project-dir <your Next.js app>` (in a monorepo, the app package) |
| `src/app/` layout | `src/app/` dir exists | Adjusts all `app/` paths to `src/app/` |
| Pages Router only | Has `pages/` but no `app/` | Skip all with warning |
| Existing `app/llms.txt/route.ts` | File exists | Skip + warn |
| Existing middleware (with w2agent) | Read file, check content | Skip |
| Existing middleware (no w2agent) | Read file, check content | Write as `.w2agent.ts` + merge instructions |
| Any `public/<path>` that matches a planned route `app/<path>/route.ts` (for example `public/llms.txt`, `public/index.md`, `public/.well-known/agent-card.json`) | File exists | Skip that route, manual step to remove or rename the public file (Next.js errors when both exist) and re-run. The file is never deleted |
| Existing `app/llms.txt/route.js` (or other extension) | Same stem, other extension | Skip + warn |
| Existing `w2agent-build.mjs` | File exists | Skip + warn |
| Any other generated file already present | File exists | Skip + warn (guard) |

### Nuxt (`packages/core/src/adapters/nuxt/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| Nuxt 2 project | `package.json` nuxt version < 3 | Skip all with warning |
| Existing server routes | File exists | Skip + warn |
| Existing middleware (with w2agent) | Read file, check content | Skip |
| Existing middleware (no w2agent) | Read file | Write as `.w2agent.ts` |
| Any other generated file already present | File exists | Skip + warn (guard) |

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
| Custom plugin dir | `define('WP_PLUGIN_DIR', '<string literal>')` or `const WP_PLUGIN_DIR = '<string literal>';` in wp-config.php (comments and heredocs ignored) | Use custom path; an absolute path inside the project is made relative |
| Plugin dir outside the project | Absolute path elsewhere, or relative path that escapes | No writes; manual step + warning to copy the plugin by hand (for example from `--output`) |
| Unreadable `WP_PLUGIN_DIR` | Expression, concatenation or constant | Use `wp-content/plugins` + warn |
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

### Unit tests (137 tests across 9 test files)

- `tests/install-guard.test.ts` — guard, executor safety (no overwrite, containment, symlinks, races), plan/dry-run parity, broken parent paths (24 tests)
- `tests/install-planner.test.ts` — framework: fallback planner, custom resolveInstall (20 tests)
- `tests/install-nextjs.test.ts` — project check, src/app, pages-router, middleware merge, existing files, public/ conflicts (24 tests)
- `tests/install-resolver-guard.test.ts` — post-install steps and merge text follow the guarded actions in every resolver; public/ route conflicts through `planInstall` (13 tests)
- `tests/install-nuxt.test.ts` — Nuxt 2/3, server routes, middleware (10 tests)
- `tests/install-astro.test.ts` — static/SSR/hybrid, config detection (10 tests)
- `tests/install-docusaurus.test.ts` — plugin config, gray-matter (10 tests)
- `tests/install-wordpress.test.ts` — WP root, existing plugin, `WP_PLUGIN_DIR` forms (22 tests)
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
├── guard.ts      # guardInstallActions(): containment, no-overwrite
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
