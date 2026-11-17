# @w2agent/shopify-app

Shopify App for [w2agent](https://w2agent.dev) — serves `llms.txt` via Shopify App Proxy.

> **Experimental.** This app is not released, not published to npm, and not submitted to the Shopify App Store. Its admin UI is still the stock Shopify Remix template.

## How it works

Install the app → it auto-generates `llms.txt` from your shop's products and pages. Served at:

```
https://your-store.myshopify.com/apps/w2agent/llms.txt
```

No manual page creation needed. There is no webhook invalidation. The file is rebuilt from the Admin API when the cached copy is older than 15 minutes. Responses also carry `Cache-Control: public, max-age=900`, so a product or page change can take up to about 30 minutes to appear. If Shopify returns an error, the last good copy is served (or 503 when there is none).

## Prerequisites

| Requires | Details |
|----------|---------|
| Node.js | >=20.19 <22 or >=22.12 |
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

3. Point Prisma at the dev session database (the schema reads `DATABASE_URL`). Create `packages/shopify-app/.env` with:
   ```
   DATABASE_URL="file:dev.sqlite"
   ```

4. Run development server:
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

This deploys the app configuration to Shopify. The Remix app itself needs to be hosted separately.

Build the Docker image from the repository root (the build uses the root `pnpm-lock.yaml`):

```bash
docker build -f packages/shopify-app/Dockerfile -t w2agent-shopify-app .
docker run -v w2agent-data:/data -p 3000:3000 \
  -e SHOPIFY_API_KEY=... -e SHOPIFY_API_SECRET=... \
  -e SHOPIFY_APP_URL=https://your-app.example.com -e SCOPES=read_products,read_content \
  w2agent-shopify-app
```

The container runs `prisma migrate deploy`, then starts the server. Sessions live in a SQLite file at `/data/sessions.sqlite` (`DATABASE_URL` defaults to `file:/data/sessions.sqlite` in the image). Mount a persistent volume at `/data`, or every redeploy drops the offline sessions and the app proxy returns 401 until the merchant reopens the app. SQLite supports a single instance only. To run more than one instance, switch the Prisma provider and `DATABASE_URL` to a hosted database, as described in [Shopify's deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service), and add migrations for it.

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/apps/w2agent/llms.txt` | GET | llms.txt via App Proxy (HMAC-verified) |

All other app proxy paths return 404.

## Data Scope

- **Shop**: name, description, primary domain
- **Products**: active products published to the Online Store (title, handle, description) — paginated, up to 2,000
- **Pages**: published pages (title, handle, body) — paginated, up to 2,000

## Canonical URL

The canonical endpoint is `/apps/w2agent/llms.txt` on the merchant's storefront. Shopify already serves `/llms.txt` for every store, so a URL redirect from that path does not apply. To replace the store's `/llms.txt` with the generated content, use the optional `templates/llms.txt.liquid` override that `w2agent integrate <url> --platform shopify --output <dir>` writes. The app does not install it.

## Architecture

This is an experimental, private Remix app (`private: true`, not published to npm). It uses:
- `@shopify/shopify-app-remix` for OAuth + session management
- Shopify Admin GraphQL API for data fetching
- App Proxy for serving llms.txt on the merchant's domain
- Prisma + SQLite for session storage (`DATABASE_URL`; single instance, persistent volume in production)
