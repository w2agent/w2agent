import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

describe("emitted w2agent-integration.mjs against a project with public/llms.txt", () => {
  type Hook = (a: unknown) => Promise<void> | void;
  let site: string;
  let dist: string;
  let callLog: string;
  let originalPath: string | undefined;
  let counter = 0;

  beforeEach(() => {
    site = join(dir, "site");
    dist = join(site, "dist");
    callLog = join(dir, "npx-calls.log");
    mkdirSync(dist, { recursive: true });
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, "npx");
    writeFileSync(
      fake,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const val = (flag) => args[args.indexOf(flag) + 1];
const out = val("--output");
const formats = (val("--format") || "").split(",");
fs.appendFileSync(${JSON.stringify(callLog)}, args.join(" ") + "\\n");
if (formats.includes("llms-txt")) fs.writeFileSync(path.join(out, "llms.txt"), "GENERATED-LLMS\\n");
if (formats.includes("full")) fs.writeFileSync(path.join(out, "llms-full.txt"), "GENERATED-FULL\\n");
`,
    );
    chmodSync(fake, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  async function plugin(options?: { overwrite?: boolean | string[] }) {
    const p = join(dir, `integration-${counter++}.mjs`);
    writeFileSync(p, emitted("astro/w2agent-integration.mjs").content);
    const mod = await import(pathToFileURL(p).href);
    const hooks = mod.default(options).hooks as Record<string, Hook>;
    const logger = { info: vi.fn(), warn: vi.fn() };
    return {
      logger,
      async build(publicDir?: URL | string) {
        if (publicDir !== undefined) {
          await hooks["astro:config:done"]?.({
            config: { root: pathToFileURL(`${site}/`), publicDir },
          });
        }
        await hooks["astro:build:done"]({ dir: pathToFileURL(`${dist}/`), logger });
      },
    };
  }

  function put(path: string, content: string) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }

  const publicUrl = () => pathToFileURL(`${join(site, "public")}/`);
  const calls = () =>
    existsSync(callLog) ? readFileSync(callLog, "utf-8").trim().split("\n") : [];
  const infos = (logger: { info: ReturnType<typeof vi.fn> }) =>
    logger.info.mock.calls.map((c) => String(c[0]));

  it("generates llms.txt and llms-full.txt when the project has no public/llms.txt", async () => {
    const { logger, build } = await plugin();
    await build(publicUrl());
    expect(readFileSync(join(dist, "llms.txt"), "utf-8")).toBe("GENERATED-LLMS\n");
    expect(readFileSync(join(dist, "llms-full.txt"), "utf-8")).toBe("GENERATED-FULL\n");
    expect(calls()[0]).toContain("--format llms-txt,full");
    expect(infos(logger).some((m) => m.includes("Keeping"))).toBe(false);
  });

  it("keeps the build's llms.txt copied from public/, still writes llms-full.txt, logs one keep line for it", async () => {
    put(join(site, "public", "llms.txt"), "OWNER\n");
    put(join(dist, "llms.txt"), "OWNER\n");
    const { logger, build } = await plugin();
    await build(publicUrl());
    expect(readFileSync(join(dist, "llms.txt"), "utf-8")).toBe("OWNER\n");
    expect(readFileSync(join(dist, "llms-full.txt"), "utf-8")).toBe("GENERATED-FULL\n");
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatch(/--format full(\s|$)/);
    const keeps = infos(logger).filter((m) => m.includes("Keeping"));
    expect(keeps).toHaveLength(1);
    expect(keeps[0]).toContain("public/llms.txt");
  });

  const matrix: [string, boolean | string[] | undefined, boolean, boolean, boolean, boolean][] = [
    ["plain", undefined, false, false, false, false],
    ["plain", undefined, true, false, true, false],
    ["plain", undefined, false, true, false, true],
    ["plain", undefined, true, true, true, true],
    ["overwrite: true", true, false, false, false, false],
    ["overwrite: true", true, true, false, false, false],
    ["overwrite: true", true, false, true, false, false],
    ["overwrite: true", true, true, true, false, false],
    ['overwrite: ["llms-full.txt"]', ["llms-full.txt"], false, false, false, false],
    ['overwrite: ["llms-full.txt"]', ["llms-full.txt"], true, false, true, false],
    ['overwrite: ["llms-full.txt"]', ["llms-full.txt"], false, true, false, false],
    ['overwrite: ["llms-full.txt"]', ["llms-full.txt"], true, true, true, false],
    ['overwrite: ["llms.txt"]', ["llms.txt"], false, true, false, true],
    ['overwrite: ["llms.txt"]', ["llms.txt"], true, true, false, true],
  ];

  it.each(
    matrix,
  )("%s, %j, owner llms.txt %s, owner llms-full.txt %s", async (_label, overwrite, ownerTxt, ownerFull, keepTxt, keepFull) => {
    if (ownerTxt) {
      put(join(site, "public", "llms.txt"), "OWNER\n");
      put(join(dist, "llms.txt"), "OWNER\n");
    }
    if (ownerFull) {
      put(join(site, "public", "llms-full.txt"), "OWNER\n");
      put(join(dist, "llms-full.txt"), "OWNER\n");
    }
    const { logger, build } = await plugin(overwrite === undefined ? undefined : { overwrite });
    await build(publicUrl());
    const read = (name: string) =>
      existsSync(join(dist, name)) ? readFileSync(join(dist, name), "utf-8") : null;
    expect(read("llms.txt")).toBe(keepTxt ? "OWNER\n" : "GENERATED-LLMS\n");
    expect(read("llms-full.txt")).toBe(keepFull ? "OWNER\n" : "GENERATED-FULL\n");
    const keeps = infos(logger).filter((m) => m.includes("Keeping"));
    expect(keeps).toHaveLength(Number(keepTxt) + Number(keepFull));
    expect(keeps.some((m) => m.includes("public/llms.txt"))).toBe(keepTxt);
    expect(keeps.some((m) => m.includes("public/llms-full.txt"))).toBe(keepFull);
    if (keepTxt && keepFull) {
      expect(calls()).toHaveLength(0);
    } else {
      expect(calls()).toHaveLength(1);
      const fmt = keepTxt ? "full" : keepFull ? "llms-txt" : "llms-txt,full";
      expect(calls()[0]).toContain(`--format ${fmt} `);
    }
  });

  it("ignores unknown names in an overwrite list", async () => {
    put(join(site, "public", "llms.txt"), "OWNER\n");
    put(join(dist, "llms.txt"), "OWNER\n");
    const { build } = await plugin({ overwrite: ["robots.txt"] });
    await build(publicUrl());
    expect(readFileSync(join(dist, "llms.txt"), "utf-8")).toBe("OWNER\n");
  });

  it("regenerates llms.txt over public/llms.txt when called with overwrite: true", async () => {
    put(join(site, "public", "llms.txt"), "OWNER\n");
    put(join(dist, "llms.txt"), "OWNER\n");
    const { logger, build } = await plugin({ overwrite: true });
    await build(publicUrl());
    expect(readFileSync(join(dist, "llms.txt"), "utf-8")).toBe("GENERATED-LLMS\n");
    expect(readFileSync(join(dist, "llms-full.txt"), "utf-8")).toBe("GENERATED-FULL\n");
    expect(calls()[0]).toContain("--format llms-txt,full");
    expect(infos(logger).some((m) => m.includes("Keeping"))).toBe(false);
  });

  it("treats only overwrite === true or an array as overwrite", async () => {
    put(join(site, "public", "llms.txt"), "OWNER\n");
    put(join(dist, "llms.txt"), "OWNER\n");
    const { build } = await plugin({ overwrite: "yes" as unknown as boolean });
    await build(publicUrl());
    expect(readFileSync(join(dist, "llms.txt"), "utf-8")).toBe("OWNER\n");
  });

  it("reads publicDir from the config, as a URL or a string", async () => {
    put(join(site, "assets", "llms.txt"), "OWNER\n");
    put(join(dist, "llms.txt"), "OWNER\n");
    const viaUrl = await plugin();
    await viaUrl.build(pathToFileURL(`${join(site, "assets")}/`));
    expect(readFileSync(join(dist, "llms.txt"), "utf-8")).toBe("OWNER\n");
    expect(infos(viaUrl.logger).find((m) => m.includes("Keeping"))).toContain("assets/llms.txt");

    const viaString = await plugin();
    await viaString.build(join(site, "assets"));
    expect(readFileSync(join(dist, "llms.txt"), "utf-8")).toBe("OWNER\n");
    expect(viaString.logger.info.mock.calls.some((c) => String(c[0]).includes("Keeping"))).toBe(
      true,
    );
  });

  it("ignores a public/llms.txt when the configured publicDir is elsewhere", async () => {
    put(join(site, "public", "llms.txt"), "OWNER\n");
    const { build } = await plugin();
    await build(pathToFileURL(`${join(site, "assets")}/`));
    expect(readFileSync(join(dist, "llms.txt"), "utf-8")).toBe("GENERATED-LLMS\n");
  });

  it("defaults to public/ under the working directory when no config hook ran", async () => {
    put(join(site, "public", "llms.txt"), "OWNER\n");
    put(join(dist, "llms.txt"), "OWNER\n");
    vi.spyOn(process, "cwd").mockReturnValue(site);
    const { build } = await plugin();
    await build();
    expect(readFileSync(join(dist, "llms.txt"), "utf-8")).toBe("OWNER\n");
  });

  describe("w2agent-build.mjs", () => {
    function script(args: string[]) {
      const p = join(dir, "w2agent-build.mjs");
      writeFileSync(p, emitted("astro/w2agent-build.mjs").content);
      return execFileSync(process.execPath, [p, ...args], {
        cwd: site,
        env: { ...process.env, SITE_URL: BASE },
        encoding: "utf-8",
        stdio: "pipe",
      });
    }
    const pub = (name: string) => join(site, "public", name);
    const read = (name: string) =>
      existsSync(pub(name)) ? readFileSync(pub(name), "utf-8") : null;
    const seedOwner = (txt: boolean, full: boolean) => {
      mkdirSync(join(site, "public"), { recursive: true });
      if (txt) writeFileSync(pub("llms.txt"), "OWNER\n");
      if (full) writeFileSync(pub("llms-full.txt"), "OWNER\n");
    };

    const scriptMatrix: [string[], boolean, boolean, boolean, boolean][] = [
      [[], false, false, false, false],
      [[], true, false, true, false],
      [[], false, true, false, true],
      [[], true, true, true, true],
      [["--overwrite"], false, false, false, false],
      [["--overwrite"], true, false, false, false],
      [["--overwrite"], false, true, false, false],
      [["--overwrite"], true, true, false, false],
      [["--overwrite=llms-full.txt"], false, false, false, false],
      [["--overwrite=llms-full.txt"], true, false, true, false],
      [["--overwrite=llms-full.txt"], false, true, false, false],
      [["--overwrite=llms-full.txt"], true, true, true, false],
      [["--overwrite=llms.txt,llms-full.txt"], true, true, false, false],
      [["--overwrite=llms.txt"], true, true, false, true],
    ];

    it.each(
      scriptMatrix,
    )("args %j, owner llms.txt %s, owner llms-full.txt %s: keeps llms.txt %s, keeps llms-full.txt %s", (args, ownerTxt, ownerFull, keepTxt, keepFull) => {
      seedOwner(ownerTxt, ownerFull);
      const out = script(args);
      expect(read("llms.txt")).toBe(keepTxt ? "OWNER\n" : "GENERATED-LLMS\n");
      expect(read("llms-full.txt")).toBe(keepFull ? "OWNER\n" : "GENERATED-FULL\n");
      expect(out.split("Keeping existing").length - 1).toBe(Number(keepTxt) + Number(keepFull));
      if (keepTxt && keepFull) {
        expect(calls()).toHaveLength(0);
      } else {
        expect(calls()).toHaveLength(1);
        const fmt = keepTxt ? "full" : keepFull ? "llms-txt" : "llms-txt,full";
        expect(calls()[0]).toContain(`--format ${fmt} `);
        expect(calls()[0]).toContain("--output ./public/");
      }
    });

    it("run twice: --overwrite refreshes the files it wrote, a plain run keeps them", () => {
      seedOwner(false, false);
      script(["--overwrite"]);
      writeFileSync(pub("llms.txt"), "STALE\n");
      writeFileSync(pub("llms-full.txt"), "STALE\n");
      script(["--overwrite"]);
      expect(read("llms.txt")).toBe("GENERATED-LLMS\n");
      expect(read("llms-full.txt")).toBe("GENERATED-FULL\n");
      writeFileSync(pub("llms.txt"), "STALE\n");
      writeFileSync(pub("llms-full.txt"), "STALE\n");
      const before = calls().length;
      script([]);
      expect(read("llms.txt")).toBe("STALE\n");
      expect(read("llms-full.txt")).toBe("STALE\n");
      expect(calls()).toHaveLength(before);
    });

    it("a plain first run writes both missing files, and a second plain run keeps them", () => {
      seedOwner(false, false);
      script([]);
      expect(read("llms.txt")).toBe("GENERATED-LLMS\n");
      writeFileSync(pub("llms.txt"), "STALE\n");
      script([]);
      expect(read("llms.txt")).toBe("STALE\n");
    });
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

  it("says the endpoints need an adapter and that a kept public/llms.txt needs overwrite: true", () => {
    const md = emitted("astro/INSTALL.md").content;
    expect(md).toContain("needs an adapter");
    expect(md).toContain("NoAdapterInstalled");
    expect(md).toContain("w2agent({ overwrite: true })");
    const src = emitted("astro/src/pages/llms.txt.ts").content;
    expect(src).toContain("needs an adapter");
    expect(src).toContain("export const prerender = false;");
  });

  it("describes the per-file keep for the integration and the prebuild script", () => {
    const md = emitted("astro/INSTALL.md").content;
    expect(md).not.toContain("do not use it when you write `public/llms.txt` by hand");
    expect(md).not.toContain("replaces `public/llms.txt` and `public/llms-full.txt` on every run");
    expect(md).toContain('w2agent({ overwrite: ["llms-full.txt"] })');
    expect(md).toContain('w2agent({ overwrite: ["llms.txt"] })');
    expect(md).toContain('"prebuild": "node w2agent-build.mjs --overwrite"');
    expect(md).toContain("--overwrite=llms-full.txt");
    expect(md).toContain("writes only the missing ones");
    const integration = emitted("astro/w2agent-integration.mjs").content;
    expect(integration).toContain('w2agent({ overwrite: ["llms-full.txt"] })');
    const script = emitted("astro/w2agent-build.mjs").content;
    expect(script).toContain("--overwrite=<names>");
  });

  it("manual step 2 passes overwrite: true after the step 1 seed copy and the diagram does not promise llms.txt", () => {
    const md = emitted("astro/INSTALL.md").content;
    const step2 = md.slice(
      md.indexOf("### 2. Add build integration"),
      md.indexOf("### Alternative: prebuild script"),
    );
    const config = step2.match(/```js\n([\s\S]*?)```/)?.[1] ?? "";
    expect(config).toContain("integrations: [w2agent({ overwrite: true })]");
    expect(config).not.toContain("w2agent()");
    expect(step2).toMatch(/hand-written `public\/llms\.txt`[^.]*plain `w2agent\(\)`/);
    const diagram = md.slice(md.indexOf("Build time:"), md.indexOf("Runtime (static):"));
    expect(diagram).not.toMatch(/Writes llms\.txt, llms-full\.txt/);
    expect(diagram).toContain("llms-full.txt");
    expect(diagram).toContain("overwrite");
  });
});
