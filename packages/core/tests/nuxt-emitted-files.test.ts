import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
import { createApp, createError, defineEventHandler, type EventHandler, toWebHandler } from "h3";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { nuxtAdapter } from "../src/adapters/nuxt/index.js";
import type { GenerateContext } from "../src/generate/types.js";

const require = createRequire(import.meta.url);

const BASE = "https://example.com";
const ctx: GenerateContext = {
  pages: [],
  rawPages: [],
  metadata: { baseUrl: BASE, wellKnown: {} },
  baseUrl: BASE,
};

const files = nuxtAdapter.generateIntegration(ctx, []);
const emitted = (name: string) => files.find((f) => f.filename === name)?.content ?? "";

function transpile(source: string) {
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  return out.outputText;
}

function run(source: string, requires: Record<string, unknown>) {
  const sandbox: Record<string, unknown> = {
    exports: {},
    TextDecoder,
    require: (id: string) => {
      if (id in requires) return requires[id];
      throw new Error(`unexpected require ${id}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(transpile(source), sandbox);
  return sandbox.exports as { default: unknown };
}

function makeStorage(items: Record<string, string | Uint8Array>) {
  const mounts: string[] = [];
  const useStorage = (base: string) => {
    mounts.push(base);
    return {
      hasItem: async (key: string) => key in items && base === "assets:w2agent",
      getItemRaw: async (key: string) => items[key],
    };
  };
  return { useStorage, mounts };
}

function loadRoute(name: string, items: Record<string, string | Uint8Array>) {
  const { useStorage, mounts } = makeStorage(items);
  const imports = {
    // defineCachedEventHandler is mapped to the plain handler: the cache layer is Nitro's
    defineCachedEventHandler: (handler: EventHandler) => defineEventHandler(handler),
    setResponseHeader: (
      event: { node: { res: { setHeader: (k: string, v: string) => void } } },
      k: string,
      v: string,
    ) => event.node.res.setHeader(k, v),
    useStorage,
  };
  const handler = run(emitted(name), { h3: { createError }, "#imports": imports })
    .default as EventHandler;
  const app = createApp();
  app.use(handler);
  return { web: toWebHandler(app), mounts };
}

const ROUTES = [
  { file: "nuxt/server/routes/llms.txt.ts", key: "llms.txt", type: "text/plain; charset=utf-8" },
  {
    file: "nuxt/server/routes/llms-full.txt.ts",
    key: "llms-full.txt",
    type: "text/plain; charset=utf-8",
  },
  { file: "nuxt/server/routes/index.md.ts", key: "llms.txt", type: "text/markdown; charset=utf-8" },
] as const;

describe("Nuxt emitted routes serve build-time content (NU-2), executed in real h3", () => {
  for (const r of ROUTES) {
    it(`${r.file}: present asset is served from the w2agent storage, bytes decoded`, async () => {
      const body = "# Café ☕ content\n";
      const { web, mounts } = loadRoute(r.file, { [r.key]: new TextEncoder().encode(body) });
      const res = await web(new Request(`${BASE}/x`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(r.type);
      expect(await res.text()).toBe(body);
      expect(mounts).toEqual(["assets:w2agent"]);
    });

    it(`${r.file}: a string payload is served as is`, async () => {
      const { web } = loadRoute(r.file, { [r.key]: "# plain\n" });
      const res = await web(new Request(`${BASE}/x`));
      expect(await res.text()).toBe("# plain\n");
    });

    it(`${r.file}: absent asset is a 404 with no cache header and no placeholder`, async () => {
      const { web } = loadRoute(r.file, {});
      const res = await web(new Request(`${BASE}/x`));
      expect(res.status).toBe(404);
      const cache = res.headers.get("cache-control") ?? "";
      expect(cache).not.toMatch(/max-?age|public/i);
      const text = await res.text();
      expect(text).not.toContain("AI-ready content index");
      expect(text).not.toContain("No content generated yet");
    });
  }

  it("no emitted route reads the filesystem or the working directory", () => {
    for (const r of ROUTES) {
      const src = emitted(r.file);
      expect(src).not.toContain("process.cwd");
      expect(src).not.toContain("node:fs");
      expect(src).not.toContain("Buffer");
      expect(src).not.toContain(BASE);
    }
  });
});

describe("Nuxt INSTALL.md and build script describe the build-time behaviour", () => {
  const md = emitted("nuxt/INSTALL.md");
  const script = emitted("nuxt/w2agent-build.mjs");

  it("INSTALL.md lists the module, states build-time serving and 404, drops the fallback claims", () => {
    expect(md).toContain("modules/w2agent.ts");
    expect(md).toMatch(/as they were when you built/);
    expect(md).toContain("404");
    expect(md).not.toMatch(/generates minimal|minimal fallback|Static fallback/);
  });

  it("the build-script warning no longer promises fallback content", () => {
    expect(script).not.toContain("fallback content");
    expect(script).toContain("as of the last build");
    expect(script).toContain("404");
  });
});

interface NitroConfig {
  serverAssets?: { baseName: string; dir: string; pattern?: string }[];
}

function runModule(dirPublic: string, srcDir: string): NitroConfig {
  const mod = run(emitted("nuxt/modules/w2agent.ts"), {
    "node:path": require("node:path"),
  }).default as (options: unknown, nuxt: unknown) => void;
  const hooks: Record<string, (c: NitroConfig) => void> = {};
  mod(
    {},
    {
      options: { dir: { public: dirPublic }, srcDir },
      hook: (n: string, f: (c: NitroConfig) => void) => {
        hooks[n] = f;
      },
    },
  );
  expect(Object.keys(hooks)).toEqual(["nitro:config"]);
  const config: NitroConfig = {};
  hooks["nitro:config"](config);
  return config;
}

describe("Nuxt emitted module (NU-2)", () => {
  it("is emitted with no package import", () => {
    const src = emitted("nuxt/modules/w2agent.ts");
    expect(src).not.toContain("@nuxt/kit");
    expect(src).not.toContain("@w2agent");
  });

  it("registers one scoped server asset on the public dir", () => {
    const config = runModule("/proj/public", "/proj");
    expect(config.serverAssets).toHaveLength(1);
    const [entry] = config.serverAssets ?? [];
    expect(entry.baseName).toBe("w2agent");
    expect(entry.dir).toBe("/proj/public");
  });

  it("resolves a relative public dir against srcDir and keeps existing assets", () => {
    const mod = runModule("public", join("/proj", "app"));
    expect(mod.serverAssets?.[0].dir).toBe(join("/proj", "app", "public"));
  });

  it("the pattern is a brace list of the four literal w2agent files, no wildcard", () => {
    const config = runModule("/proj/public", "/proj");
    const pattern = config.serverAssets?.[0].pattern ?? "";
    const inner = pattern.match(/^\{([^{}]*)\}$/)?.[1] ?? "";
    const names = inner.split(",");
    expect(names.sort()).toEqual(
      [".well-known/agent-card.json", "agent-card.json", "llms-full.txt", "llms.txt"].sort(),
    );
    expect(pattern).not.toMatch(/[*?[\]]/);
    for (const bad of ["secret.txt", "unrelated-marker.txt", "robots.txt", ".env"]) {
      expect(names).not.toContain(bad);
    }
  });
});
