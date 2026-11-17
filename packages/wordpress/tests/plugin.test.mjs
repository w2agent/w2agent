import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const php = readFileSync(new URL("../w2agent-plugin.php", import.meta.url), "utf-8");

function block(start, end) {
  const from = php.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = end ? php.indexOf(end, from) : php.length;
  assert.notEqual(to, -1, `missing ${end}`);
  return php.slice(from, to);
}

// A card whose url is home_url() is a homepage stub: the audit can never pass it.
test("never builds an agent card from site info", () => {
  assert.doesNotMatch(php, /function w2agent_generate_agent_card/);
  assert.doesNotMatch(php, /'url'\s*=>\s*\$site_url/);
  assert.doesNotMatch(php, /w2agent_agent_card/);
});

test("serves /.well-known/agent-card.json only when data/agent-card.json exists, on the main site", () => {
  assert.match(
    php,
    /define\( 'W2AGENT_AGENT_CARD_FILE', plugin_dir_path\( __FILE__ \) \. 'data\/agent-card\.json' \)/,
  );
  const route = block(
    "if ( $uri === w2agent_route_path( '/.well-known/agent-card.json' )",
    "exit;",
  );
  assert.match(
    route,
    /&& w2agent_serves_data_files\(\) && file_exists\( W2AGENT_AGENT_CARD_FILE \) \)/,
  );
  assert.match(route, /readfile\( W2AGENT_AGENT_CARD_FILE \)/);
  assert.match(php, /return ! is_multisite\(\) \|\| is_main_site\(\);/);
});

test("robots.txt rules do not advertise an agent card that may not exist", () => {
  const robots = block("add_filter( 'robots_txt'", "}, 99, 2 );");
  assert.doesNotMatch(robots, /agent-card/);
});

test("settings page lists the agent-card endpoint only when the file exists", () => {
  const row = block(
    "<?php if ( w2agent_serves_data_files() && file_exists( W2AGENT_AGENT_CARD_FILE ) ) : ?>",
    "<?php endif; ?>",
  );
  assert.match(row, /\/\.well-known\/agent-card\.json' \) \); \?>" target="_blank">View<\/a>/);
  assert.equal(php.match(/agent-card\.json' \) \); \?>" target="_blank">View/g).length, 1);
});

// WP-3
test("lists only published, non-password, publicly viewable items of searchable types", () => {
  const select = block("function w2agent_post_types()", "// ─── Dynamic");
  assert.match(select, /'post_status'\s*=> 'publish'/);
  assert.match(select, /'has_password' => false/);
  assert.ok(
    select.includes(
      "if ( is_post_publicly_viewable( $item ) && apply_filters( 'w2agent_include_post', true, $item ) )",
    ),
  );
  assert.match(select, /'exclude_from_search' => false/);
  assert.match(select, /is_post_type_viewable\( \$cpt \)/);
  assert.match(select, /apply_filters\( 'w2agent_post_types', \$types \)/);
});

test("strips shortcodes and tags from excerpts and full text", () => {
  assert.match(php, /trim\( wp_strip_all_tags\( strip_shortcodes\( \(string\) \$html \) \) \)/);
  assert.ok(
    php.includes(
      "trim( preg_replace( '/\\s+/', ' ', w2agent_plain_text( $item->post_excerpt ) ) )",
    ),
  );
  assert.match(
    php,
    /wp_trim_words\( w2agent_plain_text\( \$item->post_content \), 25, '\.\.\.' \)/,
  );
  assert.doesNotMatch(php, /strip_tags\(/);
});

// WP-4
test("orders pages by menu order and posts and custom types newest first, keeping the caps", () => {
  const select = block("function w2agent_sections()", "// ─── Dynamic");
  assert.match(select, /'orderby'\] = 'menu_order title'/);
  assert.match(select, /'order'\]\s+= 'ASC'/);
  assert.match(select, /'orderby'\] = 'date'/);
  assert.match(select, /'order'\]\s+= 'DESC'/);
  assert.match(select, /in_array\( \$type, \[ 'page', 'post' \], true \) \? 100 : 50/);
});

// WP-6
test("matches request paths against the home URL path so subdirectory installs work", () => {
  assert.match(php, /wp_parse_url\( home_url\( \$path \), PHP_URL_PATH \)/);
  assert.doesNotMatch(php, /\$uri === '\//);
  for (const route of ["/llms.txt", "/.well-known/agent-card.json"]) {
    assert.ok(php.includes(`$uri === w2agent_route_path( '${route}' )`), route);
  }
});

test("builds the discovery link and settings links from home_url", () => {
  assert.match(php, /href="' \. esc_url\( home_url\( '\/llms\.txt' \) \) \. '"/);
  assert.doesNotMatch(php, /href="\/llms\.txt"/);
  assert.doesNotMatch(php, /echo esc_url\( \$site_url \)/);
});

// WP-7
test("caches llms.txt in one transient holding a map keyed by home URL, newest 8 kept", () => {
  assert.ok(php.includes("$key   = md5( home_url( '/' ) );"));
  assert.ok(php.includes("get_transient( 'w2agent_llms_txt' )"));
  assert.ok(php.includes("$cache = array_slice( $cache, -8, null, true );"));
  assert.ok(php.includes("set_transient( 'w2agent_llms_txt', $cache, HOUR_IN_SECONDS )"));
  assert.ok(php.includes("isset( $cache[ $key ] ) && is_string( $cache[ $key ] )"));
});

test("clears the cache on post changes and on site title or tagline changes", () => {
  for (const hook of [
    "save_post",
    "deleted_post",
    "trashed_post",
    "untrashed_post",
    "update_option_blogname",
    "update_option_blogdescription",
  ]) {
    assert.ok(php.includes(`'${hook}'`), hook);
  }
  assert.match(php, /delete_transient\( 'w2agent_llms_txt' \)/);
  assert.doesNotMatch(php, /wp_cache_delete/);
});

test("does not serve /llms-full.txt and never reads full post content for output", () => {
  assert.doesNotMatch(php, /llms-full|llms_full/);
  assert.equal(php.match(/post_content/g).length, 1); // only the 25-word excerpt source
});

// WP-10
test("keeps its stored option names and public function names", () => {
  for (const name of [
    "function w2agent_generate_llms_txt",
    "function w2agent_settings_page",
    "'w2agent_api_key'",
    "'w2agent_webhook_slug'",
    "'w2agent',\n        'w2agent_settings_page'",
  ]) {
    assert.ok(php.includes(name), name);
  }
});

test("yields every front-end callback to the site-specific plugin, checked at call time", () => {
  assert.match(
    php,
    /function w2agent_front_end_yielded\(\) \{\s+return defined\( 'W2AGENT_SITE_PLUGIN' \);/,
  );
  assert.doesNotMatch(php, /^if \( defined\( 'W2AGENT_SITE_PLUGIN'/m);
  const redirect = block("add_action( 'template_redirect'", "$uri =");
  assert.match(redirect, /if \( w2agent_front_end_yielded\(\) \) return;/);
  const head = block("add_action( 'wp_head'", "echo");
  assert.match(head, /if \( w2agent_front_end_yielded\(\) \) return;/);
  const robots = block("add_filter( 'robots_txt'", "}, 99, 2 );");
  assert.match(robots, /if \( w2agent_front_end_yielded\(\) \) return \$output;/);
});

test("keeps the settings page and webhook when yielding", () => {
  assert.doesNotMatch(
    block("// ─── Platform notifications", "// ─── Settings page"),
    /front_end_yielded/,
  );
  assert.match(php, /add_options_page\(/);
});

// WP-9
test("notifies on publish transitions and published deletes, only for listed types", () => {
  const notify = block("// ─── Platform notifications", "// ─── Settings page");
  assert.doesNotMatch(notify, /'save_post'|'delete_post'/);
  assert.match(notify, /add_action\( 'transition_post_status', function \( \$new_status, \$old_status, \$post \)/);
  assert.ok(notify.includes("if ( $new_status !== 'publish' && $old_status !== 'publish' ) return;"));
  assert.match(notify, /add_action\( 'before_delete_post', function \( \$post_id, \$post = null \)/);
  assert.ok(notify.includes("$post->post_status !== 'publish'"));
  assert.ok(notify.includes("in_array( $post->post_type, w2agent_post_types(), true )"));
  assert.ok(notify.includes("wp_is_post_revision( $post ) || wp_is_post_autosave( $post )"));
  assert.ok(notify.includes("if ( ! $api_key || ! $webhook_slug ) return;"));
});

// Security review: the cache is shared, so it must not be built in the requester's context.
test("builds the cached llms.txt with no current user and restores it", () => {
  const gen = block("function w2agent_generate_llms_txt()", "// ─── Serve");
  const set = gen.indexOf("wp_set_current_user( 0 );");
  assert.ok(set > -1);
  assert.ok(set < gen.indexOf("w2agent_sections()"));
  assert.ok(gen.includes("} finally {\n        wp_set_current_user( $previous_user );"));
  assert.ok(gen.indexOf("wp_set_current_user( $previous_user )") < gen.indexOf("set_transient("));
});

test("avoids PHP newer than 7.4 and the placeholder word", () => {
  assert.doesNotMatch(php, /str_starts_with|str_ends_with|str_contains|\bmatch\s*\(|\?->/);
  assert.doesNotMatch(php, /undefined/);
});

test("readme.txt discloses the external service", () => {
  const readme = readFileSync(new URL("../readme.txt", import.meta.url), "utf-8");
  const section = readme.slice(readme.indexOf("== External services =="));
  assert.ok(section.length > 0 && readme.includes("== External services =="));
  assert.match(section, /https:\/\/w2agent\.dev/);
  assert.match(section, /nothing is sent/i);
  assert.match(section, /bearer token/);
  assert.match(section, /post/i);
});

// WP-5
test("robots.txt filter runs late, bails when discouraged, adds no Sitemap or * group", () => {
  const filter = block("add_filter( 'robots_txt'", "}, 99, 2 );");
  assert.match(filter, /if \( ! \$public \) return \$output;/);
  const additions = block("function w2agent_robots_additions", "add_filter( 'robots_txt'");
  assert.match(additions, /if \( ! isset\( \$named\[ strtolower\( \$token \) \] \) \)/);
  assert.match(additions, /if \( ! w2agent_robots_blocks_root\( \$star \) \) return '';/);
  assert.doesNotMatch(additions, /sitemap/i);
  assert.doesNotMatch(additions, /'User-agent: \*'/);
});
