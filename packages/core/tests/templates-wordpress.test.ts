import { describe, expect, it } from "vitest";
import { generateWpPlugin } from "../src/adapters/wordpress/templates.js";

const SAMPLE_LLMS = "# Test Site\n\n## Pages\n\n- [Home](https://example.com/): Welcome";
const SAMPLE_FULL = "# Test Site\n\n## Home\nhttps://example.com/\n\nWelcome";
const SAMPLE_CARD = JSON.stringify({ name: "Test Site", url: "https://example.com" });
const SAMPLE_ROBOTS = "User-agent: GPTBot\nAllow: /\n";
const SITE_URL = "https://example.com";

function generated() {
  return generateWpPlugin(SAMPLE_LLMS, SAMPLE_CARD, SAMPLE_ROBOTS, SITE_URL, SAMPLE_FULL);
}

function pluginPhp(): string {
  const plugin = generated().find((f) => f.filename === "wordpress/w2agent-plugin.php");
  if (!plugin) throw new Error("w2agent-plugin.php not found in generated files");
  return plugin.content;
}

function between(php: string, start: string, end: string): string {
  const from = php.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = php.indexOf(end, from);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return php.slice(from, to);
}

describe("generateWpPlugin — HTTP status codes", () => {
  it("sets http_response_code(200) for /llms.txt before content-type", () => {
    const php = pluginPhp();
    const llmsBlock = php.slice(php.indexOf("if ($uri === w2agent_site_route_path('/llms.txt'))"));
    const codePos = llmsBlock.indexOf("http_response_code(200)");
    const ctPos = llmsBlock.indexOf("Content-Type: text/plain");
    expect(codePos).toBeGreaterThan(-1);
    expect(codePos).toBeLessThan(ctPos);
  });

  it("serves /llms-full.txt only from the data file, on the main site, with 200 before content-type", () => {
    const php = pluginPhp();
    const block = php.slice(php.indexOf("if ($uri === w2agent_site_route_path('/llms-full.txt')"));
    const head = block.slice(0, block.indexOf("{"));
    expect(head).toContain("w2agent_site_serves_data_files()");
    expect(head).toContain("file_exists(W2AGENT_SITE_DATA_DIR . 'llms-full.txt')");
    const codePos = block.indexOf("http_response_code(200)");
    expect(codePos).toBeGreaterThan(-1);
    expect(codePos).toBeLessThan(block.indexOf("Content-Type: text/plain"));
    expect(block.slice(0, block.indexOf("exit;"))).toContain(
      "readfile(W2AGENT_SITE_DATA_DIR . 'llms-full.txt')",
    );
  });

  it("sets http_response_code(200) for /.well-known/agent-card.json before content-type", () => {
    const php = pluginPhp();
    const cardBlock = php.slice(
      php.indexOf("if ($uri === w2agent_site_route_path('/.well-known/agent-card.json')"),
    );
    const codePos = cardBlock.indexOf("http_response_code(200)");
    const ctPos = cardBlock.indexOf("Content-Type: application/json");
    expect(codePos).toBeGreaterThan(-1);
    expect(codePos).toBeLessThan(ctPos);
  });
});

describe("generateWpPlugin — file structure", () => {
  it("returns all required files", () => {
    const names = generated().map((f) => f.filename);
    expect(names).toContain("wordpress/w2agent-plugin.php");
    expect(names).toContain("wordpress/data/llms.txt");
    expect(names).toContain("wordpress/data/llms-full.txt");
    expect(names).toContain("wordpress/data/agent-card.json");
    expect(names).toContain("wordpress/data/robots-rules.txt");
    expect(names).toContain("wordpress/INSTALL.md");
  });

  it("embeds site URL in INSTALL.md", () => {
    const install = generated().find((f) => f.filename === "wordpress/INSTALL.md");
    expect(install?.content).toContain(SITE_URL);
  });

  it("passes through llms.txt content to data file", () => {
    const llms = generated().find((f) => f.filename === "wordpress/data/llms.txt");
    expect(llms?.content).toBe(SAMPLE_LLMS);
  });

  it("passes through llms-full.txt content to data file", () => {
    const full = generated().find((f) => f.filename === "wordpress/data/llms-full.txt");
    expect(full?.content).toBe(SAMPLE_FULL);
  });

  it("passes through agent-card content to data file", () => {
    const card = generated().find((f) => f.filename === "wordpress/data/agent-card.json");
    expect(card?.content).toBe(SAMPLE_CARD);
  });

  it("ships no llms-full seed when none was generated", () => {
    const files = generateWpPlugin(SAMPLE_LLMS, SAMPLE_CARD, SAMPLE_ROBOTS, SITE_URL);
    expect(files.map((f) => f.filename)).not.toContain("wordpress/data/llms-full.txt");
  });
});

describe("generateWpPlugin — PHP plugin content", () => {
  it("uses template_redirect to intercept endpoints", () => {
    expect(pluginPhp()).toContain("add_action('template_redirect'");
  });

  it("uses parse_url for the request path", () => {
    expect(pluginPhp()).toContain("parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH)");
  });

  it("starts with valid PHP open tag", () => {
    expect(pluginPhp().trimStart()).toMatch(/^<\?php/);
  });

  it("guards against direct access", () => {
    expect(pluginPhp()).toContain("if (!defined('ABSPATH')) exit");
  });

  it("serves only a provided agent-card.json and never builds a homepage-stub card from site info", () => {
    // A card whose interface is home_url() scores as a stub and can never pass the audit.
    const php = pluginPhp();
    expect(php).not.toContain("w2agent_generate_agent_card");
    expect(php).not.toContain("w2agent_site_generate_agent_card");
    expect(php).not.toContain("'supportedInterfaces'");
    const cardBlock = between(
      php,
      "if ($uri === w2agent_site_route_path('/.well-known/agent-card.json')",
      "// ─── Discovery tags",
    );
    expect(cardBlock).toContain("&& file_exists(W2AGENT_SITE_DATA_DIR . 'agent-card.json')");
    expect(cardBlock).toContain("readfile(W2AGENT_SITE_DATA_DIR . 'agent-card.json')");
  });

  it("without a generated agent card the plugin ships no agent-card data file", () => {
    const files = generateWpPlugin(SAMPLE_LLMS, undefined, SAMPLE_ROBOTS, SITE_URL);
    expect(files.map((f) => f.filename)).not.toContain("wordpress/data/agent-card.json");
  });

  it("contains no placeholder word and no PHP newer than 7.4", () => {
    for (const file of generated()) {
      expect(file.content).not.toContain("undefined");
    }
    const php = pluginPhp();
    expect(php).not.toMatch(
      /str_starts_with|str_ends_with|str_contains|\bmatch\s*\(|\?->|fn\s*\(.*\)\s*:/,
    );
  });
});

describe("generateWpPlugin — coexistence with the standalone plugin (WP-10)", () => {
  it("defines the W2AGENT_SITE_PLUGIN marker at load", () => {
    expect(pluginPhp()).toMatch(/^define\('W2AGENT_SITE_PLUGIN', true\);$/m);
  });

  it("prefixes every function, constant, transient, filter, and settings slug with w2agent_site", () => {
    const php = pluginPhp();
    const functions = [...php.matchAll(/^function (\w+)\(/gm)].map((m) => m[1]);
    expect(functions.length).toBeGreaterThan(5);
    for (const name of functions) expect(name).toMatch(/^w2agent_site_/);
    const constants = [...php.matchAll(/define\('(\w+)'/g)].map((m) => m[1]);
    for (const name of constants) expect(name).toMatch(/^W2AGENT_SITE_/);
    for (const m of php.matchAll(/(?:get|set|delete)_transient\('(\w+)'/g)) {
      expect(m[1]).toMatch(/^w2agent_site_/);
    }
    expect(php).toContain("apply_filters('w2agent_site_post_types'");
    expect(php).toContain("'w2agent-site',\n        'w2agent_site_settings_page'");
  });

  it("declares none of the standalone plugin's globals", () => {
    const php = pluginPhp();
    for (const standalone of [
      "w2agent_generate_llms_txt",
      "w2agent_settings_page",
      "W2AGENT_AGENT_CARD_FILE",
      "W2AGENT_PLUGIN_DIR",
      "W2AGENT_DATA_DIR",
      "w2agent_api_key",
      "w2agent_webhook_slug",
    ]) {
      expect(php).not.toContain(standalone);
    }
  });
});

describe("generateWpPlugin — content visibility and ordering (WP-3, WP-4)", () => {
  const sections = () =>
    between(pluginPhp(), "function w2agent_site_post_types()", "// ─── Dynamic");

  it("queries only published, non-password items and skips non-public ones", () => {
    const php = sections();
    expect(php).toContain("'post_status' => 'publish'");
    expect(php).toContain("'has_password' => false");
    expect(php).toContain(
      "if (is_post_publicly_viewable($item) && apply_filters('w2agent_site_include_post', true, $item))",
    );
  });

  it("limits custom types to searchable, viewable types and lets owners filter them", () => {
    const php = sections();
    expect(php).toContain("'exclude_from_search' => false");
    expect(php).toContain("is_post_type_viewable($cpt)");
    expect(php).toContain("apply_filters('w2agent_site_post_types'");
  });

  it("orders pages by menu order and posts and custom types newest first, keeping the caps", () => {
    const php = sections();
    expect(php).toContain("'orderby'] = 'menu_order title'");
    expect(php).toContain("'order'] = 'ASC'");
    expect(php).toContain("'orderby'] = 'date'");
    expect(php).toContain("'order'] = 'DESC'");
    expect(php).toContain("in_array($type, ['page', 'post'], true) ? 100 : 50");
  });

  it("strips shortcodes and tags from excerpts and full text", () => {
    const php = pluginPhp();
    expect(php).toContain("trim(wp_strip_all_tags(strip_shortcodes((string) $html)))");
    expect(php).toContain(
      "trim(preg_replace('/\\s+/', ' ', w2agent_site_plain_text($item->post_excerpt)))",
    );
    expect(php).toContain("wp_trim_words(w2agent_site_plain_text($item->post_content), 25, '...')");
    expect(php).not.toContain("strip_tags(");
  });

  it("never builds llms-full.txt from post content (gated bodies must not leak)", () => {
    const php = pluginPhp();
    expect(php).not.toContain("w2agent_site_generate_llms_full_txt");
    expect(php).not.toContain("$full");
    expect(php).not.toContain("w2agent_site_llms_full_txt");
    // full post_content is only ever read to derive a 25-word excerpt
    expect(php.match(/post_content/g)).toHaveLength(1);
  });
});

describe("generateWpPlugin — paths, multisite (WP-6)", () => {
  it("matches request paths against the home URL path, never a hard-coded root path", () => {
    const php = pluginPhp();
    expect(php).toContain("wp_parse_url(home_url($path), PHP_URL_PATH)");
    expect(php).not.toContain("$uri === '/");
    for (const route of ["/llms.txt", "/llms-full.txt", "/.well-known/agent-card.json"]) {
      expect(php).toContain(`$uri === w2agent_site_route_path('${route}')`);
    }
  });

  it("builds the discovery link and settings links from home_url", () => {
    const php = pluginPhp();
    expect(php).toContain("esc_url(home_url('/llms.txt'))");
    expect(php).not.toContain('href="/llms.txt"');
    expect(php).not.toContain("echo $site_url");
    expect(php).toContain("esc_url(home_url('/llms-full.txt'))");
  });

  it("serves crawl-derived data files on the main site only", () => {
    const php = pluginPhp();
    expect(php).toContain("return !is_multisite() || is_main_site();");
    const seed = between(php, "function w2agent_site_seed($name)", "// ─── Content selection");
    expect(seed.indexOf("w2agent_site_serves_data_files()")).toBeGreaterThan(-1);
    expect(seed.indexOf("w2agent_site_serves_data_files()")).toBeLessThan(
      seed.indexOf("file_get_contents"),
    );
    const card = between(
      php,
      "if ($uri === w2agent_site_route_path('/.well-known",
      "http_response_code",
    );
    expect(card).toContain("w2agent_site_serves_data_files()");
    const robots = between(php, "add_filter('robots_txt'", "}, 10, 2);");
    expect(robots).toMatch(/if \(!w2agent_site_serves_data_files\(\)\) return \$output;/);
  });
});

describe("generateWpPlugin — cache, seed, llms-full (WP-7)", () => {
  it("caches llms.txt in one transient holding a map keyed by home URL, newest 8 kept", () => {
    const php = pluginPhp();
    expect(php).toContain("$key = md5(home_url('/'));");
    expect(php).toContain("get_transient('w2agent_site_llms_txt')");
    expect(php).toContain("$cache = array_slice($cache, -8, null, true);");
    expect(php).toContain("set_transient('w2agent_site_llms_txt', $cache, HOUR_IN_SECONDS)");
    expect(php).toContain("isset($cache[$key]) && is_string($cache[$key])");
  });

  it("clears the cache on save, delete, trash, and untrash and drops the dead object-cache call", () => {
    const php = pluginPhp();
    for (const hook of [
      "save_post",
      "deleted_post",
      "trashed_post",
      "untrashed_post",
      "update_option_blogname",
      "update_option_blogdescription",
    ]) {
      expect(php).toContain(`'${hook}'`);
    }
    expect(php).toContain("delete_transient('w2agent_site_llms_txt')");
    expect(php).not.toContain("wp_cache_delete");
  });

  it("serves the seed file only when dynamic generation yields zero sections", () => {
    const php = pluginPhp();
    const block = between(
      php,
      "function w2agent_site_generate_llms_txt()",
      "// ─── Serve endpoints",
    );
    expect(block).toMatch(
      /if \(empty\(\$sections\)\) \{\s+\$output = w2agent_site_seed\('llms.txt'\);/,
    );
    expect(block).toContain("if ($output === '')");
  });

  it("keeps Cache-Control on every served endpoint", () => {
    expect(pluginPhp().match(/Cache-Control: public, max-age=3600/g)).toHaveLength(3);
  });
});

describe("generateWpPlugin — INSTALL.md", () => {
  const install = () =>
    generated().find((f) => f.filename === "wordpress/INSTALL.md")?.content ?? "";

  it("documents the cache, the seed rule, llms-full, and the limits it cannot fix", () => {
    const md = install();
    expect(md).toContain("/llms-full.txt");
    expect(md).toContain("crawl snapshot");
    expect(md).toContain("never built from post content");
    expect(md).toContain("for up to one hour");
    expect(md).toContain("only while the site has no");
    expect(md).toContain("w2agent_site_include_post");
    expect(md).toContain("/wp-content/plugins/w2agent-site/");
    expect(md).not.toContain("/wp-content/plugins/w2agent/");
    expect(md).not.toContain("The same items with their full text");
    expect(md).toContain("main site serves them");
    expect(md).toContain("plain permalinks");
    expect(md).toContain("origin-root");
    expect(md).not.toContain("falls back to these static files");
    expect(md).not.toContain("Queries all published posts");
  });
});
