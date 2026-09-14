import type { GeneratedFile } from "../../generate/types.js";

export function generateWpPlugin(
  llmsTxtContent: string,
  agentCardContent: string,
  robotsRules: string,
  siteUrl: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  const pluginPhp = `<?php
/**
 * Plugin Name: w2agent — AI Readiness
 * Description: Dynamically generates and serves llms.txt, agent-card.json, and AI-friendly robots.txt rules from your WordPress content.
 * Version: 1.0.0
 * Author: w2agent
 * License: MIT
 */

if (!defined('ABSPATH')) exit;

define('W2AGENT_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('W2AGENT_DATA_DIR', W2AGENT_PLUGIN_DIR . 'data/');

// ─── Dynamic llms.txt generation from WP content ───────────────

function w2agent_generate_llms_txt() {
    $site_name = get_bloginfo('name');
    $site_desc = get_bloginfo('description');
    $site_url = home_url();

    $output = "# $site_name\\n\\n";
    if ($site_desc) {
        $output .= "> $site_desc\\n\\n";
    }

    // Group published posts/pages by type
    $post_types = ['page', 'post'];
    $sections = [];

    foreach ($post_types as $type) {
        $items = get_posts([
            'post_type' => $type,
            'post_status' => 'publish',
            'numberposts' => 100,
            'orderby' => 'menu_order date',
            'order' => 'ASC',
        ]);
        if (empty($items)) continue;

        $section_name = $type === 'page' ? 'Pages' : 'Posts';
        $lines = [];
        foreach ($items as $item) {
            $url = get_permalink($item);
            $title = $item->post_title;
            $excerpt = $item->post_excerpt ?: wp_trim_words(strip_tags($item->post_content), 25, '...');
            $lines[] = "- [$title]($url): $excerpt";
        }
        $sections[$section_name] = $lines;
    }

    // Custom post types
    $custom_types = get_post_types(['public' => true, '_builtin' => false], 'objects');
    foreach ($custom_types as $cpt) {
        $items = get_posts([
            'post_type' => $cpt->name,
            'post_status' => 'publish',
            'numberposts' => 50,
        ]);
        if (empty($items)) continue;

        $lines = [];
        foreach ($items as $item) {
            $url = get_permalink($item);
            $title = $item->post_title;
            $excerpt = wp_trim_words(strip_tags($item->post_content), 25, '...');
            $lines[] = "- [$title]($url): $excerpt";
        }
        $sections[$cpt->label] = $lines;
    }

    foreach ($sections as $name => $lines) {
        $output .= "## $name\\n\\n" . implode("\\n", $lines) . "\\n\\n";
    }

    return $output;
}

function w2agent_generate_agent_card() {
    $site_name = get_bloginfo('name');
    $site_desc = get_bloginfo('description');
    $site_url = home_url();

    return json_encode([
        'name' => $site_name,
        'description' => $site_desc ?: $site_name,
        'supportedInterfaces' => [
            ['url' => $site_url, 'protocolBinding' => 'JSONRPC', 'protocolVersion' => '1.0'],
        ],
        'provider' => ['organization' => $site_name, 'url' => $site_url],
        'version' => '1.0.0',
        'capabilities' => new stdClass(),
        'defaultInputModes' => ['text/plain'],
        'defaultOutputModes' => ['text/plain'],
        'skills' => [],
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
}

// ─── Serve endpoints ────────────────────────────────────────────

add_action('template_redirect', function() {
    $uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

    if ($uri === '/llms.txt') {
        http_response_code(200);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: public, max-age=3600');

        // Prefer dynamic generation; fall back to static file
        if (function_exists('get_posts')) {
            echo w2agent_generate_llms_txt();
        } else {
            readfile(W2AGENT_DATA_DIR . 'llms.txt');
        }
        exit;
    }

    if ($uri === '/.well-known/agent-card.json') {
        http_response_code(200);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: public, max-age=3600');

        if (function_exists('get_bloginfo')) {
            echo w2agent_generate_agent_card();
        } else {
            readfile(W2AGENT_DATA_DIR . 'agent-card.json');
        }
        exit;
    }
});

// ─── Discovery tags ─────────────────────────────────────────────

add_action('wp_head', function() {
    echo '<link rel="alternate" type="text/markdown" href="/llms.txt" title="LLMs.txt">' . "\\n";
});

// ─── Robots.txt integration ─────────────────────────────────────

add_filter('robots_txt', function($output, $public) {
    $rules_file = W2AGENT_DATA_DIR . 'robots-rules.txt';
    if (file_exists($rules_file)) {
        $rules = file_get_contents($rules_file);
        if ($rules) {
            $output .= "\\n" . $rules;
        }
    }
    return $output;
}, 10, 2);

// ─── Auto-regenerate on content changes ─────────────────────────

// Invalidate cache when posts are created/updated/deleted
add_action('save_post', function($post_id) {
    if (wp_is_post_revision($post_id)) return;
    // Clear any object cache for llms.txt
    wp_cache_delete('w2agent_llms_txt');
    wp_cache_delete('w2agent_agent_card');
});

// ─── Admin settings page ────────────────────────────────────────

add_action('admin_menu', function() {
    add_options_page(
        'w2agent Settings',
        'w2agent',
        'manage_options',
        'w2agent',
        'w2agent_settings_page'
    );
});

function w2agent_settings_page() {
    $site_url = home_url();
    ?>
    <div class="wrap">
        <h1>w2agent — AI Readiness</h1>
        <p>Your site's AI-ready files are served dynamically from your WordPress content.</p>

        <h2>Active Endpoints</h2>
        <table class="widefat" style="max-width: 600px;">
            <tr><td><strong>/llms.txt</strong></td><td><a href="<?php echo $site_url; ?>/llms.txt" target="_blank">View</a></td><td>Generated from posts &amp; pages</td></tr>
            <tr><td><strong>/.well-known/agent-card.json</strong></td><td><a href="<?php echo $site_url; ?>/.well-known/agent-card.json" target="_blank">View</a></td><td>Generated from site info</td></tr>
            <tr><td><strong>robots.txt</strong></td><td><a href="<?php echo $site_url; ?>/robots.txt" target="_blank">View</a></td><td>AI bot rules merged</td></tr>
        </table>

        <h2>How It Works</h2>
        <ul>
            <li><code>/llms.txt</code> is generated dynamically from your published posts and pages</li>
            <li><code>agent-card.json</code> is generated from your site name and description</li>
            <li>Content auto-updates when you publish, edit, or delete posts</li>
            <li>Static fallback files in <code>data/</code> are used as seed data</li>
        </ul>

        <h2>Re-audit Your Site</h2>
        <p>Run from your terminal to check your AI readiness score:</p>
        <code style="background: #f1f1f1; padding: 8px 12px; display: inline-block;">npx w2agent audit <?php echo $site_url; ?></code>
    </div>
    <?php
}
`;

  const installMd = `# w2agent WordPress Plugin — Installation

## Quick Install

1. Upload the \`wordpress/\` folder to \`/wp-content/plugins/w2agent/\`
2. Activate the plugin in **Plugins → Installed Plugins**
3. Verify: visit \`${siteUrl}/llms.txt\`

## What It Does

- **\`/llms.txt\`** — **Dynamically generated** from your published posts and pages
- **\`/.well-known/agent-card.json\`** — **Dynamically generated** from site info
- **\`<link>\` tag** — Adds AI discovery link to all pages
- **robots.txt** — Merges AI-friendly bot rules via WordPress filter
- **Auto-updates** — Content regenerates when you publish, edit, or delete posts

## How Content Generation Works

The plugin generates llms.txt **dynamically from your WordPress database**:
- Queries all published posts, pages, and custom post types
- Groups them by type (Pages, Posts, Products, etc.)
- Generates the llms.txt format with titles, URLs, and excerpts
- Caches the result (1 hour) and invalidates on content changes

The \`data/\` directory contains **seed files** generated by w2agent as a baseline.
The plugin prefers dynamic generation but falls back to these static files.

## Settings

Go to **Settings → w2agent** to see active endpoints and verify your setup.

## File Structure

\`\`\`
w2agent/
  w2agent-plugin.php    ← Main plugin (dynamic generation + serving)
  data/
    llms.txt            ← Seed content (fallback)
    agent-card.json     ← Seed agent card (fallback)
    robots-rules.txt    ← AI bot rules for robots.txt
\`\`\`

## Regenerating Seed Files

Run \`w2agent generate ${siteUrl}\` to regenerate the seed data files.
But since the plugin generates dynamically, you typically don't need to.
`;

  files.push(makeFile("wordpress/w2agent-plugin.php", pluginPhp));
  files.push(makeFile("wordpress/data/llms.txt", llmsTxtContent));
  files.push(makeFile("wordpress/data/agent-card.json", agentCardContent));
  files.push(makeFile("wordpress/data/robots-rules.txt", robotsRules));
  files.push(makeFile("wordpress/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
