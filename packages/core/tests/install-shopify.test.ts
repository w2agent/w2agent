import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveShopifyInstall } from "../src/adapters/shopify/install.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeShopifyFiles(): GeneratedFile[] {
  return [
    makeFile("shopify/snippets/w2agent-head.liquid", "{% comment %}w2agent{% endcomment %}"),
    makeFile("shopify/templates/robots.txt.liquid", "User-agent: *"),
    makeFile("shopify/data/llms.txt", "# LLMs"),
    makeFile("shopify/data/robots-txt-additions.txt", "# additions"),
    makeFile("shopify/INSTALL.md", "# Install"),
  ];
}

describe("Shopify install resolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-shopify-install-"));
    mkdirSync(join(tempDir, "layout"), { recursive: true });
    writeFileSync(join(tempDir, "layout", "theme.liquid"), "<html></html>", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("installs snippets and templates in a theme dir", () => {
    const plan = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests).toContain("snippets/w2agent-head.liquid");
    expect(dests).toContain("templates/robots.txt.liquid");
    expect(dests).toContain("data/llms.txt");
    expect(dests).toContain("data/robots-txt-additions.txt");
    expect(plan.postInstallSteps.some((s) => s.includes("render"))).toBe(true);
  });

  it("warns when not in theme dir", () => {
    const nonThemeDir = mkdtempSync(join(tmpdir(), "w2agent-shopify-nontheme-"));
    try {
      const plan = resolveShopifyInstall(makeShopifyFiles(), nonThemeDir);
      expect(plan.warnings.some((w) => w.includes("Not a Shopify theme"))).toBe(true);
    } finally {
      rmSync(nonThemeDir, { recursive: true, force: true });
    }
  });

  it("skips existing head snippet", () => {
    mkdirSync(join(tempDir, "snippets"), { recursive: true });
    writeFileSync(
      join(tempDir, "snippets", "w2agent-head.liquid"),
      "{% comment %}existing{% endcomment %}",
      "utf-8",
    );

    const plan = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    const skipped = plan.actions.find(
      (a) => a.type === "skip" && a.dest === "snippets/w2agent-head.liquid",
    );
    expect(skipped).toBeDefined();
  });

  it("skips existing robots.txt.liquid with merge instructions", () => {
    mkdirSync(join(tempDir, "templates"), { recursive: true });
    writeFileSync(
      join(tempDir, "templates", "robots.txt.liquid"),
      "User-agent: *\nDisallow: /admin",
      "utf-8",
    );

    const plan = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    const skipped = plan.actions.find(
      (a) => a.type === "skip" && a.dest === "templates/robots.txt.liquid",
    );
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toContain("merge");
    expect(plan.postInstallSteps.some((s) => s.includes("Merge"))).toBe(true);
  });
});
