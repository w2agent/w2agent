import { describe, expect, it } from "vitest";
import { wordpressAdapter } from "../src/adapters/wordpress/index.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";

const ctx = {
  pages: [],
  rawPages: [],
  metadata: { baseUrl: "https://example.com", wellKnown: {} },
  baseUrl: "https://example.com",
} as unknown as GenerateContext;

const core: GeneratedFile[] = [
  { filename: "llms.txt", content: "# x\n", size: 4 },
  { filename: "robots.txt", content: "User-agent: *\nAllow: /\n", size: 23 },
  { filename: "mcp-server/server.js", content: "//", size: 2 },
  { filename: "webmcp/webmcp.js", content: "var a = 1;", size: 10 },
];

const files = wordpressAdapter.generateIntegration(ctx, core);
const get = (name: string) => {
  const f = files.find((x) => x.filename === name);
  if (!f) throw new Error(`missing ${name}`);
  return f.content;
};

const plugin = get("wordpress/w2agent-plugin.php");
const hook = get("wordpress/w2agent-mcp-webhook.php");
const webmcp = get("wordpress/w2agent-webmcp.php");

function between(php: string, start: string, end: string): string {
  const from = php.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = php.indexOf(end, from);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return php.slice(from, to);
}

describe("WordPress WebMCP loading (WP-2)", () => {
  it("the main plugin requires both optional files from its own folder on the main site", () => {
    const block = between(
      plugin,
      "if (w2agent_site_serves_data_files()) {\n    foreach",
      "// ─── Admin",
    );
    expect(block).toContain("'w2agent-webmcp.php'");
    expect(block).toContain("'w2agent-mcp-webhook.php'");
    expect(block).toContain("file_exists(__DIR__ . '/' . $w2agent_site_extra)");
    expect(block).toContain("require_once __DIR__ . '/' . $w2agent_site_extra;");
  });

  it("the webmcp file has an ABSPATH guard and a correct header, and keeps its inline HTML", () => {
    expect(webmcp).toContain("if (!defined('ABSPATH')) exit;");
    expect(webmcp).toContain("Loaded by w2agent-plugin.php");
    expect(webmcp).not.toContain("functions.php");
    expect(webmcp).toContain("\n?>\n<script>\n");
    expect(webmcp).toContain("<?php\n}, 99);");
  });
});

describe("WordPress webhook (WP-9)", () => {
  it("sends nothing while the placeholders remain", () => {
    expect(hook).toContain("webhook/YOUR_SLUG");
    expect(hook).toContain(
      "if (strpos(W2AGENT_WEBHOOK_URL, 'YOUR' . '_SLUG') !== false || W2AGENT_WEBHOOK_TOKEN === 'YOUR' . '_WEBHOOK_TOKEN') return;",
    );
    const bail = hook.indexOf("'YOUR' . '_WEBHOOK_TOKEN') return;");
    expect(bail).toBeGreaterThan(-1);
    expect(bail).toBeLessThan(hook.indexOf("wp_remote_post"));
  });

  it("a global replace of the two placeholder values leaves the bail check working", () => {
    const edited = hook
      .replaceAll("YOUR_SLUG", "my-site")
      .replaceAll("YOUR_WEBHOOK_TOKEN", "my-token");
    expect(edited).toContain("webhook/my-site'");
    expect(edited).toContain("'YOUR' . '_SLUG'");
    expect(edited).toContain("=== 'YOUR' . '_WEBHOOK_TOKEN'");
  });

  it("notifies on transition when the old or new status is publish, not on save_post", () => {
    expect(hook).not.toContain("'save_post'");
    expect(hook).not.toContain("'delete_post'");
    expect(hook).toContain("add_action('transition_post_status'");
    expect(hook).toContain("if ($new_status !== 'publish' && $old_status !== 'publish') return;");
  });

  it("notifies on permanent delete only of a published post", () => {
    const del = between(hook, "add_action('before_delete_post'", "}, 10, 2);");
    expect(del).toContain("$post->post_status !== 'publish'");
    expect(hook).toContain("}, 10, 2);");
  });

  it("skips revisions and autosaves and unlisted types, with a viewable fallback", () => {
    expect(hook).toContain("wp_is_post_revision($post) || wp_is_post_autosave($post)");
    expect(hook).toContain("function_exists('w2agent_site_post_types')");
    expect(hook).toContain("in_array($post->post_type, w2agent_site_post_types(), true)");
    expect(hook).toContain("is_post_type_viewable($post->post_type)");
  });

  it("declares no named function and guards constants and hooks, so a pasted copy cannot clash", () => {
    expect(hook).not.toMatch(/^function /m);
    expect(hook).toContain("if (!defined('W2AGENT_WEBHOOK_URL')) define(");
    expect(hook).toContain("if (!defined('W2AGENT_WEBHOOK_TOKEN')) define(");
    expect(hook).toContain("if (!defined('W2AGENT_MCP_WEBHOOK_HOOKED')) {");
    expect(hook).toContain("if (!defined('ABSPATH')) exit;");
  });

  it("header says the plugin loads the file", () => {
    expect(hook).toContain("w2agent-plugin.php) loads this file");
  });
});

describe("WordPress llms.txt cache user context (security review)", () => {
  it("the generated plugin builds the cached text with no current user and restores it", () => {
    const gen = between(plugin, "function w2agent_site_generate_llms_txt()", "// ─── Serve");
    const set = gen.indexOf("wp_set_current_user(0);");
    const sections = gen.indexOf("w2agent_site_sections()");
    const store = gen.indexOf("set_transient(");
    expect(gen).toContain("$previous_user = get_current_user_id();");
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(sections);
    expect(gen).toContain("} finally {\n        wp_set_current_user($previous_user);");
    expect(gen.indexOf("wp_set_current_user($previous_user)")).toBeLessThan(store);
  });
});
