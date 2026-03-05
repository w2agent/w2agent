import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAstroInstall } from "../src/adapters/astro/install.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeAstroFiles(): GeneratedFile[] {
  return [
    makeFile("astro/public/llms.txt", "# Seed"),
    makeFile("astro/public/llms-full.txt", "# Seed Full"),
    makeFile("astro/public/.well-known/agent-card.json", "{}"),
    makeFile("astro/src/pages/llms.txt.ts", "export const GET = () => {}"),
    makeFile("astro/src/pages/.well-known/agent-card.json.ts", "export const GET = () => {}"),
    makeFile("astro/w2agent-integration.mjs", "// integration"),
    makeFile("astro/w2agent-build.mjs", "// build"),
    makeFile("astro/INSTALL.md", "# Install"),
  ];
}

describe("Astro install resolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-astro-install-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("installs only public files for static mode", () => {
    writeFileSync(
      join(tempDir, "astro.config.mjs"),
      'import { defineConfig } from "astro/config";\nexport default defineConfig({});',
      "utf-8",
    );

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const writes = plan.actions.filter((a) => a.type === "write");
    const dests = writes.map((a) => a.dest);

    expect(dests).toContain("public/llms.txt");
    expect(dests).toContain("public/llms-full.txt");
    expect(dests).toContain("public/.well-known/agent-card.json");
    expect(dests).not.toContain("src/pages/llms.txt.ts");

    const skipped = plan.actions.filter((a) => a.type === "skip");
    expect(skipped.some((a) => a.dest.startsWith("src/pages/"))).toBe(true);
  });

  it("installs all files for SSR/hybrid mode", () => {
    writeFileSync(
      join(tempDir, "astro.config.mjs"),
      'export default defineConfig({ output: "server" });',
      "utf-8",
    );

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests).toContain("src/pages/llms.txt.ts");
    expect(dests).toContain("src/pages/.well-known/agent-card.json.ts");
    expect(dests).toContain("public/llms.txt");
  });

  it("handles hybrid output mode", () => {
    writeFileSync(
      join(tempDir, "astro.config.mjs"),
      "export default defineConfig({ output: 'hybrid' });",
      "utf-8",
    );

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests).toContain("src/pages/llms.txt.ts");
  });

  it("warns when no astro config found", () => {
    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    expect(plan.warnings.some((w) => w.includes("Could not detect astro.config"))).toBe(true);
  });

  it("skips existing public/llms.txt", () => {
    writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
    mkdirSync(join(tempDir, "public"), { recursive: true });
    writeFileSync(join(tempDir, "public", "llms.txt"), "# existing", "utf-8");

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const skipped = plan.actions.find(
      (a) => a.type === "skip" && a.dest === "public/llms.txt",
    );
    expect(skipped).toBeDefined();
  });

  it("suggests adding integration to config", () => {
    writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    expect(plan.postInstallSteps.some((s) => s.includes("integration"))).toBe(true);
  });
});
