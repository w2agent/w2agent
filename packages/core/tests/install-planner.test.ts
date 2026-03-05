import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlatformAdapter } from "../src/adapters/types.js";
import { executeInstallPlan } from "../src/install/executor.js";
import { planInstall } from "../src/install/planner.js";
import type { InstallPlan } from "../src/install/types.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id: "nextjs",
    name: "Next.js",
    description: "test",
    detect: () => null,
    checks: [],
    generateIntegration: () => [],
    ...overrides,
  };
}

describe("install planner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-install-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("fallback planner (no resolveInstall)", () => {
    it("plans all platform files as write actions", () => {
      const files = [
        makeFile("llms.txt", "# LLMs"),
        makeFile("nextjs/middleware.ts", "export function middleware() {}"),
        makeFile("nextjs/app/llms.txt/route.ts", "export async function GET() {}"),
        makeFile("nextjs/w2agent-build.mjs", "// build"),
        makeFile("nextjs/INSTALL.md", "# Install"),
      ];

      const adapter = makeAdapter();
      const plan = planInstall(adapter, files, tempDir);

      expect(plan.platform).toBe("nextjs");
      // INSTALL.md skipped, middleware + route + build written
      const writeActions = plan.actions.filter((a) => a.type === "write");
      expect(writeActions.length).toBe(3);
      expect(writeActions.map((a) => a.dest)).toEqual([
        "middleware.ts",
        "app/llms.txt/route.ts",
        "w2agent-build.mjs",
      ]);
    });

    it("skips INSTALL.md", () => {
      const files = [makeFile("nextjs/INSTALL.md", "# Install")];
      const plan = planInstall(makeAdapter(), files, tempDir);
      expect(plan.actions.length).toBe(0);
    });

    it("does not install seed files when route handlers exist", () => {
      const files = [
        makeFile("llms.txt", "# LLMs"),
        makeFile("llms-full.txt", "# Full"),
        makeFile("nextjs/app/llms.txt/route.ts", "export async function GET() {}"),
      ];
      const plan = planInstall(makeAdapter(), files, tempDir);
      // Only the route handler should be written, not seed files to public/
      const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
      expect(dests).not.toContain("public/llms.txt");
      expect(dests).not.toContain("public/llms-full.txt");
    });

    it("installs seed files to public/ when no route handlers", () => {
      const files = [
        makeFile("llms.txt", "# LLMs"),
        makeFile("llms-full.txt", "# Full"),
        makeFile("nextjs/w2agent-build.mjs", "// build"),
      ];
      const plan = planInstall(makeAdapter(), files, tempDir);
      const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
      expect(dests).toContain("public/llms.txt");
      expect(dests).toContain("public/llms-full.txt");
    });

    it("handles existing middleware with w2agent content as skip", () => {
      // Create existing middleware with w2agent content
      writeFileSync(join(tempDir, "middleware.ts"), "// w2agent middleware", "utf-8");

      const files = [makeFile("nextjs/middleware.ts", "export function middleware() {}")];
      const plan = planInstall(makeAdapter(), files, tempDir);

      expect(plan.actions[0].type).toBe("skip");
      expect(plan.actions[0].reason).toContain("already has w2agent");
    });

    it("handles existing middleware without w2agent as merge", () => {
      writeFileSync(join(tempDir, "middleware.ts"), "export function middleware() {}", "utf-8");

      const files = [
        makeFile("nextjs/middleware.ts", "// w2agent middleware\nexport function middleware() {}"),
      ];
      const plan = planInstall(makeAdapter(), files, tempDir);

      const writeAction = plan.actions.find((a) => a.type === "write");
      expect(writeAction?.dest).toBe("middleware.w2agent.ts");
      expect(plan.warnings.length).toBeGreaterThan(0);
      expect(plan.warnings[0]).toContain("Merge manually");
    });
  });

  describe("custom resolveInstall", () => {
    it("uses adapter resolveInstall when provided", () => {
      const customPlan: InstallPlan = {
        platform: "nextjs",
        actions: [{ type: "write", dest: "custom/file.ts", content: "custom" }],
        warnings: ["custom warning"],
        postInstallSteps: ["do something"],
      };

      const adapter = makeAdapter({
        resolveInstall: () => customPlan,
      });

      const plan = planInstall(adapter, [], tempDir);
      expect(plan).toBe(customPlan);
    });
  });
});

describe("install executor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-exec-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes files to project dir", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [
        { type: "write", dest: "middleware.ts", content: "// middleware" },
        { type: "write", dest: "app/llms.txt/route.ts", content: "// route" },
      ],
      warnings: [],
      postInstallSteps: [],
    };

    const result = executeInstallPlan(plan, tempDir);

    expect(result.installed).toEqual(["middleware.ts", "app/llms.txt/route.ts"]);
    expect(existsSync(join(tempDir, "middleware.ts"))).toBe(true);
    expect(existsSync(join(tempDir, "app/llms.txt/route.ts"))).toBe(true);
    expect(readFileSync(join(tempDir, "middleware.ts"), "utf-8")).toBe("// middleware");
  });

  it("collects skipped and manual actions", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [
        { type: "skip", dest: "middleware.ts", reason: "already exists" },
        { type: "manual", dest: "package.json", reason: "add postbuild script" },
      ],
      warnings: [],
      postInstallSteps: [],
    };

    const result = executeInstallPlan(plan, tempDir);

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(["middleware.ts (already exists)"]);
    expect(result.manual).toEqual(["package.json: add postbuild script"]);
  });

  it("creates nested directories", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [
        {
          type: "write",
          dest: "app/.well-known/agent-card.json/route.ts",
          content: "// agent card",
        },
      ],
      warnings: [],
      postInstallSteps: [],
    };

    const result = executeInstallPlan(plan, tempDir);
    expect(result.installed.length).toBe(1);
    expect(existsSync(join(tempDir, "app/.well-known/agent-card.json/route.ts"))).toBe(true);
  });
});
