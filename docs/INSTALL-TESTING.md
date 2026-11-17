# `integrate --install` Real-World Testing

Last run: 2026-03-04

> Note (2026-11-17): the Next.js resolver now refuses a directory that has no `next` dependency and no `next.config.*`. Monorepo roots counted as "Clean install" below now get a warning and an empty plan; pass `--project-dir <app package>`. The table below is the original survey and is not updated.

> Note (2026-11-17): the Next.js resolver now handles `proxy.ts` on Next 16 (middleware on 15 and earlier), `src/` placement of the middleware or proxy and the component, JavaScript-only projects (`.js`/`.jsx`), `cacheComponents` (no `revalidate` export), `output: "export"` (no middleware), the generated robots rules staged at `.w2agent/robots.txt`, and a `prebuild` build-script step (a postbuild refresh is not served). These are covered by unit tests and are not reflected in the survey below, which was not re-run.

## Summary

Tested install resolvers against **42 real-world repos** (planning step only — conflict detection, layout detection, path rewriting). Zero failures.

| Platform | Repos | Pass | Warn | Fail |
|----------|-------|------|------|------|
| Next.js | 10 | 5 | 5 | 0 |
| Nuxt | 9 | 9 | 0 | 0 |
| Astro | 10 | 9 | 1 | 0 |
| Docusaurus | 10 | 8 | 2 | 0 |
| Shopify | 3 | 2 | 1 | 0 |
| **Total** | **42** | **33** | **9** | **0** |

All warnings are correct behavior — the resolver detects edge cases and provides guidance.

## Next.js (10 repos)

| Repo | Result | Layout | Notes |
|------|--------|--------|-------|
| shadcn-ui/taxonomy | ⚠️ | app + pages + middleware | Existing middleware → saved as `.w2agent.ts` |
| dubinc/dub | ⚠️ | app + middleware | Existing middleware → `.w2agent.ts` |
| documenso/documenso | ✅ | monorepo (no app/ at root) | Clean install |
| lukevella/rallly | ✅ | **src/app/** | Correctly rewrote paths to `src/app/` |
| elie222/inbox-zero | ✅ | app | Clean install |
| mckaywrigley/chatbot-ui | ⚠️ | app + middleware | Existing middleware → `.w2agent.ts` |
| steven-tey/novel | ✅ | app | Clean install |
| vercel/platforms | ⚠️ | app + middleware | Existing middleware → `.w2agent.ts` |
| mfts/papermark | ⚠️ | app + pages + middleware | Existing middleware → `.w2agent.ts` |
| calcom/cal.com | ✅ | app + pages (monorepo) | Clean install at root |

**Key finding:** 5/10 Next.js repos have existing middleware — the merge-as-`.w2agent.ts` pattern is critical.

## Nuxt (9 repos)

| Repo | Result | Layout | Notes |
|------|--------|--------|-------|
| nuxt/nuxt.com | ✅ | Nuxt 4, has server/ | Clean install |
| elk-zone/elk | ✅ | Nuxt 4, has server/ | Clean install |
| nuxt/ui | ✅ | Nuxt 4 | Clean install |
| nuxt/movies | ✅ | Nuxt 3, has server/ | Clean install |
| antfu/vitesse-nuxt3 | ✅ | has server/ | Clean install |
| nuxt-themes/docus | ✅ | Nuxt 4 | Clean install |
| nuxt/content | ✅ | Nuxt 4 | Clean install |
| nuxt/devtools | ✅ | (version null — monorepo) | Clean install |
| nuxt/examples | ✅ | (version null — examples dir) | Clean install |

**Key finding:** No Nuxt repos had existing server routes for llms.txt — all clean installs.

## Astro (10 repos)

| Repo | Result | Layout | Notes |
|------|--------|--------|-------|
| withastro/starlight | ⚠️ | no config at root | Monorepo — config in packages/. Warned, installed public/ only |
| withastro/docs | ✅ | static | SSR endpoints skipped correctly |
| satnaing/astro-paper | ✅ | static | Clean install |
| onwidget/astrowind | ✅ | static | Clean install |
| eliancodes/brutal | ✅ | static | Clean install |
| chrismwilliams/astro-theme-cactus | ✅ | static | Clean install |
| markhorn-dev/astro-nano | ✅ | static | Clean install |
| Ladvace/astro-bento-portfolio | ✅ | **server** | SSR endpoints included correctly |
| mhyfritz/astro-landing-page | ✅ | static | Clean install |
| Charca/astro-blog-template | ✅ | static | Clean install |

**Key finding:** Most Astro sites are static — SSR endpoint skip logic works. Portfolio with `output: "server"` correctly got all files.

## Docusaurus (10 repos)

| Repo | Result | Layout | Notes |
|------|--------|--------|-------|
| facebook/docusaurus | ✅ | config at `website/` | Detected via subdirectory search |
| jestjs/jest | ✅ | config at `website/` | Detected via subdirectory search |
| pnpm/pnpm.io | ✅ | config at root | Clean install |
| reduxjs/redux | ✅ | config at `website/` | Detected via subdirectory search |
| facebook/react-native-website | ✅ | config at root | Clean install |
| babel/website | ✅ | config at root | Clean install |
| prettier/prettier | ✅ | config at `website/` | Detected via subdirectory search |
| ionic-team/ionic-docs | ✅ | config at root | Clean install |
| verdaccio/verdaccio | ⚠️ | no config at root | Monorepo — config in `website/`. Warned, still installed to static/ |
| nicehash/rest-clients-demo | ⚠️ | no config | Not a Docusaurus project (test control). Warned correctly |

**Key finding:** Many Docusaurus projects have config in `website/` subdirectory. The test script's subdirectory search found them, but the actual CLI `--project-dir` would need to point there.

## Shopify (3 repos)

| Repo | Result | Layout | Notes |
|------|--------|--------|-------|
| Shopify/dawn | ✅ | theme detected | Clean install |
| Shopify/starter-theme | ⚠️ | no theme markers | Different structure — warned, still wrote files |
| Shopify/skeleton-theme | ✅ | theme detected | Clean install |

## What This Tests

- ✅ Layout detection (src/app, pages router, Nuxt version, Astro output mode, theme detection)
- ✅ Conflict detection (existing middleware, routes, public files)
- ✅ Path rewriting (app/ → src/app/)
- ✅ Skip/warn/merge logic
- ✅ No crashes or exceptions

## What This Doesn't Test

- ❌ Actually writing files into the project
- ❌ Whether the project builds after install
- ❌ Whether generated routes/middleware function correctly

## How to Re-run

The test script is at `packages/core/tests/real-repo-test.ts`. It requires repos to be cloned to `/tmp/w2agent-real-repo-test/repos/{platform}/{name}`.

```bash
# Clone repos (adjust list as needed)
git clone --depth 1 https://github.com/shadcn-ui/taxonomy /tmp/w2agent-real-repo-test/repos/nextjs/taxonomy
# ... etc

# Run
cd packages/core
npx tsx tests/real-repo-test.ts
```
