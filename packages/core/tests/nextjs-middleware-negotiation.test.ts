import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import type { GenerateContext } from "../src/generate/types.js";
import { ACCEPT_CASES } from "./helpers/accept-cases.js";

const require = createRequire(import.meta.url);
const { NextRequest } = require("next/server") as typeof import("next/server");

const BASE = "https://example.com";
const ctx: GenerateContext = {
  pages: [],
  rawPages: [],
  metadata: { baseUrl: BASE, wellKnown: {} },
  baseUrl: BASE,
};

const emitted = nextjsAdapter
  .generateIntegration(ctx, [])
  .find((f) => f.filename === "nextjs/middleware.ts")?.content;

function loadMiddleware(source: string): (req: InstanceType<typeof NextRequest>) => Response {
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  const sandbox: Record<string, unknown> = {
    exports: {},
    require: (id: string) => {
      if (id === "next/server") return require("next/server");
      throw new Error(`unexpected require ${id}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(out.outputText, sandbox);
  return (sandbox.exports as { middleware: (req: unknown) => Response }).middleware as never;
}

const TARGETS = { markdown: "/index.md", plain: "/llms.txt" } as const;

describe("Next.js middleware Accept negotiation (NX-1, NX-2), real next/server", () => {
  it("is emitted", () => {
    expect(emitted).toBeDefined();
  });

  for (const basePath of ["", "/docs"]) {
    describe(`basePath ${basePath || "(none)"}`, () => {
      const middleware = loadMiddleware(emitted ?? "");
      for (const c of ACCEPT_CASES) {
        it(`${c.name} -> ${c.branch}`, () => {
          const headers: Record<string, string> = {};
          if (c.accept !== null) headers.accept = c.accept;
          const rel = c.path.replace(/^\/(?=\?|$)/, "");
          const res = middleware(
            new NextRequest(`${BASE}${basePath}${rel}`, {
              headers,
              nextConfig: basePath ? { basePath } : undefined,
            }),
          );
          const rewrite = res.headers.get("x-middleware-rewrite");
          if (c.branch === "untouched") {
            expect(res.headers.get("x-middleware-next")).toBe("1");
            expect(rewrite).toBeNull();
            expect(res.headers.get("vary")).toBeNull();
            return;
          }
          expect(res.headers.get("vary") ?? "").toMatch(/(^|,\s*)Accept(\s*,|$)/i);
          if (c.branch === "html") {
            expect(res.headers.get("x-middleware-next")).toBe("1");
            expect(rewrite).toBeNull();
            return;
          }
          const target = new URL(rewrite ?? "http://missing");
          expect(target.pathname).toBe(`${basePath}${TARGETS[c.branch]}`);
          expect(target.search).toBe(c.path.includes("?") ? c.path.slice(1) : "");
        });
      }
    });
  }
});
