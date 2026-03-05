import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWordPressInstall } from "../src/adapters/wordpress/install.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeWpFiles(): GeneratedFile[] {
  return [
    makeFile("wordpress/w2agent-plugin.php", "<?php /* Plugin */"),
    makeFile("wordpress/data/llms.txt", "# LLMs"),
    makeFile("wordpress/data/agent-card.json", "{}"),
    makeFile("wordpress/data/robots-rules.txt", "# rules"),
    makeFile("wordpress/INSTALL.md", "# Install"),
  ];
}

describe("WordPress install resolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-wp-install-"));
    mkdirSync(join(tempDir, "wp-content", "plugins"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("installs plugin files to wp-content/plugins/w2agent/", () => {
    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests).toContain("wp-content/plugins/w2agent/w2agent-plugin.php");
    expect(dests).toContain("wp-content/plugins/w2agent/data/llms.txt");
    expect(dests).toContain("wp-content/plugins/w2agent/data/agent-card.json");
    expect(dests).toContain("wp-content/plugins/w2agent/data/robots-rules.txt");
    expect(plan.postInstallSteps.some((s) => s.includes("Activate"))).toBe(true);
  });

  it("warns when not in WP root but still writes", () => {
    const nonWpDir = mkdtempSync(join(tmpdir(), "w2agent-wp-nonroot-"));
    try {
      const plan = resolveWordPressInstall(makeWpFiles(), nonWpDir);
      expect(plan.warnings.some((w) => w.includes("Not a WordPress root"))).toBe(true);
      // Still writes files
      const writes = plan.actions.filter((a) => a.type === "write");
      expect(writes.length).toBeGreaterThan(0);
    } finally {
      rmSync(nonWpDir, { recursive: true, force: true });
    }
  });

  it("skips when plugin already exists", () => {
    mkdirSync(join(tempDir, "wp-content", "plugins", "w2agent"), { recursive: true });
    writeFileSync(
      join(tempDir, "wp-content", "plugins", "w2agent", "w2agent-plugin.php"),
      "<?php",
      "utf-8",
    );

    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    expect(plan.actions.length).toBe(0);
    expect(plan.warnings.some((w) => w.includes("already exists"))).toBe(true);
  });

  it("skips INSTALL.md", () => {
    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    const dests = plan.actions.map((a) => a.dest);
    expect(dests.some((d) => d.includes("INSTALL.md"))).toBe(false);
  });

  it("uses custom WP_PLUGIN_DIR from wp-config.php", () => {
    writeFileSync(
      join(tempDir, "wp-config.php"),
      "<?php\ndefine('WP_PLUGIN_DIR', 'custom-plugins');\n",
      "utf-8",
    );
    mkdirSync(join(tempDir, "custom-plugins"), { recursive: true });

    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests[0]).toContain("custom-plugins/w2agent/");
    expect(dests.every((d) => d.startsWith("custom-plugins/w2agent/"))).toBe(true);
  });

  it("suggests activating plugin as post-install step", () => {
    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    expect(plan.postInstallSteps.some((s) => s.includes("Activate"))).toBe(true);
  });

  it("returns no actions when plugin already exists", () => {
    mkdirSync(join(tempDir, "wp-content", "plugins", "w2agent"), { recursive: true });
    writeFileSync(
      join(tempDir, "wp-content", "plugins", "w2agent", "w2agent-plugin.php"),
      "<?php",
      "utf-8",
    );

    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    expect(plan.actions.length).toBe(0);
    expect(plan.postInstallSteps.length).toBe(0);
  });
});
