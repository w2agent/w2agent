import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import { resolveNextjsInstall } from "../src/adapters/nextjs/install.js";
import {
  nextjsMiddlewareSource,
  ROUTE_REVALIDATE_SEGMENT,
} from "../src/adapters/nextjs/templates.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";
import type { InstallAction } from "../src/install/types.js";

const BASE = "https://example.com";
const ctx: GenerateContext = {
  pages: [],
  rawPages: [],
  metadata: { baseUrl: BASE, wellKnown: {} },
  baseUrl: BASE,
};
const coreFiles: GeneratedFile[] = [
  { filename: "llms.txt", content: "# LLMs", size: 6 },
  { filename: "agent-card.json", content: '{"name":"t"}', size: 12 },
  { filename: "mcp-server/server.js", content: "//", size: 2 },
  { filename: "webmcp/webmcp.js", content: "window.__w2agent = 1;", size: 21 },
];
const files = nextjsAdapter.generateIntegration(ctx, coreFiles);

type Plan = ReturnType<typeof resolveNextjsInstall>;
const writes = (plan: Plan) => plan.actions.filter((a) => a.type === "write");
const dests = (plan: Plan) => writes(plan).map((a) => a.dest);
const find = (plan: Plan, dest: string): InstallAction | undefined =>
  plan.actions.find((a) => a.dest === dest);

function nodeParses(source: string, dir: string): string | null {
  const file = join(dir, `check-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, source, "utf-8");
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    return null;
  } catch (err) {
    return String((err as { stderr?: Buffer }).stderr ?? err);
  }
}

function jsxSyntaxErrors(source: string): string[] {
  const name = "/virtual/component.jsx";
  const options: ts.CompilerOptions = { allowJs: true, noEmit: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists } = host;
  host.getSourceFile = (n, lang, ...rest) =>
    n === name ? ts.createSourceFile(n, source, lang) : getSourceFile.call(host, n, lang, ...rest);
  host.fileExists = (n) => n === name || fileExists.call(host, n);
  const program = ts.createProgram([name], options, host);
  return program
    .getSyntacticDiagnostics(program.getSourceFile(name))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("Next.js install conventions (NX-3, NX-12, NX-4)", () => {
  let dir: string;

  const setNext = (range: string, installed?: string) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: range } }));
    if (installed) {
      mkdirSync(join(dir, "node_modules", "next"), { recursive: true });
      writeFileSync(
        join(dir, "node_modules", "next", "package.json"),
        JSON.stringify({ name: "next", version: installed }),
      );
    }
  };
  const addTsconfig = () => writeFileSync(join(dir, "tsconfig.json"), "{}");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-nextjs-conv-"));
    mkdirSync(join(dir, "app"), { recursive: true });
    addTsconfig();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("proxy vs middleware (NX-3)", () => {
    it("Next 16 installed in node_modules -> proxy.ts with function proxy", () => {
      setNext("^15.0.0", "16.4.6");
      const plan = resolveNextjsInstall(files, dir);
      expect(dests(plan)).toContain("proxy.ts");
      expect(dests(plan)).not.toContain("middleware.ts");
      const proxy = find(plan, "proxy.ts");
      expect(proxy?.content).toBe(nextjsMiddlewareSource({ lang: "ts", fn: "proxy" }));
      expect(proxy?.content).toContain("export function proxy(");
    });

    it("Next ^16 range without node_modules -> proxy.ts", () => {
      setNext("^16.0.0");
      expect(dests(resolveNextjsInstall(files, dir))).toContain("proxy.ts");
    });

    it("installed 15 beats a ^16 range", () => {
      setNext("^16.0.0", "15.5.29");
      const plan = resolveNextjsInstall(files, dir);
      expect(dests(plan)).toContain("middleware.ts");
      expect(dests(plan)).not.toContain("proxy.ts");
    });

    it("installed 16 beats a ~15 range", () => {
      setNext("~15.1.0", "16.0.0");
      expect(dests(resolveNextjsInstall(files, dir))).toContain("proxy.ts");
    });

    it("Next 15 -> middleware.ts with function middleware", () => {
      setNext("15.0.0");
      const plan = resolveNextjsInstall(files, dir);
      expect(find(plan, "middleware.ts")?.content).toContain("export function middleware(");
      expect(dests(plan)).not.toContain("proxy.ts");
    });

    for (const range of ["latest", "canary", "*", "workspace:*", "git+https://example.com/n.git"]) {
      it(`unknown version "${range}" -> middleware.ts`, () => {
        setNext(range);
        const plan = resolveNextjsInstall(files, dir);
        expect(dests(plan)).toContain("middleware.ts");
        expect(dests(plan)).not.toContain("proxy.ts");
      });
    }

    it("a range whose first integer is 16 with a prefix (>=16, v16, 16.x) counts as 16", () => {
      for (const range of [">=16.0.0", "v16.1.0", "16.x", "=16.2.0"]) {
        setNext(range);
        expect(dests(resolveNextjsInstall(files, dir))).toContain("proxy.ts");
      }
    });

    it("existing proxy.ts without w2agent refs -> proxy.w2agent.ts + manual, no middleware.ts", () => {
      setNext("^16.0.0");
      writeFileSync(join(dir, "proxy.ts"), "export function proxy() { /* auth */ }");
      const plan = resolveNextjsInstall(files, dir);
      const merge = find(plan, "proxy.w2agent.ts");
      expect(merge?.type).toBe("write");
      expect(merge?.content).toBe(nextjsMiddlewareSource({ lang: "ts", fn: "proxy" }));
      expect(dests(plan)).not.toContain("middleware.ts");
      expect(dests(plan)).not.toContain("middleware.w2agent.ts");
      expect(find(plan, "proxy.ts")?.type).toBe("manual");
      expect(plan.warnings.some((w) => w.includes("proxy.w2agent.ts") && w.includes("Merge"))).toBe(
        true,
      );
    });

    it("an existing proxy decides the convention even when Next looks like 15", () => {
      setNext("15.0.0");
      writeFileSync(join(dir, "proxy.ts"), "export function proxy() {}");
      const plan = resolveNextjsInstall(files, dir);
      expect(dests(plan)).toContain("proxy.w2agent.ts");
      expect(dests(plan)).not.toContain("middleware.ts");
    });

    it("existing proxy with w2agent refs -> skip, nothing written for it", () => {
      setNext("^16.0.0");
      writeFileSync(join(dir, "proxy.ts"), "// w2agent\nexport function proxy() {}");
      const plan = resolveNextjsInstall(files, dir);
      expect(find(plan, "proxy.ts")?.type).toBe("skip");
      expect(dests(plan).filter((d) => /proxy|middleware/.test(d))).toEqual([]);
    });

    it("existing proxy mentioning llms.txt counts as a ref", () => {
      setNext("^16.0.0");
      writeFileSync(join(dir, "proxy.js"), "// rewrites to /llms.txt");
      expect(find(resolveNextjsInstall(files, dir), "proxy.ts")?.type).toBe("skip");
    });

    it("existing middleware.ts on Next 16 keeps middleware.w2agent.ts with function middleware", () => {
      setNext("^16.0.0", "16.4.6");
      writeFileSync(join(dir, "middleware.ts"), "export function middleware() { /* auth */ }");
      const plan = resolveNextjsInstall(files, dir);
      const merge = find(plan, "middleware.w2agent.ts");
      expect(merge?.type).toBe("write");
      expect(merge?.content).toContain("export function middleware(");
      expect(dests(plan)).not.toContain("proxy.ts");
      expect(dests(plan)).not.toContain("proxy.w2agent.ts");
    });

    it("existing middleware with refs (a re-run) is skipped on Next 16, no proxy written", () => {
      setNext("^16.0.0");
      writeFileSync(join(dir, "middleware.ts"), "// w2agent\nexport function middleware() {}");
      const plan = resolveNextjsInstall(files, dir);
      expect(find(plan, "middleware.ts")?.type).toBe("skip");
      expect(dests(plan)).not.toContain("proxy.ts");
    });

    it("src/proxy.ts counts as an existing proxy", () => {
      setNext("^16.0.0");
      rmSync(join(dir, "app"), { recursive: true });
      mkdirSync(join(dir, "src", "app"), { recursive: true });
      writeFileSync(join(dir, "src", "proxy.ts"), "export function proxy() {}");
      const plan = resolveNextjsInstall(files, dir);
      expect(dests(plan)).toContain("src/proxy.w2agent.ts");
      expect(dests(plan)).not.toContain("proxy.ts");
      expect(dests(plan)).not.toContain("middleware.ts");
      expect(find(plan, "src/proxy.ts")?.type).toBe("manual");
    });

    it("a re-run after the Next 16 codemod renamed our middleware to proxy.ts is skipped", () => {
      setNext("^16.0.0");
      writeFileSync(join(dir, "proxy.ts"), nextjsMiddlewareSource({ lang: "ts", fn: "proxy" }));
      const plan = resolveNextjsInstall(files, dir);
      expect(find(plan, "proxy.ts")?.type).toBe("skip");
      expect(dests(plan)).not.toContain("middleware.ts");
    });
  });

  describe("JavaScript projects (NX-12)", () => {
    let scratch: string;
    beforeEach(() => {
      rmSync(join(dir, "tsconfig.json"));
      setNext("15.0.0");
      scratch = mkdtempSync(join(tmpdir(), "w2agent-nextjs-js-check-"));
    });
    afterEach(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    it("installs .js routes and middleware and a .jsx component", () => {
      const plan = resolveNextjsInstall(files, dir);
      expect(dests(plan)).toEqual(
        expect.arrayContaining([
          "middleware.js",
          "app/llms.txt/route.js",
          "app/llms-full.txt/route.js",
          "app/index.md/route.js",
          "app/.well-known/agent-card.json/route.js",
          "app/api/w2agent-mcp-webhook/route.js",
          "components/WebMcpScript.jsx",
        ]),
      );
      expect(dests(plan).filter((d) => /\.tsx?$/.test(d))).toEqual([]);
    });

    it("uses proxy.js on Next 16, and .js merge copies", () => {
      setNext("^16.0.0");
      expect(dests(resolveNextjsInstall(files, dir))).toContain("proxy.js");
      writeFileSync(join(dir, "proxy.js"), "export function proxy() {}");
      expect(dests(resolveNextjsInstall(files, dir))).toContain("proxy.w2agent.js");
    });

    it("existing middleware.js -> middleware.w2agent.js", () => {
      writeFileSync(join(dir, "middleware.js"), "export function middleware() {}");
      expect(dests(resolveNextjsInstall(files, dir))).toContain("middleware.w2agent.js");
    });

    it("a tsconfig.json keeps TypeScript", () => {
      addTsconfig();
      expect(dests(resolveNextjsInstall(files, dir))).toContain("middleware.ts");
    });

    it("every installed .js file parses as plain JavaScript (node --check)", () => {
      for (const version of ["15.0.0", "^16.0.0"]) {
        setNext(version);
        const plan = resolveNextjsInstall(files, dir);
        const js = writes(plan).filter((a) => a.dest.endsWith(".js"));
        expect(js.length).toBeGreaterThanOrEqual(6);
        for (const action of js) {
          expect(nodeParses(action.content ?? "", scratch), action.dest).toBeNull();
        }
      }
    });

    it("the installed .jsx component parses as plain JavaScript", () => {
      const component = find(resolveNextjsInstall(files, dir), "components/WebMcpScript.jsx");
      expect(jsxSyntaxErrors(component?.content ?? "")).toEqual([]);
    });

    it("the parse checks fail on a planted TypeScript-only token", () => {
      const plan = resolveNextjsInstall(files, dir);
      const route = find(plan, "app/llms.txt/route.js")?.content ?? "";
      expect(nodeParses(`${route}\nconst planted: string = "x";\n`, scratch)).not.toBeNull();
      const middleware = find(plan, "middleware.js")?.content ?? "";
      expect(
        nodeParses(
          middleware.replace("homeVariant(accept)", "homeVariant(accept: string)"),
          scratch,
        ),
      ).not.toBeNull();
      const component = find(plan, "components/WebMcpScript.jsx")?.content ?? "";
      expect(
        jsxSyntaxErrors(component.replace("WebMcpScript()", "WebMcpScript(props: object)")),
      ).not.toEqual([]);
    });

    it("the JS middleware has no type annotations and no NextRequest import", () => {
      const source = nextjsMiddlewareSource({ lang: "js", fn: "middleware" });
      expect(source).not.toContain("NextRequest");
      expect(source).not.toContain("type HomeVariant");
      expect(source).toContain("export function middleware(request)");
    });

    it("the TS install keeps TypeScript content", () => {
      addTsconfig();
      const plan = resolveNextjsInstall(files, dir);
      expect(find(plan, "middleware.ts")?.content).toContain("request: NextRequest");
      expect(find(plan, "app/api/w2agent-mcp-webhook/route.ts")?.content).toContain(
        "request: Request",
      );
    });

    it("the WebMCP mount step names the .jsx layout wording", () => {
      const plan = resolveNextjsInstall(files, dir);
      const step = plan.postInstallSteps.find((s) => s.includes("WebMcpScript"));
      expect(step).toContain("components/WebMcpScript.jsx");
      expect(step).toContain("app/layout.jsx");
    });
  });

  describe("cacheComponents (NX-4)", () => {
    const routeActions = (plan: Plan) => writes(plan).filter((a) => /\/route\.[jt]s$/.test(a.dest));

    it("every generated route that has the segment config carries exactly the shared constant", () => {
      const routes = files.filter((f) => /\/route\.ts$/.test(f.filename));
      expect(routes.length).toBeGreaterThanOrEqual(5);
      const withSegment = routes.filter((f) => /export const revalidate\b/.test(f.content));
      expect(withSegment.length).toBeGreaterThanOrEqual(4);
      for (const route of withSegment) {
        expect(route.content, route.filename).toContain(ROUTE_REVALIDATE_SEGMENT);
      }
    });

    it("projects without the flags keep revalidate = 3600", () => {
      setNext("16.4.6");
      writeFileSync(join(dir, "next.config.ts"), "export default { reactStrictMode: true };");
      const plan = resolveNextjsInstall(files, dir);
      const withSegment = routeActions(plan).filter((a) =>
        a.content?.includes("export const revalidate = 3600;"),
      );
      expect(withSegment.length).toBeGreaterThanOrEqual(4);
    });

    const stripped: [string, string, string][] = [
      [
        "cacheComponents: true in next.config.ts",
        "next.config.ts",
        "export default { cacheComponents: true };",
      ],
      [
        "cacheComponents: true in next.config.mjs",
        "next.config.mjs",
        "const c = { cacheComponents: true };\nexport default c;",
      ],
      [
        "cacheComponents in next.config.js (CommonJS)",
        "next.config.js",
        "module.exports = { cacheComponents: process.env.X === '1' };",
      ],
      [
        "experimental.dynamicIO",
        "next.config.ts",
        "export default { experimental: { dynamicIO: true } };",
      ],
      ["quoted key", "next.config.cjs", 'module.exports = { "cacheComponents": true };'],
      ["next.config.mts", "next.config.mts", "export default { cacheComponents: true };"],
    ];
    for (const [name, file, text] of stripped) {
      it(`${name} -> no segment config in any route (TS and JS)`, () => {
        setNext("16.4.6");
        writeFileSync(join(dir, file), text);
        for (const withTsconfig of [true, false]) {
          if (withTsconfig) addTsconfig();
          else rmSync(join(dir, "tsconfig.json"), { force: true });
          const routes = routeActions(resolveNextjsInstall(files, dir));
          expect(routes.length).toBeGreaterThanOrEqual(5);
          for (const route of routes) {
            expect(route.content, route.dest).not.toMatch(/export const revalidate\b/);
            expect(route.content, route.dest).not.toContain("ISR");
            expect(route.content, route.dest).toContain("export async function");
          }
        }
      });
    }

    it("only the segment config is removed: the output still parses and is otherwise unchanged", () => {
      setNext("16.4.6");
      writeFileSync(join(dir, "next.config.ts"), "export default { cacheComponents: true };");
      const plan = resolveNextjsInstall(files, dir);
      for (const route of routeActions(plan)) {
        const original = files.find((f) => f.filename === `nextjs/${route.dest}`);
        expect(route.content).toBe(original?.content.replace(ROUTE_REVALIDATE_SEGMENT, ""));
      }
    });

    it("cacheComponents: false keeps the segment config", () => {
      setNext("16.4.6");
      writeFileSync(join(dir, "next.config.ts"), "export default { cacheComponents: false };");
      const routes = routeActions(resolveNextjsInstall(files, dir));
      expect(
        routes.filter((a) => a.content?.includes("export const revalidate = 3600;")).length,
      ).toBeGreaterThanOrEqual(4);
    });

    it("a quoted cacheComponents: false keeps it, a mention elsewhere strips it", () => {
      setNext("16.4.6");
      writeFileSync(join(dir, "next.config.ts"), 'export default { "cacheComponents" : false };');
      expect(
        routeActions(resolveNextjsInstall(files, dir)).some((a) =>
          a.content?.includes("export const revalidate"),
        ),
      ).toBe(true);
      writeFileSync(
        join(dir, "next.config.ts"),
        "const on = process.env.CC;\nexport default { cacheComponents: false, experimental: { dynamicIO: on } };",
      );
      expect(
        routeActions(resolveNextjsInstall(files, dir)).some((a) =>
          a.content?.includes("export const revalidate"),
        ),
      ).toBe(false);
    });

    it("reads every config file, not just the first, and never executes one", () => {
      setNext("16.4.6");
      writeFileSync(join(dir, "next.config.js"), "export default { cacheComponents: false };");
      writeFileSync(
        join(dir, "next.config.mjs"),
        'throw new Error("must not run"); // cacheComponents: true',
      );
      const routes = routeActions(resolveNextjsInstall(files, dir));
      expect(routes.some((a) => a.content?.includes("export const revalidate"))).toBe(false);
    });
  });
});
