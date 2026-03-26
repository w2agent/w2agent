=== w2agent — AI Agent Discoverability ===
Contributors: w2agent
Tags: ai, llms, agents, llms.txt, agent-card
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Make your WordPress site discoverable by AI agents. Dynamically generates llms.txt and agent-card.json from your content.

== Description ==

w2agent makes your WordPress site AI-ready by automatically generating the files that AI agents and language models use to understand and interact with your site.

**What it does:**

* Serves `/llms.txt` — dynamically generated from your published posts, pages, and custom post types
* Serves `/.well-known/agent-card.json` — describes your site's AI capabilities
* Adds an AI discovery `<link>` tag to all pages
* Merges AI-friendly rules into your robots.txt
* Automatically notifies the w2agent platform when you publish or update content

**Dynamic content generation:**

The plugin generates llms.txt dynamically from your WordPress database — no static files to maintain. Content updates automatically when you publish, edit, or delete posts.

== Installation ==

1. Upload the `w2agent` folder to `/wp-content/plugins/`
2. Activate the plugin through **Plugins → Installed Plugins**
3. Visit **Settings → w2agent** to verify your endpoints are working
4. Optionally, connect your w2agent.dev account by entering your Site Slug and API Key

== Frequently Asked Questions ==

= Where do I find my API Key? =

Sign up or log in at [w2agent.dev](https://w2agent.dev), add your site, and copy the webhook token from your site dashboard.

= Does this slow down my site? =

No. Endpoints are only invoked when `/llms.txt` or `/.well-known/agent-card.json` is requested — typical visitors never trigger these routes. Content is cached and invalidated only on post save.

= Does this work with WooCommerce? =

Yes. Custom post types (including WooCommerce products) are automatically included in the generated llms.txt.

== Changelog ==

= 1.0.0 =
* Initial release
* Dynamic llms.txt generation from posts, pages, and custom post types
* agent-card.json endpoint
* robots.txt AI rules integration
* Settings page with API key + webhook configuration
