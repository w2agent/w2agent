import vm from "node:vm";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { astroAdapter } from "../src/adapters/astro/index.js";
import { shopifyAdapter } from "../src/adapters/shopify/index.js";
import { wordpressAdapter } from "../src/adapters/wordpress/index.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";
import { generateWebMcp } from "../src/generate/webmcp.js";

const HOSTILE = [
  'Say "hi"',
  "C:\\path",
  "back`tick",
  "${x}",
  "</script><script>globalThis.pwned=1</script>",
  "</SCRIPT >",
  "<!--<script>",
  "<?php echo 'PWN'; ?>",
  "<?= 1 ?>",
  "<% x %>",
  "{{ shop.name }}",
  "{{- x -}}",
  "{% endraw %}",
  "{{%",
  "{{{",
  '";globalThis.pwned=1;//',
  "a\u2028b",
  "a\u2029b",
  "a&amp;b",
];

const BASE = "https://example.com";
const ACTION = `https://other.example/go?q=${HOSTILE.join("|")}`;

const fields = HOSTILE.map((h, i) => ({
  name: `f${i}:${h}`,
  type: "text",
  required: true,
  label: h,
}));
fields.push({
  name: "sel",
  type: "select",
  required: false,
  label: HOSTILE.join(" "),
  options: HOSTILE,
} as (typeof fields)[number]);

function makeCtx(): GenerateContext {
  return {
    pages: [
      {
        url: `${BASE}/page`,
        title: "Page",
        description: "",
        markdown: "",
        forms: [
          { action: ACTION, method: "POST", fields },
          { action: "/search", method: "GET", fields: [fields[0]] },
        ],
      },
    ],
    rawPages: [],
    metadata: { baseUrl: BASE, wellKnown: {} },
    baseUrl: BASE,
  };
}

const core = generateWebMcp(makeCtx());
const webmcpJs = core.find((f) => f.filename === "webmcp/webmcp.js")?.content ?? "";

interface Registered {
  name: string;
  description: string;
  inputSchema: {
    properties: Record<string, { description: string; enum?: string[] }>;
    required?: string[];
  };
  execute: (params: Record<string, string>) => Promise<unknown>;
}

async function runScript(codes: string[]) {
  const tools: Registered[] = [];
  const selectors: string[] = [];
  const assigned: Record<string, string> = {};
  const field = {
    set value(v: string) {
      assigned.last = v;
    },
  };
  const formStub = {
    querySelector(sel: string) {
      selectors.push(sel);
      return field;
    },
    submit() {},
  };
  const sandbox: Record<string, unknown> = {
    document: {
      modelContext: { registerTool: (t: Registered) => tools.push(t) },
      querySelector(sel: string) {
        selectors.push(sel);
        return formStub;
      },
    },
    CSS: { escape: (s: string) => s },
  };
  vm.createContext(sandbox);
  for (const code of codes) {
    try {
      vm.runInContext(code, sandbox);
    } catch {}
  }
  return { tools, selectors, sandbox };
}

async function expectRegistrationsRoundTrip(codes: string | string[]) {
  const { tools, selectors, sandbox } = await runScript(Array.isArray(codes) ? codes : [codes]);
  expect(sandbox.pwned).toBeUndefined();
  expect(tools).toHaveLength(2);
  const tool = tools[0];
  expect(tool.name).toBe("go");
  expect(Object.keys(tool.inputSchema.properties)).toEqual([...fields.map((f) => f.name)]);
  fields.slice(0, HOSTILE.length).forEach((f, i) => {
    expect(tool.inputSchema.properties[f.name].description).toBe(HOSTILE[i]);
  });
  expect(tool.inputSchema.properties.sel.description).toBe(HOSTILE.join(" "));
  expect(tool.inputSchema.properties.sel.enum).toEqual(HOSTILE);
  expect(tool.inputSchema.required).toEqual(fields.slice(0, HOSTILE.length).map((f) => f.name));

  const params: Record<string, string> = {};
  for (const f of fields) params[f.name] = "v";
  await tool.execute(params);
  expect(selectors[0]).toBe(`form[action=${ACTION}]`);
  expect(selectors.slice(1)).toEqual(fields.map((f) => `[name=${f.name}]`));
  await tools[1].execute({});
  expect(sandbox.pwned).toBeUndefined();
}

function hostScripts(markup: string): string[] {
  const $ = cheerio.load(markup);
  const texts = $("script")
    .toArray()
    .map((e) => $(e).text());
  const extra = $("*")
    .toArray()
    .map((e) => (e as unknown as { tagName: string }).tagName)
    .filter((t) => !["html", "head", "body", "script"].includes(t));
  return Object.assign(texts, { extra });
}

async function expectSingleSafeScript(markup: string) {
  const texts = hostScripts(markup);
  const { sandbox } = await runScript(texts);
  expect(sandbox.pwned).toBeUndefined();
  expect(texts).toHaveLength(1);
  expect((texts as unknown as { extra: string[] }).extra).toEqual([]);
  await expectRegistrationsRoundTrip(texts);
}

function adapterFile(
  adapter: { generateIntegration: (c: GenerateContext, f: GeneratedFile[]) => GeneratedFile[] },
  filename: string,
) {
  const files = adapter.generateIntegration(makeCtx(), core);
  const f = files.find((x) => x.filename === filename);
  if (!f) throw new Error(`missing ${filename}`);
  return f.content;
}

describe("webmcp.js with crawled data", () => {
  it("evaluates and round-trips every hostile value", async () => {
    await expectRegistrationsRoundTrip(webmcpJs);
  });

  it("contains no HTML, template or line-terminator metacharacters", () => {
    for (const bad of ["<", ">", "&", "{{", "{%", "\u2028", "\u2029"]) {
      expect(webmcpJs.includes(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("WordPress host (PHP inline HTML)", () => {
  const php = adapterFile(wordpressAdapter, "wordpress/w2agent-webmcp.php");
  const region = php.slice(php.indexOf("\n?>\n") + 3, php.lastIndexOf("<?php\n}"));

  it("inline HTML region has no PHP open tag", () => {
    expect(region).not.toMatch(/<\?/);
  });

  it("yields exactly one script that registers the exact values", async () => {
    await expectSingleSafeScript(region);
  });
});

describe("Shopify host (Liquid snippet)", () => {
  const liquid = adapterFile(shopifyAdapter, "shopify/snippets/w2agent-webmcp.liquid");
  const body = liquid.slice(liquid.indexOf("{% endcomment %}") + "{% endcomment %}".length);

  it("snippet body has no Liquid delimiters", () => {
    expect(body).not.toContain("{{");
    expect(body).not.toContain("{%");
  });

  it("yields exactly one script that registers the exact values", async () => {
    await expectSingleSafeScript(body);
  });
});

describe("Astro host (component script)", () => {
  const astro = adapterFile(astroAdapter, "astro/components/WebMcpScript.astro");
  const body = astro.slice(astro.indexOf("---", 3) + 3);

  it("yields exactly one script that registers the exact values", async () => {
    await expectSingleSafeScript(body);
  });
});

describe("declarative.html", () => {
  it("a hostile action cannot end the comment or create elements", () => {
    const hostile = "x:--><img src=x onerror=alert(1)>";
    const ctx = makeCtx();
    ctx.pages[0].forms = [
      { action: hostile, method: "POST", fields: [{ name: "q", type: "text", required: false }] },
    ];
    const files = generateWebMcp(ctx);
    const html = files.find((f) => f.filename === "webmcp/declarative.html")?.content ?? "";
    const $ = cheerio.load(html);
    expect($("img")).toHaveLength(0);
    const tags = $("*")
      .toArray()
      .map((e) => (e as unknown as { tagName: string }).tagName)
      .filter((t) => !["html", "head", "body", "form", "input", "textarea"].includes(t));
    expect(tags).toEqual([]);
    const comments = $("*")
      .contents()
      .toArray()
      .concat($.root().contents().toArray())
      .filter((n) => n.type === "comment")
      .map((n) => (n as unknown as { data: string }).data);
    expect(comments.some((c) => c.includes("Form: --&gt;&lt;img"))).toBe(true);
  });
});
