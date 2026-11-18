# w2agent generate — Reference

Generate llms.txt, llms-full.txt, and per-page markdown files for any website. Auto-detects platform and generates native integration files.

## Usage

```bash
npx w2agent generate <url> [options]
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <dir>` | `./w2agent-output` | Output directory |
| `-f, --format <fmt>` | `all` | Output formats, comma-separated or repeated (`-f llms-txt,full` or `-f llms-txt -f full`). `all` = `llms-txt`, `full`, `markdown`, `robots-txt`, `schema-org`, `agent-card`, `faq`, `webmcp`. Opt-in only: `mcp-server`, `skill-md`, `openclaw`, `agents-md` (combine, e.g. `all,agents-md`). Unknown values exit with an error |
| `--no-platform` | off | Do not write platform integration files (`nextjs/`, `nuxt/`, ...) |
| `-m, --max-pages <n>` | `100` | Maximum pages to crawl |
| `-s, --sections <list>` | all | Only these URL path prefixes (comma-separated) |
| `--a2a-endpoint <url>` | none | Your live A2A agent endpoint; `agent-card` is skipped without it (also on `integrate`) |
| `--from-audit` | off | Run audit first, generate fixes for failed checks only (never `agent-card`: it needs your A2A endpoint) |
| `--timeout <ms>` | `10000` | Per-request timeout |

## Output Files

### Core Files (always generated)

#### llms.txt

Structured index following the [llmstxt.org](https://llmstxt.org) spec:

```markdown
# Site Name

> One-line description

## Docs

- [Getting Started](/docs/getting-started): How to set up the project
- [API Reference](/docs/api): Complete API documentation

## Blog

- [Latest Post](/blog/latest): Description of the post
```

Pages are auto-categorized into sections by URL path.

#### llms-full.txt

Full site content concatenated with frontmatter separators:

```markdown
---
url: "https://example.com/page"
title: "Page Title"
---

[full page content as markdown]
```

#### robots.txt

AI-friendly robots.txt for known AI crawlers. It adds Allow groups only for AI user and search agents that `User-agent: *` alone blocks (keeping the `*` path rules and Crawl-delay), and never changes a group that names an agent, so an owner's explicit block stays. `Sitemap:` is added only when a sitemap was found. A file that ends in a `User-agent` line with no rules gets no Allow group, because the added agents would join that group.

#### schema-org.json

Auto-detected Schema.org JSON-LD for the site. Pages that already carry JSON-LD are skipped. A page's type needs evidence on that page: `Article` only with an `article:published_time` meta tag (an author link alone gives `WebPage`), `FAQPage` only when question/answer entries were extracted from that page (they become its `mainEntity`; otherwise `WebPage`). Empty `name` and `description` are omitted. The `LocalBusiness` entry has no `speakable`, and `hasMenu` only when the business type is a food establishment (`Restaurant`, `CafeOrCoffeeShop`, `Bakery`, `BarOrPub`, `FastFoodRestaurant`, `IceCreamShop`, `Brewery`, `Distillery`, `Winery`, `FoodEstablishment`).

#### agent-card.json

A2A v1.0 agent card at `/.well-known/agent-card.json`: `name`, `description`, `version`, `provider`, `supportedInterfaces` (one `JSONRPC` / `1.0` interface), `capabilities`, `defaultInputModes` / `defaultOutputModes` (`text/plain`), and `skills` with `tags`. The interface URL is the `a2aEndpoint` generate option (`--a2a-endpoint`). Without it no card is generated, and platform integrations ship no agent-card file or route: a card pointing at the site homepage is a stub that the `well-known-agent-card` check can never pass. Publish a card only if the site operates an A2A agent.

#### faq.json

Extracted FAQ content in FAQPage schema format. Sources, first match per page wins: existing `FAQPage` JSON-LD (found on any page, including inside `@graph`, top-level arrays and `@type` arrays); then, on pages with FAQ wording, `<details>`/`<summary>`; `<dt>`/`<dd>` pairs whose term ends with `?`; and headings ending with `?` (needs at least two on the page). Answers from `<details>`, `<dt>`/`<dd>` and headings are entity-decoded plain text. JSON-LD answers are passed through as the site wrote them (HTML and entities included). The JSON-LD walk is bounded (32 levels, 10000 nodes).

#### Per-page Markdown

Individual `.md` files for each page, written to `markdown/` subdirectory.

#### Agent Server (`mcp-server`)

A standalone agent server project generated from crawled site content. Output to `mcp-server/`:

| File | Description |
|------|-------------|
| `server.ts` | MCP server with auto-detected tools, Express + Streamable HTTP |
| `data/pages.json` | All crawled pages as PageMarkdown[] |
| `data/faq.json` | FAQ entries (if detected) |
| `package.json` | Dependencies: @modelcontextprotocol/sdk, express, zod, tsx |
| `tsconfig.json` | Node ESM TypeScript config |
| `README.md` | Tool list, setup instructions, Claude Desktop config |

Auto-detected tools:

| Tool | Condition | Description |
|------|-----------|-------------|
| `list-pages` | Always | List all page titles + URLs |
| `get-page` | Always | Get markdown content by URL or slug |
| `search-site` | Always | Keyword search with weighted scoring (title 3x, description 2x, content 1x) |
| `search-faq` | FAQ content found | Search FAQ question/answer pairs |
| `site-search` | SearchAction in JSON-LD (also inside `@graph`, or in an array of `potentialAction`) | Returns the site's own search URL for a query. It never fetches the URL. The template is accepted only when the placeholder is in the query string, no other `{...}` variable and no userinfo is present, and the URL passes the same-origin or allowlist check |
| `submit-<form>` | Forms with action + named inputs | One tool per distinct form (identical forms on many pages, such as a header search box, become one tool). A GET form is sent as a GET with the fields as the query (read-only hint); a POST form is sent urlencoded. Radio groups become an enum, checkboxes a boolean (or a list for a same-name group), and unchecked or unset fields are not sent. Forms with a password input, a required file input, or `method="dialog"` get no tool. Hidden fields (CSRF tokens) are not sent, so token-protected forms still fail |

#### SKILL.md (`skill-md`)

Agent Skills file describing the site's capabilities, MCP server config, tool listing, and site overview. Written to `skills/<name>/SKILL.md`, so the directory can be copied into an agent's skills folder as is.

The frontmatter has exactly two fields, `name` and `description`. `<name>` is `<host>-agent`: the host in lowercase, every run of characters outside `a-z0-9` (dots, underscores, colons, brackets) turned into one hyphen, cut so the whole name stays at most 64 characters (a bare IP address becomes, for example, `192-0-2-1-agent`; an unparseable URL gives `site-agent`). It always matches `^[a-z0-9]+(-[a-z0-9]+)*$`, as the [Agent Skills specification](https://agentskills.io/specification) requires, and equals the directory name. `description` is one line of at most 1024 characters built from the site name and the homepage description; the cut never splits a character. Page titles and descriptions are escaped in the frontmatter and in the Markdown body, so a hostile title cannot add fields or headings. A run of three or more hyphens in a value is written as `\u002d` escapes, so tools that split the frontmatter on `---` still find it.

#### agents.md (`agents-md`)

A public Markdown summary of the site for AI agents that visit it. Serve it at the site root as `/agents.md`, the same path Shopify storefronts use. It is not a repository `AGENTS.md` for coding agents. Opt-in: `--format agents-md`.

It contains an overview (URL, page count), capabilities (llms.txt, OpenAPI, MCP, sitemap), authentication hints, AI bot permissions and key pages. The permissions come from the site's `robots.txt`. `Blocked` uses the same parser and root check as the audit, so the two agree on it. There is one row per known AI agent that a `User-agent` line names, plus one row for `*` only when `robots.txt` has a `User-agent: *` line. An agent whose own group has no `Allow`, `Disallow` or `Crawl-delay` line follows the `*` group, as in the parser. Each row says:

- `Blocked`: the agent may not crawl the site root `/`.
- `Partly restricted`: the root is open, but a `Disallow` rule applies to the agent and no `Allow` rule for the same path cancels it. An `Allow` for a different path does not cancel it, so a wildcard `Allow` that covers another `Disallow` can still show this value.
- `Allowed`: no `Disallow` rule applies, or every one is cancelled.

The section is left out when `robots.txt` names none of them. Site name, description, page titles and descriptions are escaped to one line, so they cannot add headings or break links.

#### WebMCP Declarations (`webmcp`)

WebMCP-compatible HTML forms with `toolname` attributes for declarative agent interaction, plus `webmcp.js`, which registers the same forms via `document.modelContext` (falling back to the deprecated `navigator.modelContext`). Generated for each platform adapter.

One tool per distinct form (a header search form repeated on every page is one tool). Forms with a password field, a required file input or `method="dialog"` get no tool; optional file inputs are not parameters. Radio groups and selects become an `enum`, a checkbox a `boolean`, a same-name checkbox group an array of `enum`. Annotations: `readOnlyHint: true` for GET forms; other methods `readOnlyHint: false, consequentialHint: true` (`destructiveHint` is not part of the WebMCP draft). `declarative.html` adds `toolautosubmit` only to GET forms.

`execute` finds the live form on the page by its resolved action and method (an input named `action`, `method` or `submit` does not confuse it), sets only the parameters the agent passed (omitted ones keep the page's own values), fires bubbling `input` and `change` events, and refuses to submit when a file is already selected or the form is invalid, returning an `isError` result that names the invalid fields. Otherwise it calls `requestSubmit()` (the form's own submit handlers run). The result says submission was requested, not that it succeeded.

#### OpenClaw SKILL.md (`openclaw`)

OpenClaw-compatible skill file. Written to `openclaw/skills/<name>/SKILL.md`, so it does not collide with the `skill-md` output when both formats are requested. `<name>` is derived as for `skill-md`. The frontmatter has exactly `name`, `description`, `homepage` (the site URL) and `user-invocable: true`. The same escaping and length limits apply. There is no `version` field, because OpenClaw does not define one.

Also available via `w2agent agent deploy`:

```bash
w2agent agent deploy <url>                     # Standalone MCP server
w2agent agent deploy <url> --self-host vercel  # Vercel-deployable project
w2agent agent deploy <url> --self-host cf      # Cloudflare Worker project
w2agent agent status <slug>                    # Check hosted deployment
W2AGENT_WEBHOOK_TOKEN=<token> w2agent agent update <slug>   # Re-crawl hosted deployment
```

`agent update` needs the deployment's webhook token (printed by `w2agent deploy`; `--show-token` shows it in full). Set `W2AGENT_WEBHOOK_TOKEN` or pass `--token <token>`; the saved login key is never used. Both commands honour `W2AGENT_API_URL` (https, or http on a loopback host; anything else exits 2), validate the slug (`^[a-z0-9-]+$`, exit 2 otherwise) and exit 1 on any failure.

The `--self-host` variants carry the same tools as the standalone server (FAQ, product and form tools, `--allow-host`). `agent deploy` exits 1 and writes nothing when no page can be crawled or no page has extractable content. `generate` does the same when a content format (`llms-txt`, `full`, `markdown`, `agents-md`, `mcp-server`, `skill-md`, `openclaw`) is requested and no page has extractable content, so an existing `llms.txt` is never overwritten by an empty stub. With only non-content formats (for example `robots-txt`), `generate` still writes them, but when no page has extractable content it skips the detected platform's integration files (they embed crawl-derived seeds, so a hand-written `<platform>/.../llms.txt` stays untouched) and prints a warning.

### Platform Integration Files (auto-detected)

When a platform is detected, additional integration files are generated (omitted with `--no-platform`):

| Platform | Files Generated |
|----------|----------------|
| **WordPress** | `wordpress/w2agent-plugin.php` — PHP plugin with dynamic llms.txt (published, public, non-password items only; cached up to 1 hour), `/llms-full.txt` served from the crawl snapshot `data/llms-full.txt` (a crawl-time snapshot; refresh by re-running `integrate` without `--install` and copying `data/` over the installed plugin folder; never built from post content), admin page, a request-time `robots_txt` filter (priority 99: when the `*` rules of the live robots.txt block `/`, it appends one group allowing the AI user and search agents it does not find named, copying the `*` path rules that do not block `/`, any Crawl-delay, and `Allow: /`; it never edits or removes a line, adds no `Sitemap:` line, and does nothing under "Discourage search engines" or when a physical `robots.txt` exists, which `integrate --install` reports as a manual step), `wordpress/data/` seed files (the `llms.txt` seed is served only while the site holds no posts of the listed types at all; data files are main site only on multisite), `wordpress/INSTALL.md`; `w2agent-webmcp.php` (WebMCP) and `w2agent-mcp-webhook.php` (re-crawl webhook; sends nothing until its slug and token are set) are loaded by the plugin from its folder. Uses `w2agent_site_*` names and the `w2agent-site/` plugin folder so it can run beside the standalone plugin |
| **Next.js** | `nextjs/app/llms.txt/route.ts` — ISR route handler, `nextjs/middleware.ts` — content negotiation (`--install` writes `proxy.ts` on Next.js 16), `nextjs/w2agent-build.mjs` — build script, run as `prebuild`, `nextjs/INSTALL.md` |
| **Nuxt** | `nuxt/server/routes/{llms.txt,llms-full.txt,index.md}.ts` — Nitro server routes, `nuxt/server/middleware/content-negotiation.ts`, `nuxt/modules/w2agent.ts` — bundles the seed files into the server build, `nuxt/public/{llms.txt,llms-full.txt}` seeds, `nuxt/w2agent-build.mjs` — build script, run as `prebuild`, `nuxt/INSTALL.md` |
| **Astro** | `astro/public/llms.txt` — static file, `astro/public/.well-known/agent-card.json`, `astro/src/pages/llms.txt.ts` and `astro/src/pages/.well-known/agent-card.json.ts` — SSR endpoints, `astro/w2agent-integration.mjs`, `astro/w2agent-build.mjs`, `astro/INSTALL.md` |
| **Shopify** | `shopify/snippets/w2agent-head.liquid` — head snippet with a link to `/llms.txt`, plus a Product JSON-LD block (`{{ product | structured_data }}`, only on `request.page_type == 'product'` with a product) only when the crawl found product pages and none had Product or ProductGroup schema; `INSTALL.md` says which case applied, `shopify/templates/llms.txt.liquid` — optional override of the `/llms.txt` that Shopify already serves (the generated llms.txt with every `{{` and `{%` escaped, plus one link to the store's `/agents.md`; rendered with only the `request` and `agents` objects), `shopify/snippets/w2agent-webmcp.liquid` when WebMCP is generated, `shopify/INSTALL.md`; only when the crawled `robots.txt` blocks AI agents through the `*` group (Shopify's default does not), `shopify/data/robots-txt-additions.txt` (Allow groups for the AI agents that only the `*` group blocks, to paste at the end of the theme's existing `templates/robots.txt.liquid`; no `Sitemap:` line, never reverses a block that names an agent; `{` and `}` are percent-encoded so crawled paths cannot run as Liquid). No `robots.txt.liquid` is generated: it would replace the owner's custom rules |
| **Docusaurus** | `docusaurus/w2agent-plugin.js` — build plugin that generates llms.txt from the docs Docusaurus loaded (keeps an existing `static/llms.txt` unless `overwrite: true`), `docusaurus/w2agent-webmcp-module.js` (WebMCP client module, only when WebMCP tools are generated), `docusaurus/INSTALL.md` |

## Platform Detection

Detection runs against already-crawled pages (zero extra HTTP requests). It reads the homepage first and all pages only when the homepage matches nothing. Signals are markup only (meta tags, element ids and classes, `script[src]`/`link[href]` URLs, headers, code scripts); prose, code blocks and data payloads do not count. On equal confidence the winner is Next.js, Nuxt, Astro, Docusaurus, Shopify, then WordPress.

| Platform | Signal | Confidence |
|----------|--------|-----------|
| WordPress | `<meta name="generator" content="WordPress">` | 100% |
| WordPress | `/wp-content/` or `/wp-includes/` in `script[src]`/`link[href]`, same host (a leading `www.` ignored) or relative; image preloads excluded | 95% |
| WordPress | `https://api.w.org/` link (HTML or `Link` header) | 85% |
| WordPress | `/wp-content/` or `/wp-includes/` asset on another host (headless backend hint) | 50% |
| Next.js | `__NEXT_DATA__` script tag | 100% |
| Next.js | `/_next/static/` in `script[src]`/`link[href]`, `/_next/image` in same-host `img`, `x-powered-by: Next.js` | 95% |
| Nuxt | `<meta name="generator" content="Nuxt">` | 100% |
| Nuxt | `script#__NUXT_DATA__`, a `window.__NUXT__ =` assignment in a code script (strings and comments ignored), `x-powered-by: Nuxt` | 95% |
| Nuxt | `/_nuxt/` in `script[src]`/`link[href]` | 85% |
| Astro | `<meta name="generator" content="Astro">` | 100% |
| Astro | `astro-island` element | 95% |
| Astro | `data-astro-cid-*` attribute | 90% |
| Astro | `/_astro/` in `script[src]`/`link[href]` | 85% |
| Shopify | `cdn.shopify.com` in `script[src]`/`link[href]`, Shopify headers | 95% |
| Shopify | `*.myshopify.com` page host, a `Shopify.theme =` assignment in a code script (strings and comments ignored), `script#shopify-features` | 90% |
| Docusaurus | `<meta name="generator" content="Docusaurus">` | 100% |
| Docusaurus | `docusaurus*` class on `<html>` | 95% |
| Docusaurus | `#__docusaurus`, `theme-doc-*` or `docusaurus*` class | 90% |

## `integrate` Command

Focused command for platform-specific output only:

```bash
npx w2agent integrate <url> [--platform wordpress|nextjs|nuxt|astro|shopify|docusaurus]
```

Auto-detects platform (or use `--platform` to force), generates only integration files, and shows deployment instructions. A forced platform runs on the crawled pages like a detected one, and only that platform's files are written.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <dir>` | `./w2agent-output` | Output directory (default mode) |
| `-p, --platform <platform>` | auto-detect | Force platform |
| `-m, --max-pages <n>` | `100` | Maximum pages to crawl |
| `--timeout <ms>` | `10000` | Per-request timeout |
| `--install` | off | Install files directly into your project |
| `--project-dir <dir>` | `.` | Project root for `--install` |
| `--dry-run` | off | Show what would be installed; never writes files (works with or without `--install`) |
| `--site-url <url>` | none | Production origin to write into generated content when crawling another origin (e.g. localhost) |
| `--json` | off | One JSON document on stdout (result or error envelope); see [CLI-AGENT-MODE.md](CLI-AGENT-MODE.md) |

### `--install` Mode

With `--install`, files are copied directly into your project instead of an output directory:

```bash
npx w2agent integrate https://my-site.com --install
npx w2agent integrate https://my-site.com --install --project-dir ../my-app
npx w2agent integrate https://my-site.com --install --dry-run  # preview only
```

Each platform has a dedicated install resolver that detects your project layout and handles conflicts:

- **Next.js** — detects `src/app/` vs `app/`, Pages Router vs App Router, existing middleware/routes
- **Nuxt** — detects Nuxt 2 vs 3, existing server routes and middleware
- **Astro** — detects static vs server output mode (an Astro 4 `hybrid` setting counts as server), installs SSR endpoints only when applicable (they render on demand, so they need an adapter; a static project without one gets no endpoint); the emitted endpoints answer 404 when the file is missing. The emitted `w2agent-integration.mjs` keeps each of `public/llms.txt` and `public/llms-full.txt` that exists (it generates the other) unless called with `{ overwrite: true }` (both) or `{ overwrite: ["llms-full.txt"] }` (the listed files); the emitted `w2agent-build.mjs` has the same rule through `--overwrite` (both) and `--overwrite=llms-full.txt` (comma-separated), and a plain run only writes missing files; the post-install steps pass the files this install wrote as seeds, and the emitted INSTALL.md's manual path copies both seeds, so its integration step says `overwrite: true` (a hand-written file stays unless listed)
- **Docusaurus** — detects existing plugin config; adds a `clientModules` post-install step when the WebMCP module is written
- **WordPress** — detects WP root, custom plugin dir, installs to `wp-content/plugins/w2agent-site/`
- **Shopify** — detects theme directory and installs only the snippets (`snippets/w2agent-head.liquid`, `snippets/w2agent-webmcp.liquid`), then lists render and `shopify theme push --only` steps for the files it wrote; `templates/llms.txt.liquid`, `data/robots-txt-additions.txt` and `W2AGENT-MCP-WEBHOOK.md` are reported as manual actions (`w2agent integrate <url> --platform shopify --output <dir>` writes them); never writes `robots.txt.liquid` (paste the groups from `data/robots-txt-additions.txt` at the end of your existing one, after its `robots.default_groups` loop and your own rules); a store whose `robots.txt` does not block AI agents gets no robots files

Behavior:
- Skips non-project files (`INSTALL.md`)
- Detects existing files and skips with warnings instead of overwriting
- Existing middleware with w2agent code → skipped; without → saved as `.w2agent.ts` for manual merge
- Prints post-install steps (e.g., "add prebuild script", "activate plugin")
- Use `--dry-run` to preview the install plan without writing anything

## Page Discovery

Pages are discovered in two ways:

1. **Sitemap** — If `sitemap.xml` exists, URLs are extracted and crawled (up to `--max-pages`)
2. **Link fallback** — If the sitemap yields no extra pages, internal links from fetched pages are extracted and crawled

This means `w2agent generate` works on any site, even SPAs or sites without sitemaps.

## Content Extraction

The HTML → Markdown converter:

1. **Strips boilerplate** — nav, header, footer, sidebar, ads are removed using content density scoring
2. **Finds main content** — via `<main>`, `<article>`, `role="main"`, or highest text-density node
3. **Preserves structure** — headings, lists, tables, code blocks (with language hints), images (with alt text), links
4. **Inline formatting** — bold, italic, inline code, links converted to markdown syntax

## Examples

```bash
# Generate everything for a site
npx w2agent generate https://docs.example.com

# Only generate llms.txt
npx w2agent generate https://example.com --format llms-txt

# Only docs and blog sections, output to public/
npx w2agent generate https://example.com --sections docs,blog --format llms-txt,full --no-platform --output ./public/

# Crawl up to 100 pages
npx w2agent generate https://large-site.com --max-pages 100

# Generate platform integration files only
npx w2agent integrate https://your-wp-site.com
npx w2agent integrate https://your-site.com --platform nextjs
```

## Web UI

Try the hosted version at [w2agent.dev](https://w2agent.dev) — audit, generate, preview, and download files in the browser.

## Web API

The hosted platform exposes `POST /api/generate` with JSON body:

```json
{
  "url": "https://example.com",
  "options": {
    "maxPages": 20,
    "formats": ["llms-txt", "full"]
  }
}
```

Returns a `GenerateResult` JSON with all generated files and `platform` detection result.

## Programmatic Use

```typescript
import { runGenerate } from "w2agent-core";

const result = await runGenerate("https://example.com", {
  maxPages: 20,
  formats: ["llms-txt", "full"],
});

// Platform detection result
if (result.platform) {
  console.log(`Detected: ${result.platform.platform} (${result.platform.confidence})`);
}

for (const file of result.files) {
  console.log(file.filename, file.size);
}
```
