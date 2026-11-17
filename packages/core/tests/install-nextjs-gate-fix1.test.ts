import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import {
  detectNextMajor,
  resolveNextjsInstall,
  usesCacheComponents,
  usesStaticExport,
} from "../src/adapters/nextjs/install.js";
import { generateNextjsIntegration } from "../src/adapters/nextjs/templates.js";
import type { GeneratedFile } from "../src/generate/types.js";
import { planInstall } from "../src/install/planner.js";
import type { InstallPlan } from "../src/install/types.js";

const files: GeneratedFile[] = [
  ...generateNextjsIntegration("# L", "# F", undefined, "https://example.com"),
  { filename: "robots.txt", content: "User-agent: *\n", size: 14 },
];

const writes = (plan: InstallPlan) =>
  plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
const manuals = (plan: InstallPlan) => plan.actions.filter((a) => a.type === "manual");
const skips = (plan: InstallPlan) => plan.actions.filter((a) => a.type === "skip");

describe("Next.js install gate fixes (round 1)", () => {
  let dir: string;
  const put = (rel: string, content = "") => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  const setup = (next: string, opts: { src?: boolean } = {}) => {
    mkdirSync(join(dir, opts.src === false ? "app" : "src/app"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next } }));
    writeFileSync(join(dir, "tsconfig.json"), "{}");
  };
  const resolve = () => resolveNextjsInstall(files, dir);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-nx-gate1-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("root edge file in a src/app project", () => {
    it("re-run with w2agent refs skips the real root file and warns", () => {
      setup("^15.5.0");
      put("middleware.ts", "// w2agent\nexport function middleware() {}\n");
      const plan = resolve();
      expect(skips(plan).map((a) => a.dest)).toContain("middleware.ts");
      expect(skips(plan).map((a) => a.dest)).not.toContain("src/middleware.ts");
      expect(plan.warnings.join("\n")).toMatch(
        /Next\.js 15, and Next\.js 16 with webpack, ignore a root middleware\.ts in a src\/app project; move it to src\/middleware\.ts/,
      );
    });

    it("root file without refs gets a root merge copy and the warning", () => {
      setup("^15.5.0");
      put("middleware.ts", "export function middleware() {}\n");
      const plan = resolve();
      expect(writes(plan)).toContain("middleware.w2agent.ts");
      expect(writes(plan)).not.toContain("src/middleware.ts");
      expect(plan.warnings.join("\n")).toMatch(/ignore a root middleware\.ts/);
    });

    it("names proxy.ts for a root proxy", () => {
      setup("16.0.0");
      put("proxy.ts", "export function proxy() {}\n");
      const w = resolve().warnings.join("\n");
      expect(w).toContain(
        "Next.js ignores a root proxy.ts in a src/app project; move it to src/proxy.ts.",
      );
      expect(w).not.toMatch(/15 and earlier/);
    });

    it("prefers the src file when both exist and tells the user to remove the root one", () => {
      setup("^15.5.0");
      put("middleware.ts", "export function middleware() {}\n");
      put("src/middleware.ts", "export function middleware() {}\n");
      const plan = resolve();
      expect(writes(plan)).toContain("src/middleware.w2agent.ts");
      expect(manuals(plan).map((a) => a.dest)).toContain("src/middleware.ts");
      const w = plan.warnings.join("\n");
      expect(w).toContain(
        "middleware.ts at the project root can be ignored by Next.js in a src/app project; remove it once src/middleware.ts has the w2agent code.",
      );
      expect(w).not.toMatch(/move it to/);
    });

    it("root refs beside a live src file without refs: the src file decides, merge copy beside it", () => {
      setup("^15.5.0");
      put("middleware.ts", "// w2agent\nexport function middleware() {}\n");
      put("src/middleware.ts", "export function middleware() {}\n");
      const plan = resolve();
      expect(skips(plan)).toEqual([]);
      expect(writes(plan)).toContain("src/middleware.w2agent.ts");
      expect(manuals(plan).map((a) => a.dest)).toContain("src/middleware.ts");
      const w = plan.warnings.join("\n");
      expect(w).not.toMatch(/move it to/);
      expect(w).toContain("remove it once src/middleware.ts has the w2agent code");
    });

    it("src file with refs skips naming the src file and warns about the root file", () => {
      setup("^15.5.0");
      put("middleware.ts", "export function middleware() {}\n");
      put("src/middleware.ts", "// w2agent\nexport function middleware() {}\n");
      const plan = resolve();
      expect(skips(plan).map((a) => a.dest)).toEqual(["src/middleware.ts"]);
      expect(writes(plan).filter((d) => /middleware/.test(d))).toEqual([]);
      expect(plan.warnings.join("\n")).toContain(
        "remove it once src/middleware.ts has the w2agent code",
      );
    });

    it("root proxy beside a live src proxy: remove text has no version qualifier", () => {
      setup("16.0.0");
      put("proxy.ts", "// w2agent\nexport function proxy() {}\n");
      put("src/proxy.ts", "export function proxy() {}\n");
      const plan = resolve();
      expect(skips(plan)).toEqual([]);
      expect(writes(plan)).toContain("src/proxy.w2agent.ts");
      const w = plan.warnings.join("\n");
      expect(w).toContain(
        "proxy.ts at the project root is ignored by Next.js in a src/app project; remove it once src/proxy.ts has the w2agent code.",
      );
    });

    it("a src file of the other name still decides (root middleware, src proxy)", () => {
      setup("16.0.0");
      put("middleware.ts", "// w2agent\nexport function middleware() {}\n");
      put("src/proxy.ts", "export function proxy() {}\n");
      const plan = resolve();
      expect(skips(plan)).toEqual([]);
      expect(writes(plan)).toContain("src/proxy.w2agent.ts");
      expect(manuals(plan).map((a) => a.dest)).toContain("src/proxy.ts");
    });

    it("does not warn for a root file in a root app project", () => {
      setup("^15.5.0", { src: false });
      put("middleware.ts", "export function middleware() {}\n");
      expect(resolve().warnings.join("\n")).not.toMatch(/ignore a root/);
    });

    it("never writes a second edge file beside the root one", () => {
      setup("16.0.0");
      put("middleware.ts", "// w2agent\n");
      expect(writes(resolve()).filter((d) => /(middleware|proxy)\.(ts|js)$/.test(d))).toEqual([]);
    });
  });

  describe("tsx and jsx edge files", () => {
    it.each([
      "middleware.tsx",
      "middleware.jsx",
      "src/middleware.tsx",
    ])("existing %s on Next 16 gets no proxy file", (name) => {
      setup("16.0.0");
      put(name, "export function middleware() {}\n");
      const plan = resolve();
      expect(writes(plan).filter((d) => /proxy\.(ts|js)$/.test(d))).toEqual([]);
      expect(writes(plan).some((d) => d.includes("middleware.w2agent."))).toBe(true);
      expect(manuals(plan).map((a) => a.dest)).toContain(name);
    });

    it.each([
      "proxy.tsx",
      "proxy.jsx",
      "src/proxy.jsx",
    ])("existing %s on Next 15 keeps the proxy convention", (name) => {
      setup("15.5.0");
      put(name, "export function proxy() {}\n");
      const plan = resolve();
      expect(writes(plan).filter((d) => /\/?middleware\.w2agent/.test(d))).toEqual([]);
      expect(writes(plan).some((d) => d.includes("proxy.w2agent."))).toBe(true);
    });

    it("reads w2agent refs from a .tsx file", () => {
      setup("16.0.0");
      put("src/middleware.tsx", "// w2agent\nexport function middleware() {}\n");
      const plan = resolve();
      expect(skips(plan).map((a) => a.dest)).toContain("src/middleware.tsx");
      expect(writes(plan).filter((d) => /(middleware|proxy)\./.test(d))).toEqual([]);
    });
  });

  describe("static export with cacheComponents", () => {
    const cfg = (body: string) => put("next.config.mjs", `export default { ${body} }\n`);
    const routes = (plan: InstallPlan) =>
      plan.actions.filter((a) => a.type === "write" && /route\.ts$/.test(a.dest));

    it("keeps revalidate and warns when both are set", () => {
      setup("16.0.0");
      cfg('output: "export", cacheComponents: true');
      const plan = resolve();
      expect(routes(plan).length).toBeGreaterThan(0);
      for (const r of routes(plan)) {
        expect(r.type === "write" && r.content).toContain("export const revalidate");
      }
      expect(plan.warnings.join("\n")).toMatch(
        /cacheComponents[\s\S]*revalidate[\s\S]*manual change|revalidate[\s\S]*cacheComponents[\s\S]*manual/,
      );
    });

    it("does not add that warning for a static export alone", () => {
      setup("16.0.0");
      cfg('output: "export"');
      expect(resolve().warnings.join("\n")).not.toMatch(/manual change/);
    });

    it("still drops revalidate for cacheComponents without export", () => {
      setup("16.0.0");
      cfg("cacheComponents: true");
      for (const r of routes(resolve())) {
        expect(r.type === "write" && r.content).not.toContain("export const revalidate");
      }
    });
  });

  describe("cacheComponents `: false` must be the whole value", () => {
    const detect = (body: string) => {
      writeFileSync(join(dir, "next.config.mjs"), `export default { ${body} }\n`);
      return usesCacheComponents(dir);
    };
    it.each([
      "cacheComponents: false || true",
      "cacheComponents: false && x",
      "cacheComponents: false ? a : b",
      "cacheComponents: falsey",
    ])("%s is on", (body) => {
      expect(detect(body)).toBe(true);
    });
    it.each([
      "cacheComponents: false",
      "cacheComponents: false,",
      "cacheComponents: false }",
      "cacheComponents: false // off",
      "cacheComponents: false /* off */",
      "cacheComponents: false\n, other: 1",
      '"cacheComponents": false,',
    ])("%j is off", (body) => {
      expect(detect(body)).toBe(false);
    });
    it("end of text counts as the whole value", () => {
      writeFileSync(join(dir, "next.config.mjs"), "x = { cacheComponents: false");
      expect(usesCacheComponents(dir)).toBe(false);
    });
  });

  describe("app/robots.txt metadata file", () => {
    it("names app/robots.txt as the merge target", () => {
      setup("16.0.0", { src: false });
      put("app/robots.txt", "User-agent: *\n");
      const plan = planInstall(nextjsAdapter, files, dir);
      const robots = manuals(plan).filter((a) => /robots/.test(a.dest));
      expect(robots.map((a) => a.dest)).toEqual(["app/robots.txt"]);
      expect(robots[0]?.reason).toMatch(/Merge the rules/);
      expect(robots[0]?.reason).not.toMatch(/public\/robots\.txt/);
    });

    it("names src/app/robots.txt in a src project", () => {
      setup("16.0.0");
      put("src/app/robots.txt", "User-agent: *\n");
      const plan = planInstall(nextjsAdapter, files, dir);
      expect(
        manuals(plan)
          .filter((a) => /robots/.test(a.dest))
          .map((a) => a.dest),
      ).toEqual(["src/app/robots.txt"]);
    });

    it("an existing public/robots.txt still wins", () => {
      setup("16.0.0", { src: false });
      put("app/robots.txt", "User-agent: *\n");
      put("public/robots.txt", "User-agent: *\n");
      expect(
        manuals(resolve())
          .filter((a) => /robots/.test(a.dest))
          .map((a) => a.dest),
      ).toEqual(["public/robots.txt"]);
    });
  });

  describe("upper-bound-only ranges", () => {
    const major = (range: string) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: range } }));
      return detectNextMajor(dir);
    };
    it.each(["<17", "<=16", " < 17", "<17.0.0"])("%s is unknown", (range) => {
      expect(major(range)).toBeNull();
    });
    it("lower bounds and exact ranges still read", () => {
      expect(major(">=15")).toBe(15);
      expect(major("^16.1.0")).toBe(16);
      expect(major("=15.2.0")).toBe(15);
    });
    it("a < range installs middleware", () => {
      setup("<17");
      expect(writes(resolve())).toContain("src/middleware.ts");
      expect(writes(resolve())).not.toContain("src/proxy.ts");
    });
  });

  describe("conditional static export", () => {
    const cfg = (body: string) =>
      writeFileSync(join(dir, "next.config.mjs"), `export default { ${body} }\n`);
    it.each([
      'output: process.env.EXPORT ? "export" : undefined,',
      "output: process.env.EXPORT ? 'export' : undefined,",
      "output: isCi ? `export` : undefined",
    ])("%s installs middleware and warns", (body) => {
      setup("16.0.0");
      cfg(body);
      const plan = resolve();
      expect(writes(plan)).toContain("src/proxy.ts");
      expect(plan.warnings.join("\n")).toMatch(
        /does not run in builds where `output` is `"export"`/,
      );
    });

    it("the plain literal keeps its behavior and has no conditional warning", () => {
      setup("16.0.0");
      cfg('output: "export"');
      const plan = resolve();
      expect(usesStaticExport(dir)).toBe(true);
      expect(writes(plan)).not.toContain("src/proxy.ts");
      expect(plan.warnings.join("\n")).not.toMatch(/does not run in builds/);
    });

    it("a standalone output has no warning", () => {
      setup("16.0.0");
      cfg('output: "standalone"');
      expect(resolve().warnings.join("\n")).not.toMatch(/does not run in builds/);
    });
  });
});
