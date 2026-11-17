<?php
// Test-only mu-plugin: no outbound HTTP, log webhook-looking calls, register test post types.

add_filter('pre_http_request', function ($pre, $args, $url) {
    if (strpos($url, 'webhook') !== false) {
        $body = isset($args['body']) ? (is_string($args['body']) ? $args['body'] : wp_json_encode($args['body'])) : '';
        file_put_contents(WP_CONTENT_DIR . '/w2a-http.log', $url . ' ' . $body . "\n", FILE_APPEND);
    }
    return ['headers' => [], 'body' => '{}', 'response' => ['code' => 200, 'message' => 'OK'], 'cookies' => [], 'filename' => null];
}, 10, 3);

add_action('init', function () {
    if (isset($_GET['w2a_log_probe'])) {
        error_log('w2a-e2e log probe');
    }
    register_post_type('w2a_book', ['public' => true, 'label' => 'Books', 'has_archive' => true]);
    // Shaped like a page-builder template type: public, but hidden from search and menus.
    register_post_type('w2a_tmpl', [
        'public' => true,
        'label' => 'Builder Templates',
        'exclude_from_search' => true,
        'show_in_nav_menus' => false,
        'rewrite' => false,
    ]);
});
