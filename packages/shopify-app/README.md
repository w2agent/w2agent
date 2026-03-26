# @w2agent/shopify-app

Shopify App for [w2agent](https://w2agent.dev) — serves `llms.txt` via Shopify App Proxy.

## How it works

Install the app → it auto-generates `llms.txt` from your shop's products and pages. Served at:

```
https://your-store.myshopify.com/apps/w2agent/llms.txt
```

No manual page creation needed. Content updates automatically when products/pages change (cached for 1 hour).

## Prerequisites

| Requires | Details |
|----------|---------|
| Node.js | >=20.19 |
| Shopify CLI | `npm install -g @shopify/cli` |
| Shopify Partner Account | [partners.shopify.com](https://partners.shopify.com) |
| Development Store | Create from Partner Dashboard |

## Setup

1. Clone the repo and install dependencies:
   ```bash
   pnpm install
   ```

2. Link to your Shopify app:
   ```bash
   cd packages/shopify-app
   shopify app config link
   ```

3. Run development server:
   ```bash
   shopify app dev
   ```
   This starts the app, creates a tunnel, and sets up the app proxy.

## Development

```bash
pnpm --filter @w2agent/shopify-app dev    # shopify app dev
pnpm --filter @w2agent/shopify-app build   # prisma generate + remix build
pnpm --filter @w2agent/shopify-app test    # vitest
```

## Deployment

```bash
cd packages/shopify-app
shopify app deploy
```

This deploys the app configuration to Shopify. The Remix app itself needs to be hosted separately (e.g., on a Node.js server, Fly.io, Railway).

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/apps/w2agent/llms.txt` | GET | llms.txt via App Proxy (HMAC-verified) |

All other app proxy paths return 404.

## Data Scope

- **Shop**: name, description, primary domain
- **Products**: first 100 active products (title, handle, description)
- **Pages**: first 100 pages (title, handle, body)

## Canonical URL

The canonical endpoint is `/apps/w2agent/llms.txt` on the merchant's storefront. Root-level `/llms.txt` is not possible without a theme extension. Merchants can add a URL redirect from `/llms.txt` → `/apps/w2agent/llms.txt` in Shopify admin (Settings → Navigation → URL Redirects) if desired.

## Architecture

This is a private Remix app (not published to npm). It uses:
- `@shopify/shopify-app-remix` for OAuth + session management
- Shopify Admin GraphQL API for data fetching
- App Proxy for serving llms.txt on the merchant's domain
- Prisma + SQLite (dev) for session storage
