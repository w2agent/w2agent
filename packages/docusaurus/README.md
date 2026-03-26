# @w2agent/docusaurus

Docusaurus build plugin for [w2agent](https://w2agent.dev) — generates `llms.txt` from your docs at build time and serves `agent-card.json` for AI agent discovery.

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
  // plugins: [['@w2agent/docusaurus', { docsDir: 'docs', verbose: true }]],
};
```

## Generate content files

Run this once to seed your agent card and static fallback:

```bash
npx w2agent generate https://your-site.com --output ./static/
```

This populates `static/llms.txt` (fallback) and `static/.well-known/agent-card.json`.

## How it works

At build time (`postBuild`), the plugin:

1. Walks your `docs/` directory and parses frontmatter from each `.md`/`.mdx` file
2. Groups pages by directory structure into sections
3. Writes a complete `llms.txt` to the build output
4. Copies `static/.well-known/agent-card.json` to the build output
5. Optionally fires a webhook to trigger a re-crawl

If no docs are found, it falls back to `static/llms.txt` if present.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `docsDir` | `string` | `'docs'` | Docs directory relative to site root |
| `verbose` | `boolean` | `false` | Log extra details during build |

## Files generated

| Path | Description |
|------|-------------|
| `/llms.txt` | AI content index generated from docs |
| `/.well-known/agent-card.json` | Agent discovery card |

## Webhook

Set environment variables to trigger a re-crawl after each build:

```bash
W2AGENT_WEBHOOK_URL=https://w2agent.dev/api/webhook
W2AGENT_WEBHOOK_TOKEN=your-token
```
