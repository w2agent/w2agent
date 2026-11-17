import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { astroAdapter } from "../src/adapters/astro/index.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";

const BASE = "https://example.com";
const ctx: GenerateContext = {
  pages: [],
  rawPages: [],
  metadata: { baseUrl: BASE, wellKnown: {} },
  baseUrl: BASE,
};
const coreFiles: GeneratedFile[] = [
  { filename: "llms.txt", content: "# x\n", size: 4 },
  { filename: "mcp-server/server.ts", content: "//", size: 2 },
];

let dir: string;
let files: GeneratedFile[];

function emitted(name: string): GeneratedFile {
  const f = files.find((x) => x.filename === name);
  if (!f) throw new Error(`missing ${name}`);
  return f;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "w2agent-astro-emit-"));
  files = astroAdapter.generateIntegration(ctx, coreFiles);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("emitted Astro .mjs files", () => {
  it("every emitted .mjs file parses", () => {
    const mjs = files.filter((f) => f.filename.endsWith(".mjs"));
    expect(mjs.map((f) => f.filename)).toEqual(
      expect.arrayContaining([
        "astro/w2agent-integration.mjs",
        "astro/w2agent-build.mjs",
        "astro/w2agent-mcp-webhook.mjs",
      ]),
    );
    for (const f of mjs) {
      const p = join(dir, f.filename.split("/").pop() as string);
      writeFileSync(p, f.content);
      expect(() => execFileSync(process.execPath, ["--check", p], { stdio: "pipe" })).not.toThrow();
    }
  });

  it("the MCP webhook integration reports the fetch error text", async () => {
    const p = join(dir, "w2agent-mcp-webhook.mjs");
    writeFileSync(p, emitted("astro/w2agent-mcp-webhook.mjs").content);
    const mod = await import(pathToFileURL(p).href);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect refused")));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const hooks = mod.default().hooks as Record<string, (a: unknown) => Promise<void>>;
    await hooks["astro:build:done"]({ logger });
    vi.unstubAllGlobals();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("connect refused");
  });

  it("the MCP webhook integration copes with a non-Error rejection", async () => {
    const p = join(dir, "w2agent-mcp-webhook2.mjs");
    writeFileSync(p, emitted("astro/w2agent-mcp-webhook.mjs").content);
    const mod = await import(pathToFileURL(p).href);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("plain failure"));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const hooks = mod.default().hooks as Record<string, (a: unknown) => Promise<void>>;
    await hooks["astro:build:done"]({ logger });
    vi.unstubAllGlobals();
    expect(logger.warn.mock.calls[0][0]).toContain("plain failure");
  });
});

describe("emitted astro/src/pages/llms.txt.ts endpoint", () => {
  async function load(): Promise<{ GET: () => Promise<Response> }> {
    const src = emitted("astro/src/pages/llms.txt.ts").content;
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const p = join(dir, `endpoint-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(p, js);
    return import(pathToFileURL(p).href);
  }

  it("does not embed the crawled site URL or a fallback body", () => {
    const src = emitted("astro/src/pages/llms.txt.ts").content;
    expect(src).not.toContain(BASE);
    expect(src).not.toContain("AI-ready content index");
  });

  it("is not prerendered, so a static build does not bake a 404 body into dist", () => {
    const src = emitted("astro/src/pages/llms.txt.ts").content;
    expect(src).toContain("export const prerender = false;");
  });

  it("answers 404 with no cache header when public/llms.txt is absent", async () => {
    const site = join(dir, "site");
    mkdirSync(site, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(site);
    const { GET } = await load();
    const res = await GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(await res.text()).not.toContain("AI-ready");
  });

  it("serves public/llms.txt when present", async () => {
    const site = join(dir, "site2");
    mkdirSync(join(site, "public"), { recursive: true });
    writeFileSync(join(site, "public", "llms.txt"), "# real\n");
    vi.spyOn(process, "cwd").mockReturnValue(site);
    const { GET } = await load();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage=3600");
    expect(await res.text()).toBe("# real\n");
  });
});

describe("emitted astro/INSTALL.md", () => {
  it("passes no siteUrl option and names no hybrid mode or fallback body", () => {
    const md = emitted("astro/INSTALL.md").content;
    expect(md).not.toContain("siteUrl");
    expect(md).not.toContain("hybrid");
    expect(md).not.toContain("Fallback generates");
    expect(md).toContain("w2agent()");
    expect(md).toContain("overwrite: true");
    expect(md).toContain("404");
  });
});
