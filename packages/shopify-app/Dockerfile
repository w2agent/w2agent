# Build from the repository root (the context must contain pnpm-lock.yaml):
#   docker build -f packages/shopify-app/Dockerfile -t w2agent-shopify-app .
# Run with a persistent volume at /data (sessions live in /data/sessions.sqlite):
#   docker run -v w2agent-data:/data -p 3000:3000 -e SHOPIFY_API_KEY=... \
#     -e SHOPIFY_API_SECRET=... -e SHOPIFY_APP_URL=... -e SCOPES=... w2agent-shopify-app
# Don't pass the dev .env: its DATABASE_URL would move the database off /data.
# SQLite supports a single instance only. Building with this package as the
# context is unsupported and fails.

FROM node:22-alpine AS build
RUN apk add --no-cache openssl && corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shopify-app/package.json packages/shopify-app/.npmrc packages/shopify-app/
RUN pnpm install --frozen-lockfile --filter @w2agent/shopify-app...

COPY packages/shopify-app packages/shopify-app
RUN pnpm --filter @w2agent/shopify-app build


FROM node:22-alpine
RUN apk add --no-cache openssl && corepack enable
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_URL=file:/data/sessions.sqlite

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shopify-app/package.json packages/shopify-app/.npmrc packages/shopify-app/
RUN pnpm install --frozen-lockfile --prod --filter @w2agent/shopify-app...

WORKDIR /app/packages/shopify-app
COPY --from=build /app/packages/shopify-app/build ./build
COPY --from=build /app/packages/shopify-app/public ./public
COPY packages/shopify-app/prisma ./prisma
RUN ./node_modules/.bin/prisma generate && mkdir -p /data

VOLUME /data
EXPOSE 3000

CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec ./node_modules/.bin/remix-serve ./build/server/index.js"]
