import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const php = readFileSync(new URL("../w2agent-plugin.php", import.meta.url), "utf-8");

function block(start, end) {
  const from = php.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = end ? php.indexOf(end, from) : php.length;
  return php.slice(from, to);
}

// A card whose url is home_url() is a homepage stub: the audit can never pass it.
test("never builds an agent card from site info", () => {
  assert.doesNotMatch(php, /function w2agent_generate_agent_card/);
  assert.doesNotMatch(php, /'url'\s*=>\s*\$site_url/);
  assert.doesNotMatch(php, /w2agent_agent_card/);
});

test("serves /.well-known/agent-card.json only when data/agent-card.json exists", () => {
  assert.match(
    php,
    /define\( 'W2AGENT_AGENT_CARD_FILE', plugin_dir_path\( __FILE__ \) \. 'data\/agent-card\.json' \)/,
  );
  const route = block("if ( $uri === '/.well-known/agent-card.json'", "exit;");
  assert.match(route, /&& file_exists\( W2AGENT_AGENT_CARD_FILE \) \)/);
  assert.match(route, /readfile\( W2AGENT_AGENT_CARD_FILE \)/);
});

test("robots.txt rules do not advertise an agent card that may not exist", () => {
  const robots = block("add_filter( 'robots_txt'", "}, 10, 2 );");
  assert.doesNotMatch(robots, /agent-card/);
});

test("settings page lists the agent-card endpoint only when the file exists", () => {
  const row = block("<?php if ( file_exists( W2AGENT_AGENT_CARD_FILE ) ) : ?>", "<?php endif; ?>");
  assert.match(row, /\/\.well-known\/agent-card\.json" target="_blank">View<\/a>/);
  assert.equal(php.match(/agent-card\.json" target="_blank">View/g).length, 1);
});
