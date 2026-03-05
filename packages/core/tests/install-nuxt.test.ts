import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNuxtInstall } from "../src/adapters/nuxt/install.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeNuxtFiles(): GeneratedFile[] {
  return [
    makeFile("llms.txt", "# LLMs"),
    makeFile("nuxt/server/routes/llms.txt.ts", "export default defineEventHandler(() => {})"),
    makeFile("nuxt/server/routes/llms-full.txt.ts", "export default defineEventHandler(() => {})"),
    makeFile(
      "nuxt/server/routes/.well-known/agent-card.json.ts",
      "export default defineEventHandler(() => {})",
    ),
    makeFile(
      "nuxt/server/middleware/content-negotiation.ts",
      "export default defineEventHandler(() => {})",
    ),
    makeFile("nuxt/public/llms.txt", "# Seed"),
    makeFile("nuxt/public/llms-full.txt", "# Seed Full"),
    makeFile("nuxt/w2agent-build.mjs", "// build script"),
    makeFile("nuxt/INSTALL.md", "# Install"),
  ];
}

describe("Nuxt install resolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-nuxt-install-"));
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { nuxt: "^3.8.0" } }),
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("installs all files in a clean Nuxt 3 project", () => {
    const plan = resolveNuxtInstall(makeNuxtFiles(), tempDir);

    const writes = plan.actions.filter((a) => a.type === "write");
    const dests = writes.map((a) => a.dest);

    expect(dests).toContain("server/routes/llms.txt.ts");
    expect(dests).toContain("server/routes/llms-full.txt.ts");
    expect(dests).toContain("server/routes/.well-known/agent-card.json.ts");
    expect(dests).toContain("server/middleware/content-negotiation.ts");
    expect(dests).toContain("public/llms.txt");
    expect(dests).toContain("public/llms-full.txt");
    expect(dests).toContain("w2agent-build.mjs");
    expect(plan.warnings.length).toBe(0);
  });

  it("skips with warning for Nuxt 2 projects", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { nuxt: "^2.17.0" } }),
      "utf-8",
    );

    const plan = resolveNuxtInstall(makeNuxtFiles(), tempDir);

    expect(plan.actions.length).toBe(0);
    expect(plan.warnings[0]).toContain("Nuxt 3+");
  });

  it("skips existing server routes", () => {
    mkdirSync(join(tempDir, "server", "routes"), { recursive: true });
    writeFileSync(join(tempDir, "server", "routes", "llms.txt.ts"), "// existing", "utf-8");

    const plan = resolveNuxtInstall(makeNuxtFiles(), tempDir);

    const skipped = plan.actions.filter((a) => a.type === "skip" && a.dest.includes("llms.txt"));
    expect(skipped.length).toBeGreaterThan(0);
  });

  it("skips existing middleware with w2agent content", () => {
    mkdirSync(join(tempDir, "server", "middleware"), { recursive: true });
    writeFileSync(
      join(tempDir, "server", "middleware", "content-negotiation.ts"),
      "// w2agent content negotiation",
      "utf-8",
    );

    const plan = resolveNuxtInstall(makeNuxtFiles(), tempDir);

    const middlewareAction = plan.actions.find(
      (a) => a.dest === "server/middleware/content-negotiation.ts",
    );
    expect(middlewareAction?.type).toBe("skip");
  });

  it("creates .w2agent.ts for existing middleware without w2agent", () => {
    mkdirSync(join(tempDir, "server", "middleware"), { recursive: true });
    writeFileSync(
      join(tempDir, "server", "middleware", "content-negotiation.ts"),
      "// custom auth middleware",
      "utf-8",
    );

    const plan = resolveNuxtInstall(makeNuxtFiles(), tempDir);

    const mergeAction = plan.actions.find(
      (a) => a.dest === "server/middleware/content-negotiation.w2agent.ts",
    );
    expect(mergeAction).toBeDefined();
    expect(mergeAction?.type).toBe("write");
  });

  it("skips existing public/llms.txt", () => {
    mkdirSync(join(tempDir, "public"), { recursive: true });
    writeFileSync(join(tempDir, "public", "llms.txt"), "# existing", "utf-8");

    const plan = resolveNuxtInstall(makeNuxtFiles(), tempDir);

    const skipped = plan.actions.find((a) => a.type === "skip" && a.dest === "public/llms.txt");
    expect(skipped).toBeDefined();
  });

  it("skips existing build script", () => {
    writeFileSync(join(tempDir, "w2agent-build.mjs"), "// existing", "utf-8");

    const plan = resolveNuxtInstall(makeNuxtFiles(), tempDir);

    const skipped = plan.actions.find((a) => a.type === "skip" && a.dest === "w2agent-build.mjs");
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toBe("already exists");
    // No postbuild step when build script was skipped
    expect(plan.postInstallSteps.length).toBe(0);
  });

  it("writes unknown file types through catch-all", () => {
    const files = [...makeNuxtFiles(), makeFile("nuxt/some-config.json", '{"key": "value"}')];

    const plan = resolveNuxtInstall(files, tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
    expect(dests).toContain("some-config.json");
  });

  it("adds postbuild step when build script is installed", () => {
    const plan = resolveNuxtInstall(makeNuxtFiles(), tempDir);
    expect(plan.postInstallSteps.some((s) => s.includes("postbuild"))).toBe(true);
  });

  it("skips llms-full.txt route when existing routes detected", () => {
    mkdirSync(join(tempDir, "server", "routes"), { recursive: true });
    writeFileSync(join(tempDir, "server", "routes", "llms.txt.ts"), "// existing", "utf-8");

    const plan = resolveNuxtInstall(makeNuxtFiles(), tempDir);
    const skippedFull = plan.actions.find(
      (a) => a.type === "skip" && a.dest === "server/routes/llms-full.txt.ts",
    );
    expect(skippedFull).toBeDefined();
  });
});
