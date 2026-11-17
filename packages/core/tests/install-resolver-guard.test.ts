import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { astroAdapter } from "../src/adapters/astro/index.js";
import { docusaurusAdapter } from "../src/adapters/docusaurus/index.js";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import { nuxtAdapter } from "../src/adapters/nuxt/index.js";
import { shopifyAdapter } from "../src/adapters/shopify/index.js";
import { wordpressAdapter } from "../src/adapters/wordpress/index.js";
import type { GeneratedFile } from "../src/generate/types.js";
import { executeInstallPlan } from "../src/install/executor.js";
import { planInstall } from "../src/install/planner.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

describe("resolver steps follow the guarded actions", () => {
  let tempDir: string;
  let outside: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-resolver-guard-"));
    outside = mkdtempSync(join(tmpdir(), "w2agent-resolver-outside-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  describe("Next.js", () => {
    const files = [
      makeFile("nextjs/middleware.ts", "export function middleware() {}"),
      makeFile("nextjs/w2agent-build.mjs", "// build"),
      makeFile("nextjs/app/llms.txt/route.ts", "export async function GET() {}"),
    ];

    beforeEach(() => {
      mkdirSync(join(tempDir, "app"), { recursive: true });
      writeFileSync(join(tempDir, "package.json"), '{"dependencies":{"next":"15.0.0"}}');
    });

    it("prints no postbuild step when a sibling build script makes the guard skip the write", () => {
      writeFileSync(join(tempDir, "w2agent-build.js"), "// mine");

      const plan = planInstall(nextjsAdapter, files, tempDir);

      expect(plan.actions.some((a) => a.type === "write" && a.dest === "w2agent-build.mjs")).toBe(
        false,
      );
      expect(plan.postInstallSteps.some((s) => s.includes("postbuild"))).toBe(false);
      expect(plan.warnings.filter((w) => w.includes("w2agent-build.mjs"))).toHaveLength(1);
    });

    it("keeps the postbuild step when the build script is written", () => {
      const plan = planInstall(nextjsAdapter, files, tempDir);

      expect(plan.postInstallSteps.some((s) => s.includes("postbuild"))).toBe(true);
    });

    it("does not tell the user to merge from a stale middleware.w2agent.ts that was skipped", () => {
      writeFileSync(join(tempDir, "middleware.ts"), "export function middleware() { /* auth */ }");
      writeFileSync(join(tempDir, "middleware.w2agent.ts"), "// stale, different content");

      const plan = planInstall(nextjsAdapter, files, tempDir);

      const text = [
        ...plan.warnings,
        ...plan.actions.filter((a) => a.type === "manual").map((a) => a.reason ?? ""),
      ];
      expect(text.some((t) => t.includes("Merge the content from"))).toBe(false);
      expect(text.some((t) => t.includes("saved as"))).toBe(false);
      expect(plan.warnings.some((w) => w.includes("middleware.w2agent.ts"))).toBe(true);
      expect(readFileSync(join(tempDir, "middleware.w2agent.ts"), "utf-8")).toBe(
        "// stale, different content",
      );
    });

    it("keeps the merge text when middleware.w2agent.ts is written", () => {
      writeFileSync(join(tempDir, "middleware.ts"), "export function middleware() { /* auth */ }");

      const plan = planInstall(nextjsAdapter, files, tempDir);

      expect(
        plan.actions.some(
          (a) => a.type === "manual" && a.reason?.includes("middleware.w2agent.ts"),
        ),
      ).toBe(true);
      expect(plan.warnings.some((w) => w.includes("Merge manually"))).toBe(true);
    });

    it("keeps the merge text when the existing middleware.w2agent.ts is byte-identical", () => {
      writeFileSync(join(tempDir, "middleware.ts"), "export function middleware() { /* auth */ }");
      writeFileSync(join(tempDir, "middleware.w2agent.ts"), "export function middleware() {}");

      const plan = planInstall(nextjsAdapter, files, tempDir);

      expect(
        plan.actions.some(
          (a) => a.type === "manual" && a.reason?.includes("middleware.w2agent.ts"),
        ),
      ).toBe(true);
    });

    it("skips a route that collides with public/index.md and leaves the public file untouched", () => {
      mkdirSync(join(tempDir, "public"), { recursive: true });
      writeFileSync(join(tempDir, "public", "index.md"), "# mine");
      const plan = planInstall(
        nextjsAdapter,
        [makeFile("nextjs/app/index.md/route.ts", "export async function GET() {}")],
        tempDir,
      );

      expect(plan.actions.some((a) => a.type === "write")).toBe(false);
      expect(
        plan.actions.some((a) => a.type === "skip" && a.dest === "app/index.md/route.ts"),
      ).toBe(true);
      expect(plan.actions.some((a) => a.type === "manual" && a.dest === "public/index.md")).toBe(
        true,
      );
      executeInstallPlan(plan, tempDir);
      expect(readFileSync(join(tempDir, "public", "index.md"), "utf-8")).toBe("# mine");
    });
  });

  it("Nuxt: no prebuild step when a sibling build script blocks the write", () => {
    writeFileSync(join(tempDir, "w2agent-build.js"), "// mine");

    const plan = planInstall(nuxtAdapter, [makeFile("nuxt/w2agent-build.mjs")], tempDir);

    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
    expect(plan.postInstallSteps.some((s) => s.includes("prebuild"))).toBe(false);
  });

  it("Nuxt: a stale middleware copy is not offered for merging", () => {
    mkdirSync(join(tempDir, "server", "middleware"), { recursive: true });
    writeFileSync(join(tempDir, "server", "middleware", "content-negotiation.ts"), "// auth");
    writeFileSync(
      join(tempDir, "server", "middleware", "content-negotiation.w2agent.ts"),
      "// old",
    );

    const plan = planInstall(
      nuxtAdapter,
      [makeFile("nuxt/server/middleware/content-negotiation.ts", "// new")],
      tempDir,
    );

    expect(plan.warnings.some((w) => w.includes("Merge manually"))).toBe(false);
    expect(plan.warnings.some((w) => w.includes("content-negotiation.w2agent.ts"))).toBe(true);
  });

  it("Astro: no integration step when a sibling integration file blocks the write", () => {
    writeFileSync(join(tempDir, "w2agent-integration.js"), "// mine");

    const plan = planInstall(astroAdapter, [makeFile("astro/w2agent-integration.mjs")], tempDir);

    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
    expect(plan.postInstallSteps.some((s) => s.includes("integration"))).toBe(false);
  });

  it("Docusaurus: no plugin step when a sibling plugin file blocks the write", () => {
    writeFileSync(join(tempDir, "w2agent-plugin.ts"), "// mine");

    const plan = planInstall(
      docusaurusAdapter,
      [makeFile("docusaurus/w2agent-plugin.js")],
      tempDir,
    );

    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
    expect(plan.postInstallSteps.some((s) => s.includes("plugins:"))).toBe(false);
  });

  it("Shopify: no render step when the snippet write is blocked", () => {
    symlinkSync(outside, join(tempDir, "snippets"));

    const plan = planInstall(
      shopifyAdapter,
      [makeFile("shopify/snippets/w2agent-head.liquid", "{% comment %}x{% endcomment %}")],
      tempDir,
    );

    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
    expect(plan.postInstallSteps.some((s) => s.includes("render"))).toBe(false);
  });

  it("Shopify: no robots merge step when the additions file is not written", () => {
    mkdirSync(join(tempDir, "templates"), { recursive: true });
    writeFileSync(join(tempDir, "templates", "robots.txt.liquid"), "mine");
    symlinkSync(outside, join(tempDir, "data"));

    const plan = planInstall(
      shopifyAdapter,
      [
        makeFile("shopify/templates/robots.txt.liquid", "new"),
        makeFile("shopify/data/robots-txt-additions.txt", "# additions"),
      ],
      tempDir,
    );

    expect(plan.postInstallSteps.some((s) => s.includes("robots-txt-additions"))).toBe(false);
  });

  it("WordPress: no activate step when nothing is written", () => {
    mkdirSync(join(tempDir, "wp-content"), { recursive: true });
    symlinkSync(outside, join(tempDir, "wp-content", "plugins"));

    const plan = planInstall(
      wordpressAdapter,
      [makeFile("wordpress/w2agent.php", "<?php")],
      tempDir,
    );

    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
    expect(plan.postInstallSteps).toHaveLength(0);
  });
});
