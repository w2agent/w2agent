import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDocusaurusInstall } from "../src/adapters/docusaurus/install.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeDocusaurusFiles(): GeneratedFile[] {
  return [
    makeFile("docusaurus/w2agent-plugin.js", "module.exports = function() {}"),
    makeFile("docusaurus/static/llms.txt", "# Seed"),
    makeFile("docusaurus/static/.well-known/agent-card.json", "{}"),
    makeFile("docusaurus/INSTALL.md", "# Install"),
  ];
}

describe("Docusaurus install resolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-docusaurus-install-"));
    writeFileSync(
      join(tempDir, "docusaurus.config.js"),
      "module.exports = { title: 'My Site' };",
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { "@docusaurus/core": "^3.0.0", "gray-matter": "^4.0.0" } }),
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("installs all files in a clean project", () => {
    const plan = resolveDocusaurusInstall(makeDocusaurusFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests).toContain("w2agent-plugin.js");
    expect(dests).toContain("static/llms.txt");
    expect(dests).toContain("static/.well-known/agent-card.json");
    expect(plan.postInstallSteps.some((s) => s.includes("plugin"))).toBe(true);
  });

  it("skips existing static/llms.txt", () => {
    mkdirSync(join(tempDir, "static"), { recursive: true });
    writeFileSync(join(tempDir, "static", "llms.txt"), "# existing", "utf-8");

    const plan = resolveDocusaurusInstall(makeDocusaurusFiles(), tempDir);
    const skipped = plan.actions.find(
      (a) => a.type === "skip" && a.dest === "static/llms.txt",
    );
    expect(skipped).toBeDefined();
  });

  it("skips plugin when already configured", () => {
    writeFileSync(
      join(tempDir, "docusaurus.config.js"),
      'module.exports = { plugins: ["./w2agent-plugin.js"] };',
      "utf-8",
    );

    const plan = resolveDocusaurusInstall(makeDocusaurusFiles(), tempDir);
    const skipped = plan.actions.find(
      (a) => a.type === "skip" && a.dest === "w2agent-plugin.js",
    );
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toContain("already configured");
  });

  it("warns when no docusaurus.config found", () => {
    const noConfigDir = mkdtempSync(join(tmpdir(), "w2agent-docu-noconfig-"));
    writeFileSync(
      join(noConfigDir, "package.json"),
      JSON.stringify({ dependencies: { "gray-matter": "^4.0.0" } }),
      "utf-8",
    );
    try {
      const plan = resolveDocusaurusInstall(makeDocusaurusFiles(), noConfigDir);
      expect(plan.warnings.some((w) => w.includes("No docusaurus.config"))).toBe(true);
      // Still installs to static/
      const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
      expect(dests).toContain("static/llms.txt");
    } finally {
      rmSync(noConfigDir, { recursive: true, force: true });
    }
  });

  it("suggests installing gray-matter when missing", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { "@docusaurus/core": "^3.0.0" } }),
      "utf-8",
    );

    const plan = resolveDocusaurusInstall(makeDocusaurusFiles(), tempDir);
    expect(plan.postInstallSteps.some((s) => s.includes("gray-matter"))).toBe(true);
  });

  it("does not suggest gray-matter when already installed", () => {
    const plan = resolveDocusaurusInstall(makeDocusaurusFiles(), tempDir);
    expect(plan.postInstallSteps.some((s) => s.includes("gray-matter"))).toBe(false);
  });
});
