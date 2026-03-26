# @w2agent/astro

Astro integration for [w2agent](https://w2agent.dev) — generates `llms.txt`, `llms-full.txt`, and `/.well-known/agent-card.json` for AI agent discoverability.

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

**Static/SSG output** (`astro:build:done`):
- Crawls `src/content/**/*.md` and `*.mdx`, extracts titles and descriptions, writes `llms.txt` to the build output directory
- Falls back to copying `public/llms.txt` if no content directory exists
- Copies `public/.well-known/agent-card.json` → `dist/.well-known/agent-card.json`
- Fires an optional webhook on build complete

**SSR output** (`output: 'server'`, in addition to the above):
- Injects `/llms.txt`, `/llms-full.txt`, `/.well-known/agent-card.json`, and `/api/w2agent-webhook` as server routes

## Options

```ts
w2agent({
  contentDir: "src/content",  // directory to crawl for content (default: 'src/content')
  webhookEnabled: true,        // inject /api/w2agent-webhook route in SSR mode (default: true)
  verbose: false,              // log extra info during build (default: false)
})
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `W2AGENT_WEBHOOK_URL` | Webhook URL to notify on build (optional) |
| `W2AGENT_WEBHOOK_TOKEN` | Bearer token for webhook auth (optional) |

## Generate agent files

Use the w2agent CLI to generate `llms.txt` and `agent-card.json` from a live site:

```bash
npx w2agent generate https://your-site.com --output ./public/
```
