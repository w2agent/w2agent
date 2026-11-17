# @w2agent/nuxt

Nuxt module for [w2agent](https://w2agent.dev) — auto-registers Nitro routes for `llms.txt`, agent card, and webhooks.

Works with Nuxt 3 and Nuxt 4.

## Install

```bash
npx nuxi module add @w2agent/nuxt
# or
npm install @w2agent/nuxt
```

## Setup

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@w2agent/nuxt'],
  w2agent: {
    siteUrl: 'https://your-site.com',   // unused; accepted for compatibility
    webhookEnabled: true,               // default: true
  }
})
```

## Generate content files

> `w2agent` is not published on npm yet. Build it from this repo (see [Development](../../README.md#development)), then run `npm install -D <path-to-w2agent>/packages/cli` in your project so `npx w2agent` resolves.

```bash
npx w2agent generate https://your-site.com --format llms-txt,full --no-platform --output ./public/
```

This populates `public/llms.txt` and `public/llms-full.txt`. Only if your site runs an A2A agent, add `public/.well-known/agent-card.json`:

```bash
npx w2agent generate https://your-site.com --format agent-card --a2a-endpoint https://your-site.com/a2a --no-platform --output ./public/.well-known/
```

## Routes registered

| Route | Description |
|-------|-------------|
| `GET /llms.txt` | `public/llms.txt` as of build time; 404 when absent |
| `GET /llms-full.txt` | `public/llms-full.txt` as of build time; 404 when absent |
| `GET /index.md` | `public/llms.txt` served as `text/markdown`; 404 when absent |
| `GET /.well-known/agent-card.json` | A2A agent card from `public/.well-known/agent-card.json` (or `public/agent-card.json`) as of build time; 404 when absent |
| `POST /api/w2agent-webhook` | Re-crawl trigger (opt-out via `webhookEnabled: false`) |

The routes serve those files as they were when `nuxi build` ran. The module bundles only these four files from `public/` into the server build, so the server needs no `public/` directory at runtime and works from any working directory. Run the generate step before `nuxi build` (for example as a `prebuild` script); a file generated after the build is not served until you rebuild.

Content-negotiation middleware is also added: `/` (with `Vary: Accept`) redirects to `/index.md` when the request lists `text/markdown` at equal or higher q than `text/html`, and to `/llms.txt` when it lists `text/plain` at strictly higher q; browsers, `*/*` and `application/json, text/plain, */*` keep the HTML page.

## Environment variables

| Variable | Description |
|----------|-------------|
| `W2AGENT_WEBHOOK_URL` | Upstream webhook URL forwarded to when the relay route is called. |
| `W2AGENT_WEBHOOK_TOKEN` | Bearer token attached to the outbound upstream call (optional). |
| `W2AGENT_INBOUND_TOKEN` | Required for the `/api/w2agent-webhook` relay route. Callers must send `Authorization: Bearer <token>`. When unset, the route returns 401. |
