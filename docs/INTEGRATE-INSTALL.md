# `w2agent integrate --install` — Implementation Notes

## What Was Shipped

The `integrate` command now supports `--install` mode that copies platform-specific files directly into the user's project, instead of writing to an output directory.

### Commit: `64f198d`

**Files changed:**
- `packages/cli/src/commands/integrate.ts` — added `--install` and `--project-dir` flags, install logic
- `packages/cli/apps/web/` — Next.js template files used as reference/test fixtures

### How `--install` Works

1. Runs the normal generate pipeline (crawl, extract, detect platform, generate integration files)
2. Instead of writing all files to `--output` dir, copies platform-specific files into the project root
3. Smart handling for files that might conflict:
   - `INSTALL.md` is skipped (not a project file)
   - `middleware.ts` is merge-aware: if user already has one with w2agent code, skip; if existing without w2agent code, save as `.w2agent.ts` for manual merge; if no existing middleware, install normally
   - Seed files (`public/llms.txt`, `public/llms-full.txt`) are only installed if the platform adapter doesn't include route handlers that would serve the same content dynamically

### Template Files (Next.js)

The `packages/cli/apps/web/` directory contains the generated output from running `w2agent integrate http://localhost:3737 --platform nextjs --install`. These files serve as a reference for what gets installed:

```
packages/cli/apps/web/
├── app/
│   ├── .well-known/agent-card.json/route.ts  # Agent discovery endpoint
│   ├── llms-full.txt/route.ts                # Full content route (ISR)
│   └── llms.txt/route.ts                     # llms.txt route (ISR, with fallback)
├── middleware.ts                              # Content negotiation (text/markdown → /llms.txt)
├── public/
│   ├── llms-full.txt                         # Seed content (45KB generated from localhost)
│   └── llms.txt                              # Seed content (3KB)
└── w2agent-build.mjs                         # CI/CD regeneration script
```

**Note:** These template files currently have `localhost:3737` hardcoded as the site URL. This is because they were generated against the local dev server. The actual install process generates files with the real target URL.

## What Still Needs Work

### Per-Platform Install Support

Currently `--install` logic is generic. Platform-specific quirks are not fully handled:

| Platform | Status | Notes |
|----------|--------|-------|
| Next.js | Working | Route handlers, middleware, build script, seed files |
| WordPress | Not applicable | WordPress uses a PHP plugin, not file-level install |
| Shopify | Not applicable | Shopify uses Liquid snippets in theme directories |
| Docusaurus | Untested | Should work (JS plugin file, no middleware conflicts) |
| Nuxt | Untested | Should work (Nitro routes, middleware) |
| Astro | Untested | Should work (public/ files, middleware) |

### Missing Features

1. **No `--dry-run` flag** — users can't preview what would be installed before it happens
2. **No rollback/uninstall** — once installed, there's no `w2agent uninstall` command
3. **No post-install verification** — should suggest running `w2agent audit` after install
4. **Middleware merge is manual** — when a conflict is detected, user gets a `.w2agent.ts` file but no automated merge tool
5. **No `package.json` script injection** — could auto-add `"postbuild": "node w2agent-build.mjs"` to the user's package.json
6. **Template files use localhost URLs** — the files in `packages/cli/apps/web/` have hardcoded `localhost:3737` (cosmetic, doesn't affect actual install which generates fresh files)

### Testing

- No unit tests for the `--install` code path. The `packages/core/tests/integration.test.ts` tests adapter generation but not the CLI install mechanism.
- Recommended: add a test that runs `integrate --install --project-dir <tmpdir>` and verifies file placement, merge behavior, and skip logic.

### Integration with Site Service

The `--install` command is independent of the hosted site service (`w2agent.dev/api/mcp/deploy`). A future enhancement could link them: after `--install`, optionally deploy to the hosted service for badge/monitoring.
