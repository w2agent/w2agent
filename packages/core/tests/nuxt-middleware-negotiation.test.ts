import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createApp, defineEventHandler, type EventHandler, toWebHandler } from "h3";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { nuxtAdapter } from "../src/adapters/nuxt/index.js";
import { HOME_VARIANT_SOURCE } from "../src/adapters/shared/accept-negotiation.js";
import type { GenerateContext } from "../src/generate/types.js";
import { ACCEPT_CASES } from "./helpers/accept-cases.js";

const require = createRequire(import.meta.url);

const BASE = "https://example.com";
const ctx: GenerateContext = {
  pages: [],
  rawPages: [],
  metadata: { baseUrl: BASE, wellKnown: {} },
  baseUrl: BASE,
};

const emitted = nuxtAdapter
  .generateIntegration(ctx, [])
  .find((f) => f.filename === "nuxt/server/middleware/content-negotiation.ts")?.content;

function loadMiddleware(source: string): EventHandler {
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  const sandbox: Record<string, unknown> = {
    exports: {},
    require: (id: string) => {
      if (id === "h3") return require("h3");
      throw new Error(`unexpected require ${id}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(out.outputText, sandbox);
  return (sandbox.exports as { default: EventHandler }).default;
}

const TARGETS = { markdown: "/index.md", plain: "/llms.txt" } as const;

describe("Nuxt middleware Accept negotiation (NU-4), emitted file in real h3", () => {
  it("is emitted", () => {
    expect(emitted).toBeDefined();
  });

  const app = createApp();
  app.use(loadMiddleware(emitted ?? ""));
  app.use(defineEventHandler(() => "<!doctype html><html><body>page</body></html>"));
  const web = toWebHandler(app);

  for (const c of ACCEPT_CASES) {
    it(`${c.name} -> ${c.branch}`, async () => {
      const headers: Record<string, string> = {};
      if (c.accept !== null) headers.accept = c.accept;
      const res = await web(new Request(`${BASE}${c.path}`, { headers, redirect: "manual" }));
      if (c.branch === "untouched") {
        expect(res.status).toBe(200);
        expect(res.headers.get("vary")).toBeNull();
        return;
      }
      expect(res.headers.get("vary") ?? "").toMatch(/(^|,\s*)Accept(\s*,|$)/i);
      if (c.branch === "html") {
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("<html>");
        return;
      }
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(TARGETS[c.branch]);
    });
  }

  it("appends to an existing Vary instead of replacing it", async () => {
    const appWithVary = createApp();
    appWithVary.use(
      defineEventHandler((event) => {
        event.node.res.setHeader("Vary", "Cookie");
      }),
    );
    appWithVary.use(loadMiddleware(emitted ?? ""));
    appWithVary.use(defineEventHandler(() => "<html></html>"));
    const res = await toWebHandler(appWithVary)(new Request(`${BASE}/`));
    const vary = (res.headers.get("vary") ?? "").split(/,\s*/);
    expect(vary).toContain("Cookie");
    expect(vary).toContain("Accept");
  });
});

describe("@w2agent/nuxt middleware copy", () => {
  it("embeds the shared negotiation function verbatim", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const copy = readFileSync(
      join(here, "../../nuxt/src/runtime/server/middleware/content-negotiation.ts"),
      "utf8",
    );
    expect(copy).toContain(HOME_VARIANT_SOURCE);
    expect(emitted).toContain(HOME_VARIANT_SOURCE);
  });
});
