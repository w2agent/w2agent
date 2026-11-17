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

Next.js, Nuxt, Astro and Docusaurus plans never serve a generated `robots.txt`. When the generated files include one and the platform is not WordPress or Shopify, `planInstall` appends a `manual` action on `robots.txt`: review the generated AI-crawler rules and merge them into the site's robots.txt (`w2agent integrate <url> --output <dir>` writes the generated file). `planInstall` skips that generic action when the resolver's plan already has an action on a `robots.*` file. WordPress and Shopify serve their own rules (a plugin `robots_txt` filter, a theme template), so they never get this action; a plan with no actions (refused) gets none either.

The Next.js resolver supplies its own action. It stages the rules unserved as `.w2agent/robots.txt` (a normal guarded write) and adds one `manual` action on the real target: an existing `public/robots.txt` (merge the rules into it), else an existing `app/robots.{ts,js,tsx,jsx}` or `src/app/robots.*` metadata route (add the rules to what it returns), or a static `app/robots.txt` / `src/app/robots.txt` (merge the rules into that file), else `public/robots.txt` (review the staged file and copy it to serve it). If the staged copy was not written, the text says so. The generated rules are not served automatically because the generator can reorder an owner's explicit blocks and assert a `Sitemap:` line it has not verified.

## CLI Flags

```
--install              Install files directly into your project
--project-dir <dir>    Project root for --install (default: .)
--dry-run              Show what would be installed; never writes files (works with or without --install)
--site-url <url>       Production origin to write into generated content when crawling another origin
--json                 One JSON document on stdout (result or error envelope)
```

See [CLI-AGENT-MODE.md](CLI-AGENT-MODE.md) for the `--json` documents and `--site-url` rules.

Exit codes with `--install` / `--dry-run`:

- No platform detected and none forced: nothing is written (no `./w2agent-output` either), the CLI lists every valid `--platform` and exits 1. Re-run with `--platform <id> --install --project-dir <dir>`. Without `--install`/`--dry-run`, the core files are still written to the output directory.
- `--install` (not dry-run) exits 1 when nothing was installed and nothing was already up to date (for example the Next.js project check, the Pages Router refusal, or the WordPress outside-`WP_PLUGIN_DIR` refusal), and when any write failed with a filesystem error. The summary still prints; after a failed write it says that post-install steps naming those files do not apply. A re-run where every file is "already up to date" exits 0.

## Per-Platform Install Resolvers

Each platform adapter implements `resolveInstall(files, projectDir)` that detects the project layout and produces an appropriate plan.

### Next.js (`packages/core/src/adapters/nextjs/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| Not a Next.js project | No `next` in `dependencies`/`devDependencies` and no `next.config.{js,mjs,ts,cjs,mts}` | No actions; warning names the directory and says to pass `--project-dir <your Next.js app>` (in a monorepo, the app package) |
| `src/app/` layout | `src/app/` dir exists | Adjusts all `app/` paths to `src/app/`; writes the middleware or proxy to `src/` and the WebMCP component to `src/components/` (Next reads them next to `app/`). Existing `middleware.*` / `proxy.*` (`ts`, `js`, `tsx`, `jsx`) are detected at the root and in `src/`; a merge copy goes in the same directory as the existing file. A `src/` file wins over a root one. A root file in a `src/app` project gets a warning (Next.js 15, and Next.js 16 with webpack, ignore it; move it to `src/`), and the installer never writes a second edge file beside it |
| `output: "export"` in `next.config.*` | Text match (the config is never run) | No middleware or proxy and no merge copy (Next disables middleware in a static export); one warning says Accept negotiation on `/` is not installed and `/llms.txt`, `/llms-full.txt`, `/index.md` are exported as static files. Routes and seeds install as usual and keep `export const revalidate` (a static export requires it). With `cacheComponents` or `dynamicIO` also in the config, one more warning says Next.js rejects `revalidate` in that combination, so the routes need a manual change |
| `output` set by an expression that contains `"export"` (for example `process.env.X ? "export" : undefined`) | Same-line text match; not the plain literal | Middleware or proxy installs as usual; one warning says it does not run in builds where `output` is `"export"` |
| Generated `robots.txt` | Existing `public/robots.txt`, else `app/robots.*` or `src/app/robots.*` (`ts`, `js`, `tsx`, `jsx`, or a static `txt`) | Stages `.w2agent/robots.txt` and adds one manual action on the real target (see "Generated `robots.txt`") |
| Pages Router only | Has `pages/` but no `app/` | Skip all with warning |
| Existing `app/llms.txt/route.ts` | File exists | Skip + warn |
| No existing `middleware.*` or `proxy.*` | Next major from `node_modules/next/package.json`, else the `next` range in `package.json` | Next 16 or newer: write `proxy.<ext>` (function `proxy`). Next 15 or older, or an unknown version (`latest`, `canary`, `*`, workspace or git spec, or an upper bound alone such as `<17`): write `middleware.<ext>` (function `middleware`). Next 16 rejects a `middleware` and a `proxy` file together, and Next 15 ignores `proxy.ts`, so an unknown version gets `middleware` |
| Existing middleware or proxy (with w2agent or llms.txt) | Read `middleware.*` and `proxy.*` (root and `src/`) | Skip, naming the file that holds the reference (root or `src/`). Covers a re-run after the Next 16 codemod renamed our middleware to proxy |
| Existing middleware (no w2agent) | Read file, check content | Write as `middleware.w2agent.<ext>` (function `middleware`, even on Next 16) + merge instructions |
| Existing proxy (no w2agent) | Read file, check content | Write as `proxy.w2agent.<ext>` (function `proxy`) + merge instructions. Never writes the other convention beside an existing file |
| No `tsconfig.json` | JavaScript project | Install `.js` routes, middleware or proxy and merge copies, and a `.jsx` WebMCP component, so `next build` does not ask to install TypeScript |
| `cacheComponents` or `dynamicIO` in any `next.config.{js,mjs,ts,cjs,mts}` | Text match (the config is never run); a `: false` that is the whole value (followed only by `,`, `}`, a newline, a comment or the end of the text) does not count; `false || true` does. Ignored under a static export | Routes are written without `export const revalidate`, which Next rejects under `cacheComponents` |
| Any `public/<path>` that matches a planned route `app/<path>/route.ts` (for example `public/llms.txt`, `public/index.md`, `public/.well-known/agent-card.json`) | File exists | Skip that route, manual step to remove or rename the public file (Next.js errors when both exist) and re-run. The file is never deleted |
| Existing `app/llms.txt/route.js` (or other extension) | Same stem, other extension | Skip + warn |
| Existing `w2agent-build.mjs` | File exists | Skip + warn |
| `w2agent-build.mjs` written | Not already present | Post-install step: add `"prebuild": "node w2agent-build.mjs"` (not `postbuild`: the routes are prerendered during `next build`, so a postbuild refresh is not served). The crawl targets the live site, so a build serves the previous deploy's content; the first deploy serves the install-time seed |
| Any other generated file already present | File exists | Skip + warn (guard) |

### Nuxt (`packages/core/src/adapters/nuxt/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| Nuxt 2 project | `package.json` nuxt version < 3 | Skip all with warning |
| Existing server routes | File exists | Skip + warn |
| Existing middleware (with w2agent) | Read file, check content | Skip |
| Existing middleware (no w2agent) | Read file | Write as `.w2agent.ts` |
| Local module | Always | Install `modules/w2agent.ts`: it inlines only `public/{llms.txt,llms-full.txt,agent-card.json,.well-known/agent-card.json}` into the server bundle (scoped `w2agent` server assets), so the routes serve the files as of build time from any working directory and return 404 when a file is missing. Run the prebuild script before `nuxi build`. An existing different `modules/w2agent.ts` is kept (guard) with a warning that the routes then 404 until it registers the asset |
| WebMCP plugin | `srcDir` rule below | Install `<srcDir>/plugins/w2agent-webmcp.client.ts`; only the plugin moves, `server/`, `public/`, `modules/` and the build script stay at the root. Explicit literal `srcDir` in `nuxt.config.*` wins; else Nuxt 4 mode (nuxt major >= 4 from `package.json` or the installed package, or `compatibilityVersion: 4`): `app/` when it holds anything besides `spa-loading-template.html` and `router.options*`, or when it is empty of those and the root has no `app.vue`/`App.vue`/`assets`/`layouts`/`middleware`/`pages`/`plugins`; otherwise the root. A non-literal `srcDir` warns and uses that rule |
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
| `w2agent-webmcp-module.js` written | Not guarded out | Post-install step: add `clientModules: ["./w2agent-webmcp-module.js"]` to the config (only when written) |
| No config found | Missing config | Warn + install to static/ |

### WordPress (`packages/core/src/adapters/wordpress/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| Standard WP root | `wp-content/plugins/` exists | Install to `wp-content/plugins/w2agent-site/` (the standalone plugin keeps `w2agent/`; both can be active) |
| Custom plugin dir | `define('WP_PLUGIN_DIR', '<string literal>')` or `const WP_PLUGIN_DIR = '<string literal>';` in wp-config.php (comments, strings, heredocs and inline HTML outside `<?php` ignored; single-quoted strings decode `\\` and `\'`, every other backslash is literal; a backslash in the decoded value is a separator only on Windows, elsewhere the value is unreadable and the default is used with a warning; double-quoted strings with a backslash are not read, text before the first `<?php` is ignored) | Use custom path, resolved through real paths (symlinks, then `..`); an absolute path inside the project is made relative; `'.'` means the project root |
| Plugin dir outside the project | Absolute path elsewhere, relative path that escapes, a symlink inside the project that leads outside, or a Windows path (drive `C:/`, `C:\`, UNC, drive-relative `C:foo`) on a non-Windows host. On Windows a drive or UNC path is walked from its own root and refused when it leaves the project (not verified on a real Windows host) | No writes; manual step + warning to copy the plugin by hand (for example from `--output`) |
| Unreadable `WP_PLUGIN_DIR` | Expression, concatenation or constant | Use `wp-content/plugins` + warn |
| Interpolated strings | A `{$...}` or `${...}` block in a double-quoted string or heredoc (`\{$` and `{\$` are not blocks) that is not a simple variable, property or `'key'` path (only word chars, `$ [ ] - > :` and single-quoted keys without `\ { } "`), and wp-config.php mentions `WP_PLUGIN_DIR` anywhere | No writes; manual step + warning (the value cannot be read reliably). Simple blocks such as `{$_SERVER['HTTP_HOST']}` are trusted and a commented `WP_PLUGIN_DIR` is ignored |
| Not in WP root | Missing markers | Warn + still write files |
| Existing plugin | `wp-content/plugins/w2agent-site/` exists | Skip all + warn to remove old version |
| Older generated plugin | `wp-content/plugins/w2agent/w2agent-plugin.php` contains `W2AGENT_PLUGIN_DIR` or `AI Readiness` (the folder name earlier versions used) | Skip all + warn to remove that older copy first. A standalone plugin in `w2agent/` does not block the install |

### Shopify (`packages/core/src/adapters/shopify/install.ts`)

| Scenario | Detection | Action |
|----------|-----------|--------|
| In theme dir | Has `layout/theme.liquid` or `config/settings_schema.json` | Write `snippets/w2agent-head.liquid` and, when generated, `snippets/w2agent-webmcp.liquid`; steps: render head, render webmcp before `</body>`, `shopify theme push --only <written files> --only layout/theme.liquid` to a copy of the live theme (never `--live` or `--publish`) |
| Not in theme dir | Missing markers | Warn + still write |
| Existing head or webmcp snippet | File exists | Identical content: skip as "already up to date" (a re-run succeeds). Different content: skip + warn, never overwritten. No render or push step for a skipped snippet |
| llms.txt template | `templates/llms.txt.liquid` generated | `manual` action, not written: Shopify already serves `/llms.txt`; the template is an optional override |
| robots.txt additions | `data/robots-txt-additions.txt` generated (live robots.txt blocks AI agents via `*`) | `manual` action, not written: paste it at the end of the existing `templates/robots.txt.liquid`; no `robots.txt.liquid` is ever written |
| Webhook notes | `W2AGENT-MCP-WEBHOOK.md` generated | `manual` action, not written (not a theme file) |

The template and robots manual actions name `w2agent integrate <url> --platform shopify --output <dir>`, which writes those files. The webhook notes manual action names `w2agent generate <url> --format mcp-server --output <dir>`, which writes `shopify/W2AGENT-MCP-WEBHOOK.md` when the site is detected as Shopify (`integrate` does not request the `mcp-server` format). The push step also tells the owner to add `--only templates/llms.txt.liquid` or `--only templates/robots.txt.liquid` after adding that template or pasting the robots groups. Theme folders are `assets`, `blocks`, `config`, `layout`, `locales`, `sections`, `snippets` and `templates`; the install never writes elsewhere.

## Testing

### Unit tests (352 tests across 19 test files)

- `tests/install-guard.test.ts` — guard, executor safety (no overwrite, containment, symlinks, races), plan/dry-run parity, broken parent paths (24 tests)
- `tests/install-planner.test.ts` — framework: fallback planner, custom resolveInstall (20 tests)
- `tests/install-nextjs.test.ts` — project check, src/app, pages-router, middleware merge, existing files, public/ conflicts (24 tests)
- `tests/install-nextjs-conventions.test.ts` — proxy vs middleware by Next version, existing proxy, JS-only projects (installed files parsed by Node), `cacheComponents` (41 tests)
- `tests/install-nextjs-placement.test.ts` — `src/` placement of middleware/proxy/component and merge copies, `output: "export"`, staged robots.txt and its manual action, planner dedupe (24 tests)
- `tests/install-nextjs-gate-fix1.test.ts` — root edge file in a `src/app` project, `tsx`/`jsx` edge files, static export with `cacheComponents`, the whole-value `: false` rule, `app/robots.txt`, upper-bound-only ranges, conditional static export (42 tests)
- `tests/nextjs-prebuild-docs.test.ts` — `prebuild` step, script header and INSTALL.md wording (3 tests)
- `tests/install-resolver-guard.test.ts` — post-install steps and merge text follow the guarded actions in every resolver; public/ route conflicts through `planInstall` (13 tests)
- `tests/install-nuxt.test.ts` — Nuxt 2/3, server routes, middleware (10 tests)
- `tests/install-nuxt-placement.test.ts` — local module install, WebMCP plugin `srcDir` placement (Nuxt 3/4, `app/`, `compatibilityVersion`, explicit `srcDir`) (18 tests)
- `tests/nuxt-emitted-files.test.ts` — emitted routes and module executed in real h3 (build-time content, 404 when absent) and the INSTALL.md/build-script wording (16 tests)
- `tests/install-astro.test.ts` — static/SSR/hybrid, config detection (11 tests)
- `tests/astro-emitted-files.test.ts` — every emitted `.mjs` parsed, MCP webhook integration run with a failing fetch, emitted `llms.txt.ts` endpoint evaluated (404 without the file, no embedded site URL), INSTALL.md wording (7 tests)
- `tests/docusaurus-emitted-files.test.ts` — emitted plugin run against a loaded-content fixture (URLs, unlisted/old versions, kept static `llms.txt`, `overwrite`), WebMCP module evaluated with and without a DOM, every emitted `.js` parsed, trailingSlash and `overwrite` cases (22 tests)
- `tests/install-docusaurus.test.ts` — plugin config, clientModules step, seed-file note (14 tests)
- `tests/install-wordpress.test.ts` — WP root, existing plugin, older generated plugin, standalone beside it, `WP_PLUGIN_DIR` forms (24 tests)
- `tests/install-wordpress-reader.test.ts` — wp-config reader: heredoc labels with high bytes, single-quoted escapes, drive and UNC paths (win32 branch via `path.win32`), interpolation blocks, inline HTML, text before the first open tag (44 tests)
- `tests/install-wiring.test.ts` — robots.txt manual action, Astro component placement and mount step, Astro prebuild step (12 tests)
- `tests/install-gate-fix1.test.ts` — WordPress robots/symlink/string/`.` handling, Docusaurus plugin and clientModules steps, executor `failed`, physical `..` resolution, interpolated-string refusal (19 tests)
- `tests/install-shopify.test.ts` — snippet-only writes, manual actions, render/push steps, re-run skips (11 tests)

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
