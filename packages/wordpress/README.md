# @w2agent/wordpress

WordPress plugin for [w2agent](https://w2agent.dev) — AI agent discoverability via `llms.txt` and `agent-card.json`.

## Install

**Option A — WordPress Plugin Directory** (once approved):

Search "w2agent" in **Plugins → Add New** in your WordPress admin.

**Option B — Manual:**

1. Download `w2agent-plugin.php`
2. Create `/wp-content/plugins/w2agent/` and place the file there
3. Activate in **Plugins → Installed Plugins**

## What it does

- Serves `/llms.txt` dynamically from your published posts, pages, and custom post types
- Serves `/.well-known/agent-card.json` from site info
- Adds AI discovery `<link>` tag to all pages
- Merges AI bot rules into `robots.txt`
- Notifies w2agent.dev on content changes (optional, requires API key)

## Settings

Go to **Settings → w2agent** to:

- View active endpoints
- Enter your Site Slug and API Key from [w2agent.dev](https://w2agent.dev) to enable automatic re-crawling

## Environment

No build step required — pure PHP plugin.

| Requires | Version |
|----------|---------|
| WordPress | 6.0+ |
| PHP | 7.4+ |
