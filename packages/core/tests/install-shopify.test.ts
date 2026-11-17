import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveShopifyInstall } from "../src/adapters/shopify/install.js";
import type { GeneratedFile } from "../src/generate/types.js";
import { executeInstallPlan } from "../src/install/executor.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeShopifyFiles(): GeneratedFile[] {
  return [
    makeFile("shopify/snippets/w2agent-head.liquid", "{% comment %}w2agent{% endcomment %}"),
    makeFile("shopify/snippets/w2agent-webmcp.liquid", "<script>1</script>"),
    makeFile("shopify/templates/llms.txt.liquid", "# LLMs"),
    makeFile("shopify/data/robots-txt-additions.txt", "# additions"),
    makeFile("shopify/W2AGENT-MCP-WEBHOOK.md", "# Webhook"),
    makeFile("shopify/INSTALL.md", "# Install"),
  ];
}

const THEME_DIRS = [
  "assets",
  "blocks",
  "config",
  "layout",
  "locales",
  "sections",
  "snippets",
  "templates",
];

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

  it("writes only the two snippets, all inside theme directories", () => {
    const plan = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests.sort()).toEqual([
      "snippets/w2agent-head.liquid",
      "snippets/w2agent-webmcp.liquid",
    ]);
    for (const d of dests) expect(THEME_DIRS).toContain(d.split("/")[0]);
  });

  it("reports the three non-theme files as manual actions that say where to get them", () => {
    const plan = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    const manual = plan.actions.filter((a) => a.type === "manual");

    expect(manual.map((a) => a.dest).sort()).toEqual([
      "W2AGENT-MCP-WEBHOOK.md",
      "data/robots-txt-additions.txt",
      "templates/llms.txt.liquid",
    ]);
    for (const a of manual.filter((m) => m.dest !== "W2AGENT-MCP-WEBHOOK.md")) {
      expect(a.reason).toContain("w2agent integrate <url> --platform shopify --output <dir>");
    }
    const llms = manual.find((a) => a.dest === "templates/llms.txt.liquid");
    expect(llms?.reason).toMatch(/Optional/);
    expect(llms?.reason).toContain("/llms.txt");
    const robots = manual.find((a) => a.dest === "data/robots-txt-additions.txt");
    expect(robots?.reason).toContain("end of your theme's existing templates/robots.txt.liquid");
    expect(robots?.reason).toContain("do not create one");
  });

  it("emits manual actions only for generated files", () => {
    const files = makeShopifyFiles().filter(
      (f) => f.filename.includes("snippets/w2agent-head") || f.filename.endsWith("INSTALL.md"),
    );
    const plan = resolveShopifyInstall(files, tempDir);
    expect(plan.actions.filter((a) => a.type === "manual")).toEqual([]);
  });

  it("never writes data/, a markdown file, or a template into the theme", () => {
    const plan = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    const result = executeInstallPlan(plan, tempDir);

    expect(result.installed.sort()).toEqual([
      "snippets/w2agent-head.liquid",
      "snippets/w2agent-webmcp.liquid",
    ]);
    expect(plan.actions.some((a) => a.type === "write" && a.dest.startsWith("data/"))).toBe(false);
    expect(plan.actions.some((a) => a.type === "write" && a.dest.endsWith(".md"))).toBe(false);
    expect(plan.actions.some((a) => a.type === "write" && a.dest.startsWith("templates/"))).toBe(
      false,
    );
  });

  it("post-install steps: render head, render webmcp before </body>, push exactly the written files", () => {
    const plan = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    const steps = plan.postInstallSteps;

    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain("{% render 'w2agent-head' %}");
    expect(steps[1]).toContain("{% render 'w2agent-webmcp' %}");
    expect(steps[1]).toContain("before </body>");
    expect(steps[2]).toContain("shopify theme push");
    const command = steps[2].split(" To push your other edits")[0];
    const only = [...command.matchAll(/--only (\S+)/g)].map((m) => m[1].replace(/\.$/, ""));
    expect(only.sort()).toEqual([
      "layout/theme.liquid",
      "snippets/w2agent-head.liquid",
      "snippets/w2agent-webmcp.liquid",
    ]);
    expect(steps[2]).not.toMatch(/--live|--publish/);
    expect(steps[2]).toContain("--theme <copy-theme-id-or-name>");
    for (const s of steps) {
      expect(s).not.toContain("data/");
      expect(s).not.toContain("W2AGENT-MCP-WEBHOOK");
    }
  });

  it("push step tells the owner which --only to add for a pasted robots file or an added llms template", () => {
    const steps = resolveShopifyInstall(makeShopifyFiles(), tempDir).postInstallSteps;
    expect(steps[2]).toContain("add --only templates/robots.txt.liquid");
    expect(steps[2]).toContain("add --only templates/llms.txt.liquid");

    const noRobots = makeShopifyFiles().filter((f) => !f.filename.includes("robots"));
    const s1 = resolveShopifyInstall(noRobots, tempDir).postInstallSteps[2];
    expect(s1).toContain("templates/llms.txt.liquid");
    expect(s1).not.toContain("robots");

    const noLlms = makeShopifyFiles().filter((f) => !f.filename.includes("llms.txt"));
    const s2 = resolveShopifyInstall(noLlms, tempDir).postInstallSteps[2];
    expect(s2).toContain("templates/robots.txt.liquid");
    expect(s2).not.toContain("llms.txt.liquid");
  });

  it("webhook notes manual action names the command that writes it", () => {
    const plan = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    const hook = plan.actions.find((a) => a.dest === "W2AGENT-MCP-WEBHOOK.md");
    expect(hook).toMatchObject({ type: "manual" });
    expect((hook as { reason: string }).reason).toContain("--format mcp-server");
    expect((hook as { reason: string }).reason).not.toContain("integrate");
  });

  it("has no webmcp step and no webmcp push entry when no webmcp snippet is generated", () => {
    const files = makeShopifyFiles().filter((f) => !f.filename.includes("webmcp"));
    const plan = resolveShopifyInstall(files, tempDir);

    expect(plan.postInstallSteps.some((s) => s.includes("webmcp"))).toBe(false);
    expect(plan.postInstallSteps.some((s) => s.includes("shopify theme push"))).toBe(true);
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

  it("re-run reports both unchanged snippets as already up to date (a success, not a failure) with no render or push steps", () => {
    const first = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    executeInstallPlan(first, tempDir);

    const again = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    for (const dest of ["snippets/w2agent-head.liquid", "snippets/w2agent-webmcp.liquid"]) {
      const action = again.actions.find((a) => a.dest === dest);
      expect(action?.type).toBe("skip");
      expect(action?.reason).toBe("already up to date");
    }
    expect(again.actions.some((a) => a.type === "write")).toBe(false);
    expect(again.postInstallSteps).toEqual([]);
  });

  it("skips an existing webmcp snippet with different content without touching it", () => {
    mkdirSync(join(tempDir, "snippets"), { recursive: true });
    writeFileSync(join(tempDir, "snippets", "w2agent-webmcp.liquid"), "owner edit", "utf-8");

    const plan = resolveShopifyInstall(makeShopifyFiles(), tempDir);
    const result = executeInstallPlan(plan, tempDir);

    expect(plan.actions.find((a) => a.dest === "snippets/w2agent-webmcp.liquid")?.type).toBe(
      "skip",
    );
    expect(result.installed).toEqual(["snippets/w2agent-head.liquid"]);
    expect(
      plan.warnings.some((w) => w.includes("snippets/w2agent-webmcp.liquid already exists")),
    ).toBe(true);
    expect(plan.postInstallSteps.some((s) => s.includes("w2agent-webmcp"))).toBe(false);
  });

  it("never writes or replaces templates/robots.txt.liquid", () => {
    for (const existing of [false, true]) {
      if (existing) {
        mkdirSync(join(tempDir, "templates"), { recursive: true });
        writeFileSync(join(tempDir, "templates", "robots.txt.liquid"), "owner rules", "utf-8");
      }
      const plan = resolveShopifyInstall(makeShopifyFiles(), tempDir);
      expect(plan.actions.some((a) => a.dest === "templates/robots.txt.liquid")).toBe(false);
    }
  });

  it("has no robots manual action when the additions file is not generated", () => {
    const files = makeShopifyFiles().filter(
      (f) => !f.filename.endsWith("robots-txt-additions.txt"),
    );
    const plan = resolveShopifyInstall(files, tempDir);
    expect(plan.actions.some((a) => a.dest.includes("robots"))).toBe(false);
  });
});
