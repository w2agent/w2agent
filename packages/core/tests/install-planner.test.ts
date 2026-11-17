import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlatformAdapter } from "../src/adapters/types.js";
import type { GeneratedFile } from "../src/generate/types.js";
import { executeInstallPlan, formatInstallSummary } from "../src/install/executor.js";
import { planInstall } from "../src/install/planner.js";
import type { InstallPlan } from "../src/install/types.js";

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
      expect(plan).toEqual(customPlan);
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

  it("handles skip without reason", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [{ type: "skip", dest: "some-file.ts" }],
      warnings: [],
      postInstallSteps: [],
    };

    const result = executeInstallPlan(plan, tempDir);
    expect(result.skipped).toEqual(["some-file.ts"]);
  });

  it("handles manual without reason", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [{ type: "manual", dest: "config.json" }],
      warnings: [],
      postInstallSteps: [],
    };

    const result = executeInstallPlan(plan, tempDir);
    expect(result.manual).toEqual(["config.json"]);
  });

  it("writes empty string when content is undefined", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [{ type: "write", dest: "empty.ts" }],
      warnings: [],
      postInstallSteps: [],
    };

    const result = executeInstallPlan(plan, tempDir);
    expect(result.installed).toEqual(["empty.ts"]);
    expect(readFileSync(join(tempDir, "empty.ts"), "utf-8")).toBe("");
  });
});

describe("formatInstallSummary", () => {
  it("formats a basic install summary", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [],
      warnings: [],
      postInstallSteps: [],
    };
    const result = {
      installed: ["middleware.ts", "app/llms.txt/route.ts"],
      skipped: [],
      manual: [],
      failed: [],
    };

    const output = formatInstallSummary(
      plan,
      result,
      "/my/project",
      "https://example.com",
      "Next.js",
    );

    expect(output).toContain("w2agent integrate --install — Next.js");
    expect(output).toContain("https://example.com");
    expect(output).toContain("/my/project");
    expect(output).toContain("Installed:");
    expect(output).toContain("✓ middleware.ts");
    expect(output).toContain("✓ app/llms.txt/route.ts");
    expect(output).toContain("Re-run your audit");
  });

  it("formats dry-run summary", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [],
      warnings: [],
      postInstallSteps: [],
    };
    const result = { installed: ["middleware.ts"], skipped: [], manual: [], failed: [] };

    const output = formatInstallSummary(
      plan,
      result,
      "/proj",
      "https://example.com",
      "Next.js",
      true,
    );

    expect(output).toContain("--dry-run");
    expect(output).toContain("Will install:");
    expect(output).not.toContain("Re-run your audit");
  });

  it("includes skipped files section", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [],
      warnings: [],
      postInstallSteps: [],
    };
    const result = {
      installed: [],
      skipped: ["middleware.ts (already exists)"],
      manual: [],
      failed: [],
    };

    const output = formatInstallSummary(plan, result, "/proj", "https://example.com", "Next.js");

    expect(output).toContain("Skipped:");
    expect(output).toContain("⚠ middleware.ts (already exists)");
  });

  it("includes manual steps section", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [],
      warnings: [],
      postInstallSteps: [],
    };
    const result = {
      installed: [],
      skipped: [],
      manual: ["middleware.ts: merge w2agent content into existing middleware"],
      failed: [],
    };

    const output = formatInstallSummary(plan, result, "/proj", "https://example.com", "Next.js");

    expect(output).toContain("Manual steps needed:");
    expect(output).toContain("→ middleware.ts: merge w2agent content");
  });

  it("includes warnings section", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [],
      warnings: ["Pages Router only — App Router required"],
      postInstallSteps: [],
    };
    const result = { installed: [], skipped: [], manual: [], failed: [] };

    const output = formatInstallSummary(plan, result, "/proj", "https://example.com", "Next.js");

    expect(output).toContain("Warnings:");
    expect(output).toContain("⚠ Pages Router only");
  });

  it("includes post-install steps with numbering", () => {
    const plan: InstallPlan = {
      platform: "nextjs",
      actions: [],
      warnings: [],
      postInstallSteps: [
        'Add "postbuild": "node w2agent-build.mjs" to package.json',
        "Run npm install gray-matter",
      ],
    };
    const result = { installed: ["w2agent-build.mjs"], skipped: [], manual: [], failed: [] };

    const output = formatInstallSummary(plan, result, "/proj", "https://example.com", "Next.js");

    expect(output).toContain("Post-install steps:");
    expect(output).toContain("1. Add");
    expect(output).toContain("2. Run npm install");
  });

  it("includes all sections together", () => {
    const plan: InstallPlan = {
      platform: "nuxt",
      actions: [],
      warnings: ["Existing middleware found"],
      postInstallSteps: ["Add postbuild script"],
    };
    const result = {
      installed: ["server/routes/llms.txt.ts"],
      skipped: ["public/llms.txt (already exists)"],
      manual: ["middleware.ts: merge manually"],
      failed: [],
    };

    const output = formatInstallSummary(plan, result, "/proj", "https://nuxt-site.com", "Nuxt");

    expect(output).toContain("— Nuxt");
    expect(output).toContain("Installed:");
    expect(output).toContain("Skipped:");
    expect(output).toContain("Manual steps needed:");
    expect(output).toContain("Warnings:");
    expect(output).toContain("Post-install steps:");
  });
});
