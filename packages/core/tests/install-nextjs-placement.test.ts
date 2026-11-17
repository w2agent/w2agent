import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import { resolveNextjsInstall } from "../src/adapters/nextjs/install.js";
import type { GeneratedFile } from "../src/generate/types.js";
import { planInstall } from "../src/install/planner.js";
import type { InstallPlan } from "../src/install/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function files(withRobots = false): GeneratedFile[] {
  return [
    makeFile("llms.txt", "# LLMs"),
    ...(withRobots ? [makeFile("robots.txt", "User-agent: GPTBot\nAllow: /\n")] : []),
    makeFile("nextjs/middleware.ts", "export function middleware() {}"),
    makeFile("nextjs/components/WebMcpScript.tsx", "export default function W() { return null }"),
    makeFile("nextjs/app/llms.txt/route.ts", "export async function GET() {}"),
    makeFile("nextjs/.w2agent/llms.txt", "# Seed"),
    makeFile("nextjs/w2agent-build.mjs", "// build"),
    makeFile("nextjs/INSTALL.md", "# Install"),
  ];
}

const writes = (plan: InstallPlan) =>
  plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
const manuals = (plan: InstallPlan) => plan.actions.filter((a) => a.type === "manual");

describe("Next.js src/ placement (NX-7)", () => {
  let dir: string;

  const setup = (next: string, opts: { src?: boolean; ts?: boolean } = {}) => {
    mkdirSync(join(dir, opts.src === false ? "app" : "src/app"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next } }));
    if (opts.ts !== false) writeFileSync(join(dir, "tsconfig.json"), "{}");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-nextjs-placement-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("src/app on Next 15: src/middleware.ts and src/components/WebMcpScript.tsx", () => {
    setup("15.5.29");
    const plan = resolveNextjsInstall(files(), dir);
    const dests = writes(plan);
    expect(dests).toContain("src/middleware.ts");
    expect(dests).toContain("src/components/WebMcpScript.tsx");
    expect(dests).not.toContain("middleware.ts");
    expect(dests).not.toContain("components/WebMcpScript.tsx");
    const mount = plan.postInstallSteps.find((s) => s.includes("WebMcpScript"));
    expect(mount).toContain("src/components/WebMcpScript.tsx");
    expect(mount).toContain("src/app/layout.tsx");
  });

  it("src/app on Next 16: src/proxy.ts", () => {
    setup("16.0.0");
    const dests = writes(resolveNextjsInstall(files(), dir));
    expect(dests).toContain("src/proxy.ts");
    expect(dests).not.toContain("proxy.ts");
  });

  it("src/app in a JS project: src/middleware.js and src/components/WebMcpScript.jsx", () => {
    setup("15.0.0", { ts: false });
    const dests = writes(resolveNextjsInstall(files(), dir));
    expect(dests).toContain("src/middleware.js");
    expect(dests).toContain("src/components/WebMcpScript.jsx");
  });

  it("root app/ project keeps root placement", () => {
    setup("15.0.0", { src: false });
    const dests = writes(resolveNextjsInstall(files(), dir));
    expect(dests).toContain("middleware.ts");
    expect(dests).toContain("components/WebMcpScript.tsx");
  });

  it("existing src/middleware.ts without refs: merge copy beside it", () => {
    setup("15.0.0");
    writeFileSync(join(dir, "src", "middleware.ts"), "// auth");
    const plan = resolveNextjsInstall(files(), dir);
    expect(writes(plan)).toContain("src/middleware.w2agent.ts");
    expect(writes(plan)).not.toContain("middleware.w2agent.ts");
    const manual = manuals(plan).find((a) => a.dest === "src/middleware.ts");
    expect(manual?.reason).toContain("middleware.w2agent.ts");
  });

  it("existing src/proxy.ts without refs: merge copy src/proxy.w2agent.ts", () => {
    setup("16.0.0");
    writeFileSync(join(dir, "src", "proxy.ts"), "// auth");
    const plan = resolveNextjsInstall(files(), dir);
    expect(writes(plan)).toContain("src/proxy.w2agent.ts");
    expect(manuals(plan).some((a) => a.dest === "src/proxy.ts")).toBe(true);
  });

  it("existing root middleware.ts in a src/app project: root merge copy", () => {
    setup("15.0.0");
    writeFileSync(join(dir, "middleware.ts"), "// auth");
    const plan = resolveNextjsInstall(files(), dir);
    expect(writes(plan)).toContain("middleware.w2agent.ts");
    expect(writes(plan)).not.toContain("src/middleware.w2agent.ts");
    expect(manuals(plan).some((a) => a.dest === "middleware.ts")).toBe(true);
  });

  it("existing root middleware.ts in a root-app project: root merge copy (unchanged)", () => {
    setup("15.0.0", { src: false });
    writeFileSync(join(dir, "middleware.ts"), "// auth");
    const plan = resolveNextjsInstall(files(), dir);
    expect(writes(plan)).toContain("middleware.w2agent.ts");
  });
});

describe('Next.js output: "export" (NX-16)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-nextjs-export-"));
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"dependencies":{"next":"15.0.0"}}');
    writeFileSync(join(dir, "tsconfig.json"), "{}");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const edge = (plan: InstallPlan) =>
    plan.actions.filter((a) => /(^|\/)(middleware|proxy)[.\w]*$/.test(a.dest));

  const configs: Array<[string, string]> = [
    ["next.config.mjs", 'export default { output: "export" };\n'],
    [
      "next.config.ts",
      "const c: NextConfig = { output: 'export', images: {} };\nexport default c;\n",
    ],
    ["next.config.js", 'module.exports = { "output": `export` };\n'],
  ];

  for (const [name, text] of configs) {
    it(`${name}: no middleware/proxy, one warning, routes and seeds still written`, () => {
      writeFileSync(join(dir, name), text);
      const plan = resolveNextjsInstall(files(), dir);
      expect(edge(plan)).toHaveLength(0);
      const warns = plan.warnings.filter((w) => w.includes('output: "export"'));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("middleware");
      expect(warns[0]).toContain("/llms.txt");
      expect(warns[0]).toContain("/llms-full.txt");
      expect(warns[0]).toContain("/index.md");
      expect(warns[0]).toContain("static");
      expect(writes(plan)).toContain("app/llms.txt/route.ts");
      expect(writes(plan)).toContain(".w2agent/llms.txt");
    });
  }

  it("existing middleware in an export project: no merge copy, no merge manual", () => {
    writeFileSync(join(dir, "next.config.mjs"), 'export default { output: "export" };\n');
    writeFileSync(join(dir, "middleware.ts"), "// auth");
    const plan = resolveNextjsInstall(files(), dir);
    expect(writes(plan).some((d) => d.includes("w2agent.ts"))).toBe(false);
    expect(manuals(plan).some((a) => a.dest === "middleware.ts")).toBe(false);
  });

  it('output: "standalone" is unaffected', () => {
    writeFileSync(join(dir, "next.config.mjs"), 'export default { output: "standalone" };\n');
    const plan = resolveNextjsInstall(files(), dir);
    expect(writes(plan)).toContain("middleware.ts");
    expect(plan.warnings.some((w) => w.includes("export"))).toBe(false);
  });
});

describe("Next.js robots.txt (NX-13)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-nextjs-robots-"));
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"dependencies":{"next":"15.0.0"}}');
    writeFileSync(join(dir, "tsconfig.json"), "{}");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const robotsManuals = (plan: InstallPlan) =>
    manuals(plan).filter((a) => /(^|\/)robots\./.test(a.dest));

  it("neither target: stages .w2agent/robots.txt, manual says copy to public/robots.txt", () => {
    const plan = resolveNextjsInstall(files(true), dir);
    expect(writes(plan)).toContain(".w2agent/robots.txt");
    expect(writes(plan)).not.toContain("public/robots.txt");
    const m = robotsManuals(plan);
    expect(m).toHaveLength(1);
    expect(m[0].dest).toBe("public/robots.txt");
    expect(m[0].reason).toContain(".w2agent/robots.txt");
    expect(m[0].reason).toContain("copy it to public/robots.txt");
  });

  it("existing public/robots.txt: merge the rules into it", () => {
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "robots.txt"), "User-agent: *\n");
    const m = robotsManuals(resolveNextjsInstall(files(true), dir));
    expect(m).toHaveLength(1);
    expect(m[0].dest).toBe("public/robots.txt");
    expect(m[0].reason).toContain("Merge");
    expect(m[0].reason).toContain(".w2agent/robots.txt");
  });

  for (const [appDir, file] of [
    ["app", "robots.ts"],
    ["app", "robots.js"],
    ["src/app", "robots.ts"],
  ]) {
    it(`existing ${appDir}/${file}: add the rules to what the metadata route returns`, () => {
      mkdirSync(join(dir, appDir), { recursive: true });
      writeFileSync(join(dir, appDir, file), "export default function robots() {}");
      const m = robotsManuals(resolveNextjsInstall(files(true), dir));
      expect(m).toHaveLength(1);
      expect(m[0].dest).toBe(`${appDir}/${file}`);
      expect(m[0].reason).toContain("metadata route");
      expect(m[0].reason).toContain(".w2agent/robots.txt");
    });
  }

  it("public/robots.txt and a metadata route both exist: the public file is the target", () => {
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "robots.txt"), "User-agent: *\n");
    writeFileSync(join(dir, "app", "robots.ts"), "export default function robots() {}");
    const m = robotsManuals(resolveNextjsInstall(files(true), dir));
    expect(m).toHaveLength(1);
    expect(m[0].dest).toBe("public/robots.txt");
  });

  it("guard skip of the staged copy: text does not claim it exists", () => {
    mkdirSync(join(dir, ".w2agent"));
    writeFileSync(join(dir, ".w2agent", "robots.txt"), "mine");
    const plan = resolveNextjsInstall(files(true), dir);
    if (writes(plan).includes(".w2agent/robots.txt")) {
      throw new Error("expected the guard to skip the existing staged copy");
    }
    const m = robotsManuals(plan);
    expect(m).toHaveLength(1);
    expect(m[0].reason).toContain("was not written");
  });

  it("symlinked .w2agent: staged copy refused, text does not claim it exists", () => {
    const outside = mkdtempSync(join(tmpdir(), "w2agent-nextjs-robots-out-"));
    try {
      symlinkSync(outside, join(dir, ".w2agent"));
      const plan = resolveNextjsInstall(files(true), dir);
      expect(writes(plan)).not.toContain(".w2agent/robots.txt");
      const m = robotsManuals(plan);
      expect(m).toHaveLength(1);
      expect(m[0].reason).toContain("was not written");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("no robots.txt generated: no robots action", () => {
    const plan = resolveNextjsInstall(files(false), dir);
    expect(robotsManuals(plan)).toHaveLength(0);
    expect(writes(plan)).not.toContain(".w2agent/robots.txt");
  });

  it("planInstall adds no second generic robots action for Next", () => {
    const plan = planInstall(nextjsAdapter, files(true), dir);
    expect(robotsManuals(plan)).toHaveLength(1);
    expect(plan.actions.filter((a) => a.type === "manual" && a.dest === "robots.txt")).toHaveLength(
      0,
    );
  });

  it("planInstall dedupes against a metadata route target too", () => {
    writeFileSync(join(dir, "app", "robots.ts"), "export default function robots() {}");
    const plan = planInstall(nextjsAdapter, files(true), dir);
    expect(manuals(plan).filter((a) => /robots/.test(a.dest))).toHaveLength(1);
  });
});
