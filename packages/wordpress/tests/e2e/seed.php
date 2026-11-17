<?php
kses_remove_filters();
for ($i = 1; $i <= 150; $i++) {
    wp_insert_post([
        'post_title' => "Old post $i",
        'post_status' => 'publish',
        'post_content' => "Body of old post $i",
        'post_date' => date('Y-m-d H:i:s', strtotime('2020-01-01') + $i * 86400),
    ]);
}
wp_insert_post(['post_title' => 'Newest post marker', 'post_status' => 'publish', 'post_content' => 'Fresh content']);
// Pages and CPT entries are listed by both the old and the new ordering, so they isolate WP-3.
wp_insert_post(['post_type' => 'page', 'post_title' => 'Locked page', 'post_status' => 'publish', 'post_password' => 'pw', 'post_content' => 'SECRET-CONTENT words here', 'post_excerpt' => 'SECRET-EXCERPT']);
wp_insert_post(['post_type' => 'w2a_book', 'post_title' => 'Locked book', 'post_status' => 'publish', 'post_password' => 'pw', 'post_content' => 'BOOK-SECRET-CONTENT words']);
wp_insert_post(['post_type' => 'page', 'post_title' => 'Shortcode page', 'post_status' => 'publish', 'post_content' => 'Intro [gallery ids="1,2"] SHORTCODE-TAIL']);
wp_insert_post(['post_type' => 'page', 'post_title' => 'Cache probe page', 'post_status' => 'publish', 'post_content' => 'Cache probe body']);
wp_insert_post(['post_title' => 'Members only post', 'post_status' => 'publish', 'post_content' => 'MEMBER-BODY']);
wp_insert_post(['post_title' => 'Draft post', 'post_status' => 'draft', 'post_content' => 'DRAFT-CONTENT']);
wp_insert_post(['post_title' => 'Private post', 'post_status' => 'private', 'post_content' => 'PRIVATE-CONTENT']);
wp_insert_post(['post_type' => 'w2a_book', 'post_title' => 'Public book', 'post_status' => 'publish', 'post_content' => 'BOOK-CONTENT']);
wp_insert_post(['post_type' => 'w2a_tmpl', 'post_title' => 'Header template', 'post_status' => 'publish', 'post_content' => 'TEMPLATE-CONTENT']);
$front = wp_insert_post([
    'post_type' => 'page',
    'post_title' => 'Contact',
    'post_status' => 'publish',
    'post_content' => '<!-- wp:html --><form action="/contact-submit" method="post"><label for="em">Email</label><input id="em" name="email" type="email" required><button type="submit">Send</button></form><!-- /wp:html -->',
]);
update_option('show_on_front', 'page');
update_option('page_on_front', $front);
echo "seeded\n";
