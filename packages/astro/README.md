# @w2agent/astro

Astro integration for [w2agent](https://w2agent.dev) — generates an `llms.txt` page index from your build for AI agent discoverability, and serves `/.well-known/agent-card.json` if you provide one.

## Install

```bash
npx astro add @w2agent/astro
```

Or manually:

```bash
npm install @w2agent/astro
```

```ts
// astro.config.mjs
import { defineConfig } from "astro/config";
import w2agent from "@w2agent/astro";

export default defineConfig({
  integrations: [w2agent()],
});
```

## What it does

**Static output** (`astro:build:done`):
- Lists the pages Astro built (title and meta description read from each built HTML file) in `llms.txt` in the build output. URLs use `site`, `base`, `trailingSlash` and the real page path, so content `slug`s and `draft` filtering follow your site. Pages with a robots `noindex` meta, endpoints and the 404/500 pages are left out.
- An existing `public/llms.txt` (for example one made by `w2agent generate`) is kept as is. Set `overwrite: true` to replace it with the generated index.
- Copies `public/.well-known/agent-card.json` → `dist/.well-known/agent-card.json` when that file exists (it is generated only with `--a2a-endpoint`)
- Fires an optional webhook on build complete

**Server output** (`output: 'server'`; Astro 5 has no `hybrid` mode):
- Astro reports no pages for a server build, so no `llms.txt` is generated; the other build steps above still run.
- Injects `/llms.txt`, `/llms-full.txt`, `/.well-known/agent-card.json`, and `/api/w2agent-webhook` as server routes. Each file route reads from `public/` in the working directory and answers 404 when the file does not exist.

**`llms-full.txt`** is not produced by this integration in any mode. Generate it with `w2agent generate` into `public/` (see below).

## Options

```ts
w2agent({
  overwrite: false,            // replace an existing public/llms.txt with the generated index (default: false)
  webhookEnabled: true,        // inject /api/w2agent-webhook route in SSR mode (default: true)
  verbose: false,              // log extra info during build (default: false)
})
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `W2AGENT_WEBHOOK_URL` | Upstream webhook URL to notify on build (optional) |
| `W2AGENT_WEBHOOK_TOKEN` | Bearer token attached to the outbound upstream call (optional) |
| `W2AGENT_INBOUND_TOKEN` | Required for the `/api/w2agent-webhook` relay route. Callers must send `Authorization: Bearer <token>`. When unset, the route returns 401. |

## Generate agent files

> `w2agent` is not published on npm yet. Build it from this repo (see [Development](../../README.md#development)), then run `npm install -D <path-to-w2agent>/packages/cli` in your project so `npx w2agent` resolves.

Generate `llms.txt` and `llms-full.txt` from a live site:

```bash
npx w2agent generate https://your-site.com --format llms-txt,full --no-platform --output ./public/
```

Only if your site runs an A2A agent, generate `agent-card.json` pointing at that agent's endpoint:

```bash
npx w2agent generate https://your-site.com --format agent-card --a2a-endpoint https://your-site.com/a2a --no-platform --output ./public/.well-known/
```
