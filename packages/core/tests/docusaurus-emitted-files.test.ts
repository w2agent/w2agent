import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docusaurusAdapter } from "../src/adapters/docusaurus/index.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";
import { generateWebMcp } from "../src/generate/webmcp.js";
import {
  EMPTY_PLUGINS,
  EXPECTED_LLMS_TXT,
  FORBIDDEN_FRAGMENTS,
  PLUGINS,
  SITE_CONFIG,
  TRAILING_PLUGINS,
  TRAILING_SLASH_CASES,
} from "./helpers/docusaurus-cases.js";

const BASE = "https://docs.example.com";
const ctx: GenerateContext = {
  pages: [
    {
      url: `${BASE}/search`,
      title: "Search",
      description: "",
      markdown: "",
      forms: [
        {
          action: "/search",
          method: "GET",
          fields: [{ name: "q", type: "text", required: true, label: "Query" }],
        },
      ],
    },
  ],
  rawPages: [],
  metadata: { baseUrl: BASE, wellKnown: {} },
  baseUrl: BASE,
};

const webmcp = generateWebMcp(ctx);
const coreFiles: GeneratedFile[] = [
  { filename: "llms.txt", content: "# Seed\n", size: 7 },
  { filename: "agent-card.json", content: '{"name":"card"}', size: 15 },
  { filename: "mcp-server/server.js", content: "// server", size: 9 },
  ...webmcp,
];
const files = docusaurusAdapter.generateIntegration(ctx, coreFiles);
const emitted = (name: string) => files.find((f) => f.filename === name)?.content ?? "";

const require = createRequire(import.meta.url);

type PostBuild = (props: {
  siteConfig: typeof SITE_CONFIG;
  outDir: string;
  plugins: unknown[];
}) => Promise<void>;

describe("emitted Docusaurus files parse", () => {
  const js = files.filter((f) => f.filename.endsWith(".js"));

  it("emits the plugin, the webhook plugin and the WebMCP module", () => {
    expect(js.map((f) => f.filename).sort()).toEqual([
      "docusaurus/w2agent-mcp-webhook-plugin.js",
      "docusaurus/w2agent-plugin.js",
      "docusaurus/w2agent-webmcp-module.js",
    ]);
  });

  it.each(js.map((f) => f.filename))("%s parses as a script", (name) => {
    expect(() => new vm.Script(emitted(name), { filename: name })).not.toThrow();
  });
});

describe("emitted Docusaurus files carry no template placeholder words", () => {
  it("includes the WebMCP module in the checked set", () => {
    expect(files.some((f) => f.filename === "docusaurus/w2agent-webmcp-module.js")).toBe(true);
  });

  it.each(
    files.map((f) => f.filename),
  )("%s has no undefined substring (the conformance check)", (name) => {
    expect(emitted(name)).not.toContain("undefined");
  });
});

describe("emitted w2agent-plugin.js", () => {
  let dir: string;
  let siteDir: string;
  let outDir: string;
  let logs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-docu-emitted-"));
    siteDir = join(dir, "site");
    outDir = join(dir, "build");
    mkdirSync(siteDir);
    mkdirSync(outDir);
    writeFileSync(join(dir, "w2agent-plugin.cjs"), emitted("docusaurus/w2agent-plugin.js"));
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function load(options?: Record<string, unknown>, siteConfig: object = SITE_CONFIG) {
    const factory = require(join(dir, "w2agent-plugin.cjs"));
    const plugin = factory({ siteDir, siteConfig }, options);
    return {
      postBuild: (plugins: unknown[]) =>
        (plugin.postBuild as PostBuild)({
          siteConfig: siteConfig as typeof SITE_CONFIG,
          outDir,
          plugins,
        }),
    };
  }

  const llms = () => readFileSync(join(outDir, "llms.txt"), "utf-8");

  it("builds llms.txt from the loaded docs content", async () => {
    await load().postBuild(PLUGINS);
    expect(llms()).toBe(EXPECTED_LLMS_TXT);
  });

  it("lists no unlisted, draft, old-version or non-docs entries", async () => {
    await load().postBuild(PLUGINS);
    for (const fragment of FORBIDDEN_FRAGMENTS) expect(llms()).not.toContain(fragment);
  });

  it("keeps an existing static/llms.txt and logs one line", async () => {
    mkdirSync(join(siteDir, "static"));
    writeFileSync(join(siteDir, "static", "llms.txt"), "# crawled\n");
    await load().postBuild(PLUGINS);
    expect(() => readFileSync(join(outDir, "llms.txt"))).toThrow();
    expect(logs.filter((l) => l.includes("Keeping existing static/llms.txt"))).toHaveLength(1);
  });

  it("keeps a static llms.txt found in a custom staticDirectories entry", async () => {
    mkdirSync(join(siteDir, "assets"));
    writeFileSync(join(siteDir, "assets", "llms.txt"), "# crawled\n");
    await load({}, { ...SITE_CONFIG, staticDirectories: ["assets"] }).postBuild(PLUGINS);
    expect(() => readFileSync(join(outDir, "llms.txt"))).toThrow();
  });

  it("overwrite: true replaces the static file with the generated one", async () => {
    mkdirSync(join(siteDir, "static"));
    writeFileSync(join(siteDir, "static", "llms.txt"), "# crawled\n");
    await load({ overwrite: true }).postBuild(PLUGINS);
    expect(llms()).toBe(EXPECTED_LLMS_TXT);
  });

  it('overwrite: "true" (not boolean true) keeps the static file', async () => {
    mkdirSync(join(siteDir, "static"));
    writeFileSync(join(siteDir, "static", "llms.txt"), "# crawled\n");
    await load({ overwrite: "true" }).postBuild(PLUGINS);
    expect(() => readFileSync(join(outDir, "llms.txt"))).toThrow();
  });

  it("names the kept file relative to the site dir in the log", async () => {
    mkdirSync(join(siteDir, "assets"));
    writeFileSync(join(siteDir, "assets", "llms.txt"), "# crawled\n");
    await load({}, { ...SITE_CONFIG, staticDirectories: ["assets"] }).postBuild(PLUGINS);
    expect(logs.some((l) => l.includes("Keeping existing assets/llms.txt"))).toBe(true);
  });

  it.each(TRAILING_SLASH_CASES)("follows trailingSlash: $trailingSlash", async (c) => {
    await load({}, { ...SITE_CONFIG, trailingSlash: c.trailingSlash }).postBuild(TRAILING_PLUGINS);
    const links = [...llms().matchAll(/\]\(https:\/\/docs\.example\.com([^)]*)\)/g)].map(
      (m) => m[1],
    );
    expect(links).toEqual(c.links);
  });

  it("writes nothing when there are no listable docs", async () => {
    await load().postBuild(EMPTY_PLUGINS);
    expect(() => readFileSync(join(outDir, "llms.txt"))).toThrow();
    await load().postBuild([]);
    expect(() => readFileSync(join(outDir, "llms.txt"))).toThrow();
  });

  it("keeps each title and description on one line", async () => {
    await load().postBuild(PLUGINS);
    const lines = llms().split("\n");
    expect(lines).toContain(
      "- [Setup Guide](https://docs.example.com/proj/guides/setup): Install the thing.",
    );
    expect(lines.filter((l) => l.startsWith("- ["))).toHaveLength(4);
  });

  it("copies the agent card from the site's static dir", async () => {
    mkdirSync(join(siteDir, "static", ".well-known"), { recursive: true });
    writeFileSync(join(siteDir, "static", ".well-known", "agent-card.json"), '{"name":"card"}');
    await load().postBuild(PLUGINS);
    expect(readFileSync(join(outDir, ".well-known", "agent-card.json"), "utf-8")).toBe(
      '{"name":"card"}',
    );
  });

  it("has no npm dependency and no raw site URL fallback", () => {
    const src = emitted("docusaurus/w2agent-plugin.js");
    const required = [...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(required.sort()).toEqual(["fs", "path"]);
    expect(src).not.toContain(BASE);
  });
});

describe("emitted w2agent-webmcp-module.js", () => {
  const src = emitted("docusaurus/w2agent-webmcp-module.js");

  it("documents the real wiring", () => {
    expect(src).toContain('clientModules: ["./w2agent-webmcp-module.js"]');
  });

  it("does nothing and does not throw during the server render (no window, no document)", () => {
    const tools: unknown[] = [];
    const sandbox: Record<string, unknown> = {
      navigator: { modelContext: { registerTool: (t: unknown) => tools.push(t) } },
    };
    vm.createContext(sandbox);
    expect(() => vm.runInContext(src, sandbox)).not.toThrow();
    expect(tools).toEqual([]);
  });

  it("does not run with only one of window and document defined", () => {
    const doc = { modelContext: { registerTool: () => {} } };
    for (const globals of [{ window: {} }, { document: doc }]) {
      const sandbox: Record<string, unknown> = { navigator: {}, ...globals };
      vm.createContext(sandbox);
      expect(() => vm.runInContext(src, sandbox)).not.toThrow();
    }
  });

  it("registers the tools in a browser", () => {
    const tools: { name: string }[] = [];
    const doc = { modelContext: { registerTool: (t: { name: string }) => tools.push(t) } };
    const sandbox: Record<string, unknown> = {
      document: doc,
      window: { document: doc },
      navigator: {},
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    expect(tools.length).toBeGreaterThan(0);
  });
});
