import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import { resolveNextjsInstall } from "../src/adapters/nextjs/install.js";
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

function loadMiddleware(
  source: string,
  fn: string,
  fileName: string,
): (req: InstanceType<typeof NextRequest>) => Response {
  const out = ts.transpileModule(source, {
    fileName,
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
  const exported = (sandbox.exports as Record<string, unknown>)[fn];
  expect(typeof exported, `${fn} is exported`).toBe("function");
  return exported as never;
}

// The installed files, through the real resolver: TS or JS (no tsconfig), middleware or proxy (Next 16)
function installed(dest: string, opts: { tsconfig: boolean; next: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "w2agent-nextjs-neg-"));
  try {
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: opts.next } }));
    if (opts.tsconfig) writeFileSync(join(dir, "tsconfig.json"), "{}");
    const plan = resolveNextjsInstall(nextjsAdapter.generateIntegration(ctx, []), dir);
    const action = plan.actions.find((a) => a.type === "write" && a.dest === dest);
    expect(action, dest).toBeDefined();
    return action?.content ?? "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VARIANTS = [
  { name: "middleware.ts", source: emitted ?? "", fn: "middleware" },
  {
    name: "installed middleware.ts (Next 15)",
    source: installed("middleware.ts", { tsconfig: true, next: "15.0.0" }),
    fn: "middleware",
  },
  {
    name: "installed proxy.ts (Next 16)",
    source: installed("proxy.ts", { tsconfig: true, next: "16.0.0" }),
    fn: "proxy",
  },
  {
    name: "installed middleware.js (JS project)",
    source: installed("middleware.js", { tsconfig: false, next: "15.0.0" }),
    fn: "middleware",
  },
  {
    name: "installed proxy.js (JS project, Next 16)",
    source: installed("proxy.js", { tsconfig: false, next: "16.0.0" }),
    fn: "proxy",
  },
];

const TARGETS = { markdown: "/index.md", plain: "/llms.txt" } as const;

describe("Next.js middleware Accept negotiation (NX-1, NX-2), real next/server", () => {
  it("is emitted", () => {
    expect(emitted).toBeDefined();
  });

  for (const variant of VARIANTS) {
    for (const basePath of ["", "/docs"]) {
      describe(`${variant.name}, basePath ${basePath || "(none)"}`, () => {
        const middleware = loadMiddleware(
          variant.source,
          variant.fn,
          variant.name.includes(".js") ? "x.js" : "x.ts",
        );
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
  }
});
