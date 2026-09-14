# @w2agent/nuxt

Nuxt module for [w2agent](https://w2agent.dev) — auto-registers Nitro routes for `llms.txt`, agent card, and webhooks.

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
    siteUrl: 'https://your-site.com',   // optional: used in fallback content
    webhookEnabled: true,               // default: true
  }
})
```

## Generate content files

```bash
npx w2agent generate https://your-site.com --output ./public/
```

This populates `public/llms.txt` and `public/llms-full.txt`. Only if your site runs an A2A agent, add `public/.well-known/agent-card.json`:

```bash
npx w2agent generate https://your-site.com --format agent-card --a2a-endpoint https://your-site.com/a2a --output ./public/.well-known/
```

## Routes registered

| Route | Description |
|-------|-------------|
| `GET /llms.txt` | AI content index |
| `GET /llms-full.txt` | Full content dump |
| `GET /.well-known/agent-card.json` | A2A agent card from `public/.well-known/agent-card.json`; 404 when absent |
| `POST /api/w2agent-webhook` | Re-crawl trigger (opt-out via `webhookEnabled: false`) |

Content-negotiation middleware is also added: AI bots requesting `Accept: text/markdown` at `/` are redirected to `/llms.txt`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `W2AGENT_WEBHOOK_URL` | Upstream webhook URL forwarded to when the relay route is called. |
| `W2AGENT_WEBHOOK_TOKEN` | Bearer token attached to the outbound upstream call (optional). |
| `W2AGENT_INBOUND_TOKEN` | Required for the `/api/w2agent-webhook` relay route. Callers must send `Authorization: Bearer <token>`. When unset, the route returns 401. |
