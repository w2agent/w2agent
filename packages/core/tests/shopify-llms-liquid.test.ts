import { Liquid } from "liquidjs";
import { describe, expect, it } from "vitest";
import { shopifyAdapter } from "../src/adapters/shopify/index.js";
import { shopifyLlmsTxtSuffix } from "../src/adapters/shopify/templates.js";
import { generateLlmsTxt } from "../src/generate/llms-txt.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";

const SITE = "https://shop.example/some/path?x=1";
const TEMPLATE = "shopify/templates/llms.txt.liquid";

const HOSTILE = [
  "{{ shop.name }}",
  "{%",
  "{% endraw %}",
  "{%- if x -%}",
  "{{-",
  "{% comment %}",
  "{% liquid echo 1 %}",
  "{% # x %}",
  "{{{",
  "{{ unterminated",
  "stray }} and %} here",
  "{{ '{' }}",
  "{% raw %}{{ a }}{% endraw %}",
  "{{ request.page_type }} {{ agents.store_url }}",
  "{#",
  "a { b",
];

function ctx(): GenerateContext {
  return {
    pages: [],
    rawPages: [],
    metadata: {} as unknown as GenerateContext["metadata"],
    baseUrl: SITE,
  };
}

function emitted(llmsTxt: string): string {
  const core: GeneratedFile[] = [{ filename: "llms.txt", content: llmsTxt, size: llmsTxt.length }];
  const file = shopifyAdapter.generateIntegration(ctx(), core).find((f) => f.filename === TEMPLATE);
  if (!file) throw new Error("template not emitted");
  return file.content;
}

const engine = new Liquid({ strictVariables: true, strictFilters: true });

async function renderRestricted(template: string): Promise<string> {
  return engine.parseAndRender(template, { request: {}, agents: {} });
}

describe("emitted templates/llms.txt.liquid", () => {
  it("renders to exactly the llms.txt bytes plus the trusted suffix for hostile content", async () => {
    for (const hostile of HOSTILE) {
      const cases = [
        hostile,
        `# ${hostile}\n\n> ${hostile}\n\n## S\n\n- [${hostile}](https://shop.example/a): ${hostile}\n`,
        `# Shop\n\n- [x](https://shop.example/${hostile.replace(/\s/g, "")})\n`,
        `# Shop\n${hostile}`,
        `# Shop\n\ntrailing {`,
      ];
      for (const llms of cases) {
        const out = await renderRestricted(emitted(llms));
        expect(out).toBe(llms + shopifyLlmsTxtSuffix(SITE));
      }
    }
  });

  it("renders every hostile line from one document", async () => {
    const llms = `# Shop\n\n${HOSTILE.map((h) => `- ${h}`).join("\n")}\n`;
    expect(await renderRestricted(emitted(llms))).toBe(llms + shopifyLlmsTxtSuffix(SITE));
  });

  it("survives a hostile title that goes through generateLlmsTxt", async () => {
    const llms = generateLlmsTxt(
      [
        {
          url: "https://shop.example/products/a",
          title: "{{ shop.name }} {% endraw %} {%- x -%}",
          markdown: "{% liquid echo 1 %} body",
          metadata: { description: "{{{ {{- {" },
        } as unknown as Parameters<typeof generateLlmsTxt>[0][number],
      ],
      { siteName: "{{ shop.name }}", siteDescription: "{% comment %} {" },
    );
    expect(await renderRestricted(emitted(llms))).toBe(llms + shopifyLlmsTxtSuffix(SITE));
  });

  it("the suffix starts with a newline and links Shopify's managed agent file on the crawled origin", () => {
    const suffix = shopifyLlmsTxtSuffix(SITE);
    expect(suffix.startsWith("\n")).toBe(true);
    expect(suffix).toContain("(https://shop.example/agents.md)");
    expect(suffix).not.toMatch(/\{\{|\{%/);
  });

  it("keeps a hostile origin inside the link target", () => {
    const suffix = shopifyLlmsTxtSuffix("https://a)b.com/");
    expect(suffix).not.toContain("a)b");
    expect(suffix).toMatch(/\]\(https:\/\/a%29b\.com\/agents\.md\)/);
  });

  it("references no Liquid object other than through escapes", () => {
    const tpl = emitted("# Shop\n\n> {{ shop.name }}\n");
    const tags = tpl.match(/\{\{[^}]*\}\}|\{%[^%]*%\}/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toBe("{{ '{' }}");
  });

  it("is not emitted under data/ and no Page instruction remains", () => {
    const files = shopifyAdapter.generateIntegration(ctx(), [
      { filename: "llms.txt", content: "# Shop\n", size: 7 },
    ]);
    const names = files.map((f) => f.filename);
    expect(names).toContain(TEMPLATE);
    expect(names).not.toContain("shopify/data/llms.txt");
    const install = files.find((f) => f.filename === "shopify/INSTALL.md")?.content ?? "";
    expect(install).not.toContain("pages/llms-txt");
    expect(install).not.toContain("Add page");
    expect(install).not.toContain("doesn't support serving arbitrary files");
    const head = files.find((f) => f.filename === "shopify/snippets/w2agent-head.liquid");
    expect(head?.content).toContain('href="/llms.txt"');
    expect(head?.content).not.toContain("/pages/llms-txt");
  });
});

describe("emitted Shopify INSTALL.md", () => {
  function install(core: string[]): string {
    const coreFiles: GeneratedFile[] = [
      { filename: "llms.txt", content: "# Shop\n", size: 7 },
      ...core.map((filename) => ({ filename, content: "x", size: 1 })),
    ];
    return (
      shopifyAdapter
        .generateIntegration(ctx(), coreFiles)
        .find((f) => f.filename === "shopify/INSTALL.md")?.content ?? ""
    );
  }

  it("covers the managed default, the override, the push and no --live or --publish", () => {
    const md = install([]);
    expect(md).toContain("Shopify already serves `/llms.txt`");
    expect(md).toContain("`/agents.md` is not affected");
    expect(md).toContain("shopify theme push --theme");
    expect(md).toContain("--only templates/llms.txt.liquid");
    expect(md).toContain("--only layout/theme.liquid");
    expect(md).toContain("Duplicate your live theme");
    expect(md).not.toContain("Go to **Online Store → Themes → Edit Code**\n2. Open `layout");
    expect(md).not.toMatch(/--live|--publish/);
  });

  it("adds the WebMCP render step and file reference only when the snippet is generated", () => {
    const without = install([]);
    expect(without).not.toContain("w2agent-webmcp");
    const withWebmcp = install(["webmcp/webmcp.js"]);
    expect(withWebmcp).toContain("{% render 'w2agent-webmcp' %}");
    expect(withWebmcp).toContain("--only snippets/w2agent-webmcp.liquid");
  });

  it("lists the webhook file only when it is generated", () => {
    expect(install([])).not.toContain("W2AGENT-MCP-WEBHOOK.md");
    expect(install(["mcp-server/server.ts"])).toContain("W2AGENT-MCP-WEBHOOK.md");
  });
});
