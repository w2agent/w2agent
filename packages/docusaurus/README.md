# @w2agent/docusaurus

Docusaurus build plugin for [w2agent](https://w2agent.dev) — generates `llms.txt` from your docs at build time, and copies an A2A `agent-card.json` into the build if you provide one.

## Install

```bash
npm install @w2agent/docusaurus
```

## Setup

```js
// docusaurus.config.js
module.exports = {
  plugins: ['@w2agent/docusaurus'],
  // or with options:
  // plugins: [['@w2agent/docusaurus', { overwrite: true, verbose: true }]],
};
```

## Generate content files

> `w2agent` is not published on npm yet. Build it from this repo (see [Development](../../README.md#development)), then run `npm install -D <path-to-w2agent>/packages/cli` in your project so `npx w2agent` resolves.

Run this once to seed `static/llms.txt` (the build then serves that file as is; see [How it works](#how-it-works)):

```bash
npx w2agent generate https://your-site.com --format llms-txt --no-platform --output ./static/
```

This populates `static/llms.txt`. Only if your site runs an A2A agent, generate `static/.well-known/agent-card.json`:

```bash
npx w2agent generate https://your-site.com --format agent-card --a2a-endpoint https://your-site.com/a2a --no-platform --output ./static/.well-known/
```

## How it works

At build time (`postBuild`), the plugin:

1. Reads the docs Docusaurus loaded (the docs plugin content): title, description and permalink of each doc, for the latest version of every docs plugin instance
2. Skips unlisted and draft docs and docs of older versions
3. Groups docs by top-level docs directory into sections (number prefixes dropped; docs at the root go in "Docs")
4. Writes `llms.txt` to the build output, with links built from `url` plus the permalink (so `baseUrl`, `routeBasePath`, `slug` and `trailingSlash` are honoured)
5. Copies `static/.well-known/agent-card.json` to the build output, if it exists
6. Optionally fires a webhook to trigger a re-crawl

**An existing `static/llms.txt` (in any `staticDirectories` entry) is served as is**: the plugin keeps it and logs one line. This includes the file seeded by `w2agent generate` or `w2agent integrate`. Set `overwrite: true` to make the build generate `llms.txt` from the docs instead: `plugins: [['@w2agent/docusaurus', { overwrite: true }]]`. If there are no listable docs, it writes no `llms.txt`.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `overwrite` | `boolean` | `false` | Replace an existing `static/llms.txt` with the file generated from the docs (only `true` counts) |
| `verbose` | `boolean` | `false` | Log extra details during build |

## Files generated

| Path | Description |
|------|-------------|
| `/llms.txt` | AI content index generated from docs (or your `static/llms.txt`, unless `overwrite: true`) |
| `/.well-known/agent-card.json` | A2A agent card (only if `static/.well-known/agent-card.json` exists) |

## Webhook

Set environment variables to trigger a re-crawl after each build:

```bash
W2AGENT_WEBHOOK_URL=https://w2agent.dev/api/webhook
W2AGENT_WEBHOOK_TOKEN=your-token
```
