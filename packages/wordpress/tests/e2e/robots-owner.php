<?php
// Test-only mu-plugin (copied in by checks-robots.sh, removed afterwards): a site owner who blocks
// every crawler and names two AI agents. Priority 10 runs before both plugins' robots filters.
add_filter('robots_txt', function ($output, $public) {
    return "User-agent: *\nDisallow: /\nDisallow: /private/\n\nUser-agent: ChatGPT-User\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n";
}, 10, 2);
