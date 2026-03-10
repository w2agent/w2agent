import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNextjsInstall } from "../src/adapters/nextjs/install.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeNextjsFiles(): GeneratedFile[] {
  return [
    makeFile("llms.txt", "# LLMs"),
    makeFile("llms-full.txt", "# Full"),
    makeFile("nextjs/middleware.ts", "export function middleware() {}"),
    makeFile("nextjs/app/llms.txt/route.ts", "export async function GET() {}"),
    makeFile("nextjs/app/llms-full.txt/route.ts", "export async function GET() {}"),
    makeFile("nextjs/app/.well-known/agent-card.json/route.ts", "export async function GET() {}"),
    makeFile("nextjs/.w2agent/llms.txt", "# Seed"),
    makeFile("nextjs/.w2agent/llms-full.txt", "# Seed Full"),
    makeFile("nextjs/.w2agent/agent-card.json", '{"name":"test"}'),
    makeFile("nextjs/w2agent-build.mjs", "// build script"),
    makeFile("nextjs/INSTALL.md", "# Install"),
  ];
}

describe("Next.js install resolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-nextjs-install-"));
    // Create a basic Next.js app-router project
    mkdirSync(join(tempDir, "app"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("installs all files in a clean app-router project", () => {
    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);

    const writes = plan.actions.filter((a) => a.type === "write");
    const dests = writes.map((a) => a.dest);

    expect(dests).toContain("middleware.ts");
    expect(dests).toContain("app/llms.txt/route.ts");
    expect(dests).toContain("app/llms-full.txt/route.ts");
    expect(dests).toContain("app/.well-known/agent-card.json/route.ts");
    expect(dests).toContain(".w2agent/llms.txt");
    expect(dests).toContain(".w2agent/llms-full.txt");
    expect(dests).toContain(".w2agent/agent-card.json");
    expect(dests).toContain("w2agent-build.mjs");
    expect(plan.warnings.length).toBe(0);
    expect(plan.postInstallSteps.length).toBeGreaterThan(0);
    expect(plan.postInstallSteps[0]).toContain("postbuild");
  });

  it("adjusts paths for src/app/ layout", () => {
    // Create src/app structure instead of app/
    rmSync(join(tempDir, "app"), { recursive: true });
    mkdirSync(join(tempDir, "src", "app"), { recursive: true });

    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests).toContain("src/app/llms.txt/route.ts");
    expect(dests).toContain("src/app/llms-full.txt/route.ts");
    expect(dests).toContain("src/app/.well-known/agent-card.json/route.ts");
    // Should NOT have app/ paths
    expect(dests).not.toContain("app/llms.txt/route.ts");
  });

  it("skips with warning for pages-router-only projects", () => {
    rmSync(join(tempDir, "app"), { recursive: true });
    mkdirSync(join(tempDir, "pages"), { recursive: true });

    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);

    expect(plan.actions.length).toBe(0);
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.warnings[0]).toContain("App Router required");
  });

  it("skips existing llms.txt route", () => {
    mkdirSync(join(tempDir, "app", "llms.txt"), { recursive: true });
    writeFileSync(join(tempDir, "app", "llms.txt", "route.ts"), "// existing route", "utf-8");

    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);

    const skipped = plan.actions.filter(
      (a) => a.type === "skip" && a.dest === "app/llms.txt/route.ts",
    );
    expect(skipped.length).toBe(1);
    expect(skipped[0].reason).toContain("route already exists");
  });

  it("handles existing middleware with w2agent content", () => {
    writeFileSync(
      join(tempDir, "middleware.ts"),
      "// w2agent integration\nexport function middleware() {}",
      "utf-8",
    );

    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);

    const middlewareAction = plan.actions.find((a) => a.dest === "middleware.ts");
    expect(middlewareAction?.type).toBe("skip");
    expect(middlewareAction?.reason).toContain("already has w2agent");
  });

  it("creates .w2agent.ts for existing middleware without w2agent content", () => {
    writeFileSync(
      join(tempDir, "middleware.ts"),
      "export function middleware() { /* auth logic */ }",
      "utf-8",
    );

    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);

    const mergeAction = plan.actions.find((a) => a.dest === "middleware.w2agent.ts");
    expect(mergeAction).toBeDefined();
    expect(mergeAction?.type).toBe("write");
    expect(plan.warnings.some((w) => w.includes("Merge manually"))).toBe(true);
  });

  it("skips existing .w2agent/llms.txt", () => {
    mkdirSync(join(tempDir, ".w2agent"), { recursive: true });
    writeFileSync(join(tempDir, ".w2agent", "llms.txt"), "# existing", "utf-8");

    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);

    const skipped = plan.actions.find((a) => a.type === "skip" && a.dest === ".w2agent/llms.txt");
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toContain("already exists");
  });

  it("skips existing w2agent-build.mjs", () => {
    writeFileSync(join(tempDir, "w2agent-build.mjs"), "// existing", "utf-8");

    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);

    const skipped = plan.actions.find((a) => a.type === "skip" && a.dest === "w2agent-build.mjs");
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toBe("already exists");
    // No postbuild step since build script wasn't written
    expect(plan.postInstallSteps.length).toBe(0);
  });

  it("skips INSTALL.md", () => {
    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);
    const dests = plan.actions.map((a) => a.dest);
    expect(dests).not.toContain("INSTALL.md");
  });

  it("writes unknown file types through catch-all", () => {
    const files = [
      ...makeNextjsFiles(),
      makeFile("nextjs/some-custom-config.json", '{"key": "value"}'),
    ];

    const plan = resolveNextjsInstall(files, tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
    expect(dests).toContain("some-custom-config.json");
  });

  it("detects middleware.js (not just .ts)", () => {
    writeFileSync(join(tempDir, "middleware.js"), "export function middleware() {}", "utf-8");

    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);
    const mergeAction = plan.actions.find((a) => a.dest === "middleware.w2agent.ts");
    expect(mergeAction).toBeDefined();
  });

  it("detects src/middleware.ts", () => {
    rmSync(join(tempDir, "app"), { recursive: true });
    mkdirSync(join(tempDir, "src", "app"), { recursive: true });
    writeFileSync(join(tempDir, "src", "middleware.ts"), "// auth", "utf-8");

    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);
    const mergeAction = plan.actions.find((a) => a.dest === "middleware.w2agent.ts");
    expect(mergeAction).toBeDefined();
  });

  it("detects existing llms.txt route in src/app layout", () => {
    rmSync(join(tempDir, "app"), { recursive: true });
    mkdirSync(join(tempDir, "src", "app", "llms.txt"), { recursive: true });
    writeFileSync(join(tempDir, "src", "app", "llms.txt", "route.ts"), "// existing", "utf-8");

    const plan = resolveNextjsInstall(makeNextjsFiles(), tempDir);
    const skipped = plan.actions.filter(
      (a) => a.type === "skip" && a.dest.includes("llms.txt/route.ts"),
    );
    expect(skipped.length).toBe(1);
    expect(skipped[0].dest).toBe("src/app/llms.txt/route.ts");
  });
});
