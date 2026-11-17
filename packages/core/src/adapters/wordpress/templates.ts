import { BOT_TOKENS } from "../../audit/shared/bot-tokens.js";
import type { GeneratedFile } from "../../generate/types.js";

/** AI user-triggered and search agents with a robots.txt token, in BOT_TOKENS order (never training agents). */
export function wpRobotsTokens(): string[] {
  const tokens = BOT_TOKENS.filter(
    (b) => b.robotsToken && (b.purpose === "user" || b.purpose === "search"),
  ).map((b) => b.token);
  return [...new Set(tokens)];
}

export function phpString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function generateWpPlugin(
  llmsTxtContent: string,
  agentCardContent: string | undefined,
  siteUrl: string,
  llmsFullContent?: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const tokenLines = wpRobotsTokens()
    .map((token) => `        ${phpString(token)},`)
    .join("\n");

  const pluginPhp = `<?php
/**
 * Plugin Name: w2agent — AI Readiness
 * Description: Dynamically generates and serves llms.txt and AI-friendly robots.txt rules from your WordPress content, and serves a provided A2A agent-card.json.
 * Version: 1.0.0
 * Author: w2agent
 * License: MIT
 */

if (!defined('ABSPATH')) exit;

// Marks this site-specific plugin as active. The standalone w2agent plugin checks it
// and leaves the front end to this one when both are active.
define('W2AGENT_SITE_PLUGIN', true);
define('W2AGENT_SITE_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('W2AGENT_SITE_DATA_DIR', W2AGENT_SITE_PLUGIN_DIR . 'data/');

// ─── Helpers ────────────────────────────────────────────────────

// The data/ files describe the crawled site: on multisite only the main site serves them.
function w2agent_site_serves_data_files() {
    return !is_multisite() || is_main_site();
}

// Path of a root-relative endpoint under this site's home URL (handles subdirectory installs).
function w2agent_site_route_path($path) {
    $route = wp_parse_url(home_url($path), PHP_URL_PATH);
    return is_string($route) ? $route : $path;
}

function w2agent_site_plain_text($html) {
    return trim(wp_strip_all_tags(strip_shortcodes((string) $html)));
}

function w2agent_site_seed($name) {
    if (!w2agent_site_serves_data_files()) return '';
    $file = W2AGENT_SITE_DATA_DIR . $name;
    if (!file_exists($file)) return '';
    $text = file_get_contents($file);
    return is_string($text) ? $text : '';
}

// ─── Content selection ──────────────────────────────────────────

// Pages, posts, and searchable public custom types. Owners can add or remove types
// with the w2agent_site_post_types filter (array of post type names).
function w2agent_site_post_types() {
    $types = ['page', 'post'];
    $custom = get_post_types(['public' => true, '_builtin' => false, 'exclude_from_search' => false], 'objects');
    foreach ($custom as $cpt) {
        if (is_post_type_viewable($cpt)) {
            $types[] = $cpt->name;
        }
    }

    $filtered = apply_filters('w2agent_site_post_types', $types);
    if (is_array($filtered)) {
        $types = $filtered;
    }
    return array_values(array_unique(array_filter($types, 'post_type_exists')));
}

// True when any post of a listed type exists in any status but auto-draft (trash counts, so
// trashed content does not bring the crawl-time seed back).
function w2agent_site_has_listed_type_posts() {
    foreach (w2agent_site_post_types() as $type) {
        foreach ((array) wp_count_posts($type) as $status => $count) {
            if ($status !== 'auto-draft' && (int) $count > 0) return true;
        }
    }
    return false;
}

// Sections of listable items. Owners and membership plugins can drop items with the
// w2agent_site_include_post filter (bool, WP_Post; default true).
function w2agent_site_sections() {
    $sections = [];

    foreach (w2agent_site_post_types() as $type) {
        $args = [
            'post_type' => $type,
            'post_status' => 'publish',
            'has_password' => false,
            'numberposts' => in_array($type, ['page', 'post'], true) ? 100 : 50,
        ];
        if ($type === 'page') {
            $args['orderby'] = 'menu_order title';
            $args['order'] = 'ASC';
        } else {
            $args['orderby'] = 'date';
            $args['order'] = 'DESC';
        }

        $posts = [];
        foreach (get_posts($args) as $item) {
            if (is_post_publicly_viewable($item) && apply_filters('w2agent_site_include_post', true, $item)) {
                $posts[] = $item;
            }
        }
        if (empty($posts)) continue;

        if ($type === 'page') {
            $name = 'Pages';
        } elseif ($type === 'post') {
            $name = 'Posts';
        } else {
            $object = get_post_type_object($type);
            $name = $object ? $object->label : $type;
        }
        $sections[] = ['name' => $name, 'posts' => $posts];
    }

    return $sections;
}

// ─── Dynamic llms.txt generation ────────────────────────────────

function w2agent_site_render($sections) {
    $site_name = get_bloginfo('name');
    $site_desc = get_bloginfo('description');

    $output = "# $site_name\\n\\n";
    if ($site_desc) {
        $output .= "> $site_desc\\n\\n";
    }

    foreach ($sections as $section) {
        $lines = [];
        foreach ($section['posts'] as $item) {
            $url = get_permalink($item);
            $title = $item->post_title;
            $excerpt = trim(preg_replace('/\\s+/', ' ', w2agent_site_plain_text($item->post_excerpt)));
            if ($excerpt === '') {
                $excerpt = wp_trim_words(w2agent_site_plain_text($item->post_content), 25, '...');
            }
            $lines[] = "- [$title]($url): $excerpt";
        }
        $output .= '## ' . $section['name'] . "\\n\\n" . implode("\\n", $lines) . "\\n\\n";
    }

    return $output;
}

// One transient holds a small map of home URL hash => text, so a different host or language
// home URL gets its own entry and the cache stays bounded (newest 8 kept).
function w2agent_site_generate_llms_txt() {
    $key = md5(home_url('/'));
    $cache = get_transient('w2agent_site_llms_txt');
    if (!is_array($cache)) {
        $cache = [];
    }
    if (isset($cache[$key]) && is_string($cache[$key])) {
        return $cache[$key];
    }

    // The cached text is shared by every visitor, so build it with no user: a membership filter
    // that checks current_user_can() must not list gated items for whoever triggers the rebuild.
    $previous_user = get_current_user_id();
    wp_set_current_user(0);
    try {
        $sections = w2agent_site_sections();
        $output = '';
        // Serve the crawl-time seed only for a site that holds no posts of the listed types at all.
        // Posts that exist but are not listable (private, password-protected, filtered out) must
        // never bring the seed back: it would republish what the owner took offline.
        if (empty($sections) && !w2agent_site_has_listed_type_posts()) {
            $output = w2agent_site_seed('llms.txt');
        }
        if ($output === '') {
            $output = w2agent_site_render($sections);
        }
    } finally {
        wp_set_current_user($previous_user);
    }

    unset($cache[$key]);
    $cache[$key] = $output;
    $cache = array_slice($cache, -8, null, true);
    set_transient('w2agent_site_llms_txt', $cache, HOUR_IN_SECONDS);
    return $output;
}

// ─── Serve endpoints ────────────────────────────────────────────

add_action('template_redirect', function() {
    $uri = isset($_SERVER['REQUEST_URI']) ? parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) : '';

    if ($uri === w2agent_site_route_path('/llms.txt')) {
        http_response_code(200);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: public, max-age=3600');
        echo w2agent_site_generate_llms_txt();
        exit;
    }

    // llms-full.txt is the anonymous crawl snapshot from the last integrate run, never built from
    // post content here (membership plugins gate bodies in ways a query cannot see). 404 when absent.
    if ($uri === w2agent_site_route_path('/llms-full.txt') && w2agent_site_serves_data_files() && file_exists(W2AGENT_SITE_DATA_DIR . 'llms-full.txt')) {
        http_response_code(200);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: public, max-age=3600');
        readfile(W2AGENT_SITE_DATA_DIR . 'llms-full.txt');
        exit;
    }

    // Only an operator-provided A2A card is served; without data/agent-card.json WordPress 404s.
    if ($uri === w2agent_site_route_path('/.well-known/agent-card.json') && w2agent_site_serves_data_files() && file_exists(W2AGENT_SITE_DATA_DIR . 'agent-card.json')) {
        http_response_code(200);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: public, max-age=3600');
        readfile(W2AGENT_SITE_DATA_DIR . 'agent-card.json');
        exit;
    }
});

// ─── Discovery tags ─────────────────────────────────────────────

add_action('wp_head', function() {
    echo '<link rel="alternate" type="text/markdown" href="' . esc_url(home_url('/llms.txt')) . '" title="LLMs.txt">' . "\\n";
});

// ─── Robots.txt integration ─────────────────────────────────────

// AI user-triggered and search agents (same list as the w2agent core generator; training agents are never listed).
function w2agent_site_robots_bot_tokens() {
    return [
${tokenLines}
    ];
}

// Trims the characters JavaScript trim() strips (ASCII whitespace, NBSP, BOM and Unicode spaces) so
// this parser agrees with robots-parser on UTF-8 input.
function w2agent_site_robots_trim($value) {
    $ws = '(?:[\\x09-\\x0D\\x20]|\\xC2\\xA0|\\xEF\\xBB\\xBF|\\xE1\\x9A\\x80|\\xE2\\x80[\\x80-\\x8A\\xA8\\xA9\\xAF]|\\xE2\\x81\\x9F|\\xE3\\x80\\x80)+';
    return preg_replace('/^' . $ws . '|' . $ws . '\\z/', '', (string) $value);
}

// $open is set when the last record with a key is a \`User-agent\` line: that group has no rules yet.
function w2agent_site_robots_groups($output, &$open = false) {
    $groups = [];
    $current = -1;
    $last_agent = false;
    $lines = explode("\\n", str_replace(["\\r\\n", "\\r"], "\\n", (string) $output));
    foreach ($lines as $raw) {
        $hash = strpos($raw, '#');
        $text = $hash === false ? $raw : substr($raw, 0, $hash);
        $colon = strpos($text, ':');
        if ($colon === false) continue;
        $key = strtolower(w2agent_site_robots_trim(substr($text, 0, $colon)));
        $value = w2agent_site_robots_trim(substr($text, $colon + 1));
        if ($key === '') continue;
        if ($key === 'user-agent') {
            if (!$last_agent || $current < 0) {
                $groups[] = ['agents' => [], 'rules' => [], 'delay' => null];
                $current = count($groups) - 1;
            }
            if ($value !== '') {
                $agent = strtolower($value);
                $slash = strpos($agent, '/');
                if ($slash !== false) $agent = substr($agent, 0, $slash);
                $groups[$current]['agents'][] = w2agent_site_robots_trim($agent);
            }
            $last_agent = true;
            continue;
        }
        $last_agent = false;
        if ($current < 0) continue;
        if ($key === 'allow' || $key === 'disallow') {
            $groups[$current]['rules'][] = ['allow' => $key === 'allow', 'value' => $value];
        } elseif ($key === 'crawl-delay') {
            $groups[$current]['delay'] = $value;
        }
    }
    $open = $last_agent;
    return $groups;
}

// Robots pattern match: \`*\` matches any run, a trailing \`$\` anchors the end.
function w2agent_site_robots_match($pattern, $path) {
    $plen = strlen($pattern);
    $len = strlen($path);
    $lengths = [0];
    for ($p = 0; $p < $plen; $p++) {
        $c = $pattern[$p];
        if ($c === '$' && $p + 1 === $plen) return $lengths[count($lengths) - 1] === $len;
        if ($c === '*') {
            $next = [];
            for ($i = $lengths[0]; $i <= $len; $i++) $next[] = $i;
            $lengths = $next;
            continue;
        }
        $next = [];
        foreach ($lengths as $l) {
            if ($l < $len && $path[$l] === $c) $next[] = $l + 1;
        }
        if (!$next) return false;
        $lengths = $next;
    }
    return true;
}

// True when the rules block "/": longest matching pattern wins, Allow wins a tie, empty values are ignored.
function w2agent_site_robots_blocks_root($rules) {
    $best = null;
    foreach ($rules as $rule) {
        if ($rule['value'] === '' || !w2agent_site_robots_match($rule['value'], '/')) continue;
        $longer = $best === null || strlen($rule['value']) > strlen($best['value']);
        $tie = $best !== null && strlen($rule['value']) === strlen($best['value']) && $rule['allow'] && !$best['allow'];
        if ($longer || $tie) $best = $rule;
    }
    return $best !== null && !$best['allow'];
}

// The text to append to the live robots.txt: one group that lets the AI agents through when the
// \`*\` rules block "/". An agent named anywhere in the output is never touched. '' when nothing is needed,
// and when the output ends in a \`User-agent\` line with no rules (our agents would join that group).
function w2agent_site_robots_additions($output) {
    $named = [];
    $star = [];
    $delay = null;
    $open = false;
    $parsed = w2agent_site_robots_groups($output, $open);
    if ($open) return '';
    foreach ($parsed as $group) {
        foreach ($group['agents'] as $agent) $named[$agent] = true;
        if (in_array('*', $group['agents'], true)) {
            $star = array_merge($star, $group['rules']);
            if ($group['delay'] !== null && $group['delay'] !== '') $delay = $group['delay'];
        }
    }
    if (!w2agent_site_robots_blocks_root($star)) return '';

    $lines = [];
    foreach (w2agent_site_robots_bot_tokens() as $token) {
        if (!isset($named[strtolower($token)])) $lines[] = 'User-agent: ' . $token;
    }
    if (!$lines) return '';
    foreach ($star as $rule) {
        if ($rule['value'] === '' || $rule['value'] === '/') continue;
        if (!$rule['allow'] && w2agent_site_robots_match($rule['value'], '/')) continue;
        $lines[] = ($rule['allow'] ? 'Allow: ' : 'Disallow: ') . $rule['value'];
    }
    if ($delay !== null) $lines[] = 'Crawl-delay: ' . $delay;
    $lines[] = 'Allow: /';
    return implode("\\n", $lines) . "\\n";
}

add_filter('robots_txt', function($output, $public) {
    if (!$public) return $output;
    $output = (string) $output;
    $additions = w2agent_site_robots_additions($output);
    $comment = stripos($output, 'llms.txt') === false ? '# llms.txt: ' . home_url('/llms.txt') . "\\n" : '';
    if ($additions === '' && $comment === '') return $output;
    if ($output !== '' && substr($output, -1) !== "\\n") $output .= "\\n";
    return $output . "\\n" . $additions . $comment;
}, 99, 2);

// ─── Cache invalidation ─────────────────────────────────────────

// The generated text is cached for an hour; any post change clears it.
function w2agent_site_flush_cache() {
    delete_transient('w2agent_site_llms_txt');
}

foreach (['save_post', 'deleted_post', 'trashed_post', 'untrashed_post', 'update_option_blogname', 'update_option_blogdescription'] as $w2agent_site_hook) {
    add_action($w2agent_site_hook, 'w2agent_site_flush_cache');
}

// ─── Optional files from the same folder ────────────────────────

// w2agent-webmcp.php (WebMCP tool script) and w2agent-mcp-webhook.php (re-crawl notifications,
// sends nothing until its slug and token are filled in) are written next to this file when the
// crawl produced them. Like the data/ files, they belong to the crawled site: main site only.
if (w2agent_site_serves_data_files()) {
    foreach (['w2agent-webmcp.php', 'w2agent-mcp-webhook.php'] as $w2agent_site_extra) {
        if (file_exists(__DIR__ . '/' . $w2agent_site_extra)) {
            require_once __DIR__ . '/' . $w2agent_site_extra;
        }
    }
}

// ─── Admin settings page ────────────────────────────────────────

add_action('admin_menu', function() {
    add_options_page(
        'w2agent Site Settings',
        'w2agent Site',
        'manage_options',
        'w2agent-site',
        'w2agent_site_settings_page'
    );
});

function w2agent_site_settings_page() {
    if (!current_user_can('manage_options')) return;
    ?>
    <div class="wrap">
        <h1>w2agent — AI Readiness</h1>
        <p>Your site's AI-ready files are served dynamically from your WordPress content.</p>

        <h2>Active Endpoints</h2>
        <table class="widefat" style="max-width: 600px;">
            <tr><td><strong>/llms.txt</strong></td><td><a href="<?php echo esc_url(home_url('/llms.txt')); ?>" target="_blank">View</a></td><td>Published, public posts &amp; pages</td></tr>
            <?php if (w2agent_site_serves_data_files() && file_exists(W2AGENT_SITE_DATA_DIR . 'llms-full.txt')) : ?>
            <tr><td><strong>/llms-full.txt</strong></td><td><a href="<?php echo esc_url(home_url('/llms-full.txt')); ?>" target="_blank">View</a></td><td>Served from data/llms-full.txt (crawl snapshot)</td></tr>
            <?php endif; ?>
            <?php if (w2agent_site_serves_data_files() && file_exists(W2AGENT_SITE_DATA_DIR . 'agent-card.json')) : ?>
            <tr><td><strong>/.well-known/agent-card.json</strong></td><td><a href="<?php echo esc_url(home_url('/.well-known/agent-card.json')); ?>" target="_blank">View</a></td><td>Served from data/agent-card.json</td></tr>
            <?php endif; ?>
            <tr><td><strong>robots.txt</strong></td><td><a href="<?php echo esc_url(home_url('/robots.txt')); ?>" target="_blank">View</a></td><td>Allows AI agents when the site-wide rules block everything (needs a virtual robots.txt)</td></tr>
        </table>

        <h2>How It Works</h2>
        <ul>
            <li><code>/llms.txt</code> is generated from your published, public pages, posts, and searchable custom post types; password-protected and non-public items are left out. The <code>w2agent_site_include_post</code> filter can drop further items</li>
            <li>The result is cached for up to one hour and cleared when you publish, edit, trash, or delete a post or change the site title or tagline</li>
            <li><code>/llms-full.txt</code> is the crawl snapshot in <code>data/llms-full.txt</code> from the last <code>w2agent integrate</code> run (see INSTALL.md to refresh it); it is never built from post content</li>
            <li><code>agent-card.json</code> is served only if <code>data/agent-card.json</code> exists (generate it with <code>--a2a-endpoint</code> when your site runs an A2A agent)</li>
            <li>Files in <code>data/</code> are crawl-time seeds: <code>llms.txt</code> is served only while the site has no posts of the listed types at all (any status except auto-draft, trash included)</li>
        </ul>

        <h2>Re-audit Your Site</h2>
        <p>Run from your terminal to check your AI readiness score:</p>
        <code style="background: #f1f1f1; padding: 8px 12px; display: inline-block;">npx w2agent audit <?php echo esc_html(home_url()); ?></code>
    </div>
    <?php
}
`;

  const installMd = `# w2agent WordPress Plugin — Installation

## Quick Install

1. Upload the \`wordpress/\` folder to \`/wp-content/plugins/w2agent-site/\` (\`w2agent integrate --install\` does this for you)
2. Activate the plugin in **Plugins → Installed Plugins**
3. Verify: visit \`${siteUrl}/llms.txt\`

## What It Does

- **\`/llms.txt\`** — **Dynamically generated** from your published, public pages, posts, and searchable custom post types
- **\`/llms-full.txt\`** — Served from \`data/llms-full.txt\`, the anonymous crawl snapshot from the last \`w2agent integrate\` run (see "Refreshing the Crawl Snapshot" below). It is never built from post content, so gated content cannot leak; the path 404s when the file is absent
- **\`/.well-known/agent-card.json\`** — Served from \`data/agent-card.json\` only if present. Generate it with \`w2agent generate ${siteUrl} --format agent-card --a2a-endpoint <url>\` when your site runs an A2A agent
- **\`<link>\` tag** — Adds AI discovery link to all pages
- **WebMCP** — When \`w2agent-webmcp.php\` is present in this folder, the plugin loads it and the WebMCP tool script is added to the page footer. No other step is needed
- **Webhook** — When \`w2agent-mcp-webhook.php\` is present, set your site slug and webhook token in it (replace \`YOUR_SLUG\` and \`YOUR_WEBHOOK_TOKEN\`). The plugin loads the file, and it sends nothing while the placeholders remain. It notifies w2agent when a published page, post, or other type listed in llms.txt is published, updated, unpublished, trashed, or deleted
- **robots.txt** — A WordPress filter reads the robots.txt WordPress serves at request time. If \`User-agent: *\` blocks the whole site, it appends one group that allows the AI user and search agents (such as ChatGPT-User, Claude-User, OAI-SearchBot) with \`Allow: /\`. It skips any agent your robots.txt names, never changes or removes an existing line, adds no \`Sitemap:\` line, and does nothing when "Discourage search engines" is on. It cannot run when a physical \`robots.txt\` file exists in the web root, because the web server serves that file; merge the groups from the generated \`robots.txt\` (\`w2agent integrate ${siteUrl} --output <dir>\`) by hand instead

## How Content Generation Works

The plugin generates llms.txt **dynamically from your WordPress database**:
- Includes published pages, posts, and public custom post types that WordPress shows in search
- Leaves out password-protected items and anything not publicly viewable
- Groups items by type (Pages, Posts, Products, etc.); pages follow their menu order, posts and custom types list the newest first
- Lists up to 100 pages, 100 posts, and 50 items per custom type
- Strips tags and shortcodes from excerpts
- Caches the result per home URL (at most 8 entries in one transient) for up to one hour; saving, trashing, restoring, or deleting any post, or changing the site title or tagline, clears the cache. Direct database edits and changes made through filters or permalink settings show up within the hour
- Add or remove post types with the \`w2agent_site_post_types\` filter, which receives and returns an array of post type names
- Drop individual items with the \`w2agent_site_include_post\` filter, which receives \`true\` and the \`WP_Post\` and returns a boolean (membership plugins can use it to hide gated items)

The \`data/\` directory contains **seed files** generated by w2agent as a baseline.
The files in \`data/\` are a crawl-time snapshot of your site, not live content.
The plugin serves \`data/llms.txt\` only while the site holds no posts of the listed types at all (any status except auto-draft; trashed posts count).
As soon as a post exists, the dynamic output replaces it, even if none of the posts is listable (for example when the only post is private). \`data/llms-full.txt\` is served as is.

## Multisite and Subdirectory Installs

- The files in \`data/\` describe the site that w2agent crawled. On multisite, only the main site serves them (\`agent-card.json\`, \`llms-full.txt\`, and the \`llms.txt\` seed). Other sites get dynamic llms.txt only.
- The WebMCP script (\`w2agent-webmcp.php\`) and the webhook file (\`w2agent-mcp-webhook.php\`) also load on the main site only, because they describe the crawled site too.
- For a site installed in a subdirectory (for example \`/blog\`), the endpoints are served under that path (\`/blog/llms.txt\`) and the discovery link points there. This needs pretty permalinks (rewrite rules that route through \`index.php\`); \`index.php/llms.txt\` style permalinks are not supported.
- Limits: with plain permalinks on a server that does not rewrite to \`index.php\`, the request never reaches WordPress, so these paths cannot be served. A subdirectory site cannot serve the origin-root \`robots.txt\` or \`/.well-known/\`; add those at the web-server level.

## Settings

Go to **Settings → w2agent Site** to see active endpoints and verify your setup.

## Using With the Standalone w2agent Plugin

Both plugins can be active: this one lives in \`w2agent-site/\`, the standalone in \`w2agent/\`. This plugin owns the front end (\`/llms.txt\`, the link tag, robots.txt); the standalone plugin keeps its settings page and platform notifications.

## File Structure

\`\`\`
w2agent-site/
  w2agent-plugin.php    ← Main plugin (dynamic generation + serving)
  w2agent-webmcp.php    ← WebMCP script, loaded by the main plugin (present when generated)
  w2agent-mcp-webhook.php ← Re-crawl webhook, loaded by the main plugin (present when generated)
  data/
    llms.txt            ← Seed content (used only while the site has no posts of the listed types)
    llms-full.txt       ← Crawl snapshot served at /llms-full.txt (present when generated)
    agent-card.json     ← A2A agent card (only with --a2a-endpoint)
\`\`\`

## Refreshing the Crawl Snapshot

\`w2agent integrate --install\` skips everything once \`w2agent-site/\` exists, and deleting that folder would lose the slug and token you set in \`w2agent-mcp-webhook.php\`. To refresh the \`data/\` files, run \`w2agent integrate ${siteUrl}\` again without \`--install\` and copy the new \`data/\` folder over \`w2agent-site/data/\`. Since the plugin generates llms.txt dynamically, you typically don't need to.
`;

  files.push(makeFile("wordpress/w2agent-plugin.php", pluginPhp));
  files.push(makeFile("wordpress/data/llms.txt", llmsTxtContent));
  if (llmsFullContent) {
    files.push(makeFile("wordpress/data/llms-full.txt", llmsFullContent));
  }
  if (agentCardContent) {
    files.push(makeFile("wordpress/data/agent-card.json", agentCardContent));
  }
  files.push(makeFile("wordpress/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
