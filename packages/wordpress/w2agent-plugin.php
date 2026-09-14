<?php
/**
 * Plugin Name: w2agent — AI Agent Discoverability
 * Plugin URI:  https://w2agent.dev
 * Description: Dynamically generates and serves llms.txt and AI-friendly robots.txt rules, and serves an A2A agent-card.json you provide. Enables AI agents to discover and interact with your WordPress site.
 * Version:     1.0.0
 * Author:      w2agent
 * Author URI:  https://w2agent.dev
 * License:     GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: w2agent
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// Only an operator-provided A2A card is served (generate it with `w2agent generate <url>
// --format agent-card --a2a-endpoint <url>`); without this file WordPress 404s the path.
define( 'W2AGENT_AGENT_CARD_FILE', plugin_dir_path( __FILE__ ) . 'data/agent-card.json' );

// ─── Dynamic llms.txt generation ────────────────────────────────

function w2agent_generate_llms_txt() {
    $site_name = get_bloginfo( 'name' );
    $site_desc = get_bloginfo( 'description' );

    $output = "# {$site_name}\n\n";
    if ( $site_desc ) {
        $output .= "> {$site_desc}\n\n";
    }

    $post_types = [ 'page', 'post' ];
    $sections   = [];

    foreach ( $post_types as $type ) {
        $items = get_posts( [
            'post_type'   => $type,
            'post_status' => 'publish',
            'numberposts' => 100,
            'orderby'     => 'menu_order date',
            'order'       => 'ASC',
        ] );
        if ( empty( $items ) ) continue;

        $section_name = $type === 'page' ? 'Pages' : 'Posts';
        $lines = [];
        foreach ( $items as $item ) {
            $url     = get_permalink( $item );
            $title   = $item->post_title;
            $excerpt = $item->post_excerpt
                ?: wp_trim_words( strip_tags( $item->post_content ), 25, '...' );
            $lines[] = "- [{$title}]({$url}): {$excerpt}";
        }
        $sections[ $section_name ] = $lines;
    }

    $custom_types = get_post_types( [ 'public' => true, '_builtin' => false ], 'objects' );
    foreach ( $custom_types as $cpt ) {
        $items = get_posts( [
            'post_type'   => $cpt->name,
            'post_status' => 'publish',
            'numberposts' => 50,
        ] );
        if ( empty( $items ) ) continue;

        $lines = [];
        foreach ( $items as $item ) {
            $url     = get_permalink( $item );
            $title   = $item->post_title;
            $excerpt = wp_trim_words( strip_tags( $item->post_content ), 25, '...' );
            $lines[] = "- [{$title}]({$url}): {$excerpt}";
        }
        $sections[ $cpt->label ] = $lines;
    }

    foreach ( $sections as $name => $lines ) {
        $output .= "## {$name}\n\n" . implode( "\n", $lines ) . "\n\n";
    }

    return $output;
}

// ─── Serve endpoints ─────────────────────────────────────────────

add_action( 'template_redirect', function () {
    $uri = parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );

    if ( $uri === '/llms.txt' ) {
        status_header( 200 );
        header( 'Content-Type: text/plain; charset=utf-8' );
        header( 'Cache-Control: public, max-age=3600' );
        echo w2agent_generate_llms_txt();
        exit;
    }

    if ( $uri === '/.well-known/agent-card.json' && file_exists( W2AGENT_AGENT_CARD_FILE ) ) {
        status_header( 200 );
        header( 'Content-Type: application/json; charset=utf-8' );
        header( 'Cache-Control: public, max-age=3600' );
        readfile( W2AGENT_AGENT_CARD_FILE );
        exit;
    }
} );

// ─── Discovery link tag ──────────────────────────────────────────

add_action( 'wp_head', function () {
    echo '<link rel="alternate" type="text/markdown" href="/llms.txt" title="LLMs.txt">' . "\n";
} );

// ─── Robots.txt ──────────────────────────────────────────────────

add_filter( 'robots_txt', function ( $output, $public ) {
    $rules = "User-agent: *\nAllow: /llms.txt\n";
    return $output . "\n" . $rules;
}, 10, 2 );

// ─── Cache invalidation ──────────────────────────────────────────

add_action( 'save_post', function ( $post_id ) {
    if ( wp_is_post_revision( $post_id ) ) return;
    wp_cache_delete( 'w2agent_llms_txt' );

    // Notify w2agent.dev platform if configured
    $api_key      = get_option( 'w2agent_api_key', '' );
    $webhook_slug = get_option( 'w2agent_webhook_slug', '' );
    if ( $api_key && $webhook_slug ) {
        wp_remote_post( 'https://w2agent.dev/api/agent/webhook/' . sanitize_text_field( $webhook_slug ), [
            'headers'  => [
                'Content-Type'  => 'application/json',
                'Authorization' => 'Bearer ' . $api_key,
            ],
            'body'     => wp_json_encode( [ 'trigger' => 'wordpress', 'post_id' => $post_id ] ),
            'blocking' => false,
        ] );
    }
} );

// ─── Settings page ───────────────────────────────────────────────

add_action( 'admin_menu', function () {
    add_options_page(
        'w2agent Settings',
        'w2agent',
        'manage_options',
        'w2agent',
        'w2agent_settings_page'
    );
} );

add_action( 'admin_init', function () {
    register_setting( 'w2agent_options', 'w2agent_api_key', [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'default'           => '',
    ] );
    register_setting( 'w2agent_options', 'w2agent_webhook_slug', [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'default'           => '',
    ] );
} );

function w2agent_settings_page() {
    if ( ! current_user_can( 'manage_options' ) ) return;
    $site_url = home_url();
    ?>
    <div class="wrap">
        <h1>w2agent — AI Agent Discoverability</h1>
        <p>Your site's AI-ready files are served dynamically from WordPress content.</p>

        <h2>Active Endpoints</h2>
        <table class="widefat" style="max-width:600px">
            <tr>
                <td><strong>/llms.txt</strong></td>
                <td><a href="<?php echo esc_url( $site_url ); ?>/llms.txt" target="_blank">View</a></td>
                <td>Generated from posts &amp; pages</td>
            </tr>
            <?php if ( file_exists( W2AGENT_AGENT_CARD_FILE ) ) : ?>
            <tr>
                <td><strong>/.well-known/agent-card.json</strong></td>
                <td><a href="<?php echo esc_url( $site_url ); ?>/.well-known/agent-card.json" target="_blank">View</a></td>
                <td>Served from data/agent-card.json</td>
            </tr>
            <?php endif; ?>
            <tr>
                <td><strong>robots.txt</strong></td>
                <td><a href="<?php echo esc_url( $site_url ); ?>/robots.txt" target="_blank">View</a></td>
                <td>AI bot rules merged</td>
            </tr>
        </table>

        <h2>w2agent Platform Connection</h2>
        <p>Connect to <a href="https://w2agent.dev" target="_blank">w2agent.dev</a> to register your site and enable automatic re-crawling when you publish content.</p>

        <form method="post" action="options.php">
            <?php settings_fields( 'w2agent_options' ); ?>
            <table class="form-table">
                <tr>
                    <th scope="row"><label for="w2agent_webhook_slug">Site Slug</label></th>
                    <td>
                        <input type="text" id="w2agent_webhook_slug" name="w2agent_webhook_slug"
                               value="<?php echo esc_attr( get_option( 'w2agent_webhook_slug', '' ) ); ?>"
                               class="regular-text" placeholder="your-site-slug" />
                        <p class="description">Your site slug from the w2agent dashboard (e.g. <code>example-com</code>).</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="w2agent_api_key">API Key</label></th>
                    <td>
                        <input type="password" id="w2agent_api_key" name="w2agent_api_key"
                               value="<?php echo esc_attr( get_option( 'w2agent_api_key', '' ) ); ?>"
                               class="regular-text" autocomplete="off" />
                        <p class="description">Your webhook token from the w2agent dashboard. Used to authenticate content-change notifications.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button( 'Save Settings' ); ?>
        </form>
    </div>
    <?php
}
