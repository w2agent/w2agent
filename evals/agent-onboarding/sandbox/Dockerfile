FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ARG CLAUDE_VERSION=2.1.326
ARG CODEX_VERSION=0.166.0
ARG PNPM_VERSION=9.15.0
RUN apk add --no-cache git bash ripgrep libgcc libstdc++ ca-certificates curl \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} @openai/codex@${CODEX_VERSION} pnpm@${PNPM_VERSION} \
 && npm cache clean --force
USER node
WORKDIR /home/node
