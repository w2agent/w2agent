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

### Generated `robots.txt` (manual action)

Next.js, Nuxt, Astro and Docusaurus plans never write a `robots.txt`. When the generated files include one and the platform is not WordPress or Shopify, `planInstall` appends a `manual` action on `robots.txt`: review the generated AI-crawler rules and merge them into the site's robots.txt (`w2agent integrate <url> --output <dir>` writes the generated file). WordPress and Shopify serve their own rules (a plugin `robots_txt` filter, a theme template), so they never get this action; a plan with no actions (refused) gets none either.

## CLI Flags

```
--install              Install files directly into your project
--project-dir <dir>    Project root for --install (default: .)
--dry-run              Show what --install would do without writing files
```

Exit codes with `--install` / `--dry-run`:

- No platform detected and none forced: nothing is written (no `./w2agent-output` either), the CLI lists every valid `--platform` and exits 1. Re-run with `--platform <id> --install --project-dir <dir>`. Without `--install`/`--dry-run`, the core files are still written to the output directory.
- `--install` (not dry-run) exits 1 when nothing was installed and nothing was already up to date (for example the Next.js project check, the Pages Router refusal, or the WordPress outside-`WP_PLUGIN_DIR` refusal), and when any write failed with a filesystem error. The summary still prints; after a failed write it says that post-install steps naming those files do not apply. A re-run where every file is "already up to date" exits 0.

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
| `WebMcpScript.astro` | Generated as `src/components/WebMcpScript.astro` | Install under `src/`; post-install step to import it in a layout and render `<WebMcpScript />` (only when written) |
| `w2agent-build.mjs` written | Not already present | Post-install step: add `"prebuild": "node w2agent-build.mjs"` as an alternative to the integration (use one, not both) |

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
| Custom plugin dir | `define('WP_PLUGIN_DIR', '<string literal>')` or `const WP_PLUGIN_DIR = '<string literal>';` in wp-config.php (comments, strings and heredocs ignored) | Use custom path, resolved through real paths (symlinks, then `..`); an absolute path inside the project is made relative; `'.'` means the project root |
| Plugin dir outside the project | Absolute path elsewhere, relative path that escapes, or a symlink inside the project that leads outside | No writes; manual step + warning to copy the plugin by hand (for example from `--output`) |
| Unreadable `WP_PLUGIN_DIR` | Expression, concatenation or constant | Use `wp-content/plugins` + warn |
| Interpolated strings | wp-config.php sets `WP_PLUGIN_DIR` and a double-quoted string or heredoc contains `{$` or `${` | No writes; manual step + warning (the value cannot be read reliably) |
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

### Unit tests (166 tests across 11 test files)

- `tests/install-guard.test.ts` — guard, executor safety (no overwrite, containment, symlinks, races), plan/dry-run parity, broken parent paths (24 tests)
- `tests/install-planner.test.ts` — framework: fallback planner, custom resolveInstall (20 tests)
- `tests/install-nextjs.test.ts` — project check, src/app, pages-router, middleware merge, existing files, public/ conflicts (24 tests)
- `tests/install-resolver-guard.test.ts` — post-install steps and merge text follow the guarded actions in every resolver; public/ route conflicts through `planInstall` (13 tests)
- `tests/install-nuxt.test.ts` — Nuxt 2/3, server routes, middleware (10 tests)
- `tests/install-astro.test.ts` — static/SSR/hybrid, config detection (10 tests)
- `tests/install-docusaurus.test.ts` — plugin config, gray-matter (10 tests)
- `tests/install-wordpress.test.ts` — WP root, existing plugin, `WP_PLUGIN_DIR` forms (22 tests)
- `tests/install-wiring.test.ts` — robots.txt manual action, Astro component placement and mount step, Astro prebuild step (12 tests)
- `tests/install-gate-fix1.test.ts` — WordPress robots/symlink/string/`.` handling, Docusaurus gray-matter step, executor `failed`, physical `..` resolution, interpolated-string refusal (17 tests)
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
