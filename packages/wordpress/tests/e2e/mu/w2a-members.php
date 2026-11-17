<?php
// Test-only: a membership-style integration of the documented include filters.
// "Members only post" is listed only for users who can edit posts.
$w2a_members = function ($include, $post) {
    if ($post->post_title === 'Members only post') {
        return current_user_can('edit_posts');
    }
    return $include;
};
add_filter('w2agent_site_include_post', $w2a_members, 10, 2);
add_filter('w2agent_include_post', $w2a_members, 10, 2);
