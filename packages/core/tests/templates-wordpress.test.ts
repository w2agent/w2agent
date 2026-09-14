import { describe, expect, it } from "vitest";
import { generateWpPlugin } from "../src/adapters/wordpress/templates.js";

const SAMPLE_LLMS = "# Test Site\n\n## Pages\n\n- [Home](https://example.com/): Welcome";
const SAMPLE_CARD = JSON.stringify({ name: "Test Site", url: "https://example.com" });
const SAMPLE_ROBOTS = "User-agent: GPTBot\nAllow: /\n";
const SITE_URL = "https://example.com";

function pluginPhp(): string {
  const files = generateWpPlugin(SAMPLE_LLMS, SAMPLE_CARD, SAMPLE_ROBOTS, SITE_URL);
  const plugin = files.find((f) => f.filename === "wordpress/w2agent-plugin.php");
  if (!plugin) throw new Error("w2agent-plugin.php not found in generated files");
  return plugin.content;
}

describe("generateWpPlugin — HTTP status codes", () => {
  it("sets http_response_code(200) for /llms.txt before content-type", () => {
    const php = pluginPhp();
    const llmsBlock = php.slice(php.indexOf("if ($uri === '/llms.txt')"));
    const codePos = llmsBlock.indexOf("http_response_code(200)");
    const ctPos = llmsBlock.indexOf("Content-Type: text/plain");
    expect(codePos).toBeGreaterThan(-1);
    expect(codePos).toBeLessThan(ctPos);
  });

  it("sets http_response_code(200) for /.well-known/agent-card.json before content-type", () => {
    const php = pluginPhp();
    const cardBlock = php.slice(php.indexOf("if ($uri === '/.well-known/agent-card.json'"));
    const codePos = cardBlock.indexOf("http_response_code(200)");
    const ctPos = cardBlock.indexOf("Content-Type: application/json");
    expect(codePos).toBeGreaterThan(-1);
    expect(codePos).toBeLessThan(ctPos);
  });
});

describe("generateWpPlugin — file structure", () => {
  it("returns all required files", () => {
    const files = generateWpPlugin(SAMPLE_LLMS, SAMPLE_CARD, SAMPLE_ROBOTS, SITE_URL);
    const names = files.map((f) => f.filename);
    expect(names).toContain("wordpress/w2agent-plugin.php");
    expect(names).toContain("wordpress/data/llms.txt");
    expect(names).toContain("wordpress/data/agent-card.json");
    expect(names).toContain("wordpress/data/robots-rules.txt");
    expect(names).toContain("wordpress/INSTALL.md");
  });

  it("embeds site URL in INSTALL.md", () => {
    const files = generateWpPlugin(SAMPLE_LLMS, SAMPLE_CARD, SAMPLE_ROBOTS, SITE_URL);
    const install = files.find((f) => f.filename === "wordpress/INSTALL.md");
    expect(install?.content).toContain(SITE_URL);
  });

  it("passes through llms.txt content to data file", () => {
    const files = generateWpPlugin(SAMPLE_LLMS, SAMPLE_CARD, SAMPLE_ROBOTS, SITE_URL);
    const llms = files.find((f) => f.filename === "wordpress/data/llms.txt");
    expect(llms?.content).toBe(SAMPLE_LLMS);
  });

  it("passes through agent-card content to data file", () => {
    const files = generateWpPlugin(SAMPLE_LLMS, SAMPLE_CARD, SAMPLE_ROBOTS, SITE_URL);
    const card = files.find((f) => f.filename === "wordpress/data/agent-card.json");
    expect(card?.content).toBe(SAMPLE_CARD);
  });
});

describe("generateWpPlugin — PHP plugin content", () => {
  it("uses template_redirect to intercept endpoints", () => {
    expect(pluginPhp()).toContain("add_action('template_redirect'");
  });

  it("uses parse_url for URI matching", () => {
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
    expect(php).not.toContain("'supportedInterfaces'");
    const cardBlock = php.slice(
      php.indexOf("if ($uri === '/.well-known/agent-card.json'"),
      php.indexOf("// ─── Discovery tags"),
    );
    expect(cardBlock).toContain("&& file_exists(W2AGENT_DATA_DIR . 'agent-card.json')");
    expect(cardBlock).toContain("readfile(W2AGENT_DATA_DIR . 'agent-card.json')");
  });

  it("without a generated agent card the plugin ships no agent-card data file", () => {
    const files = generateWpPlugin(SAMPLE_LLMS, undefined, SAMPLE_ROBOTS, SITE_URL);
    expect(files.map((f) => f.filename)).not.toContain("wordpress/data/agent-card.json");
  });
});
