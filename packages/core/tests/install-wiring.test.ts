import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { planInstall } from "../src/install/planner.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

const robots = makeFile("robots.txt", "User-agent: GPTBot\nAllow: /\n");

describe("robots.txt manual action", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-wiring-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const robotsManual = (plan: ReturnType<typeof planInstall>) =>
    plan.actions.filter((a) => a.type === "manual" && a.dest === "robots.txt");

  const cases: Array<[string, Parameters<typeof planInstall>[0], string]> = [
    ["nextjs", nextjsAdapter, "nextjs/app/llms.txt/route.ts"],
    ["nuxt", nuxtAdapter, "nuxt/server/routes/llms.txt.ts"],
    ["astro", astroAdapter, "astro/public/llms.txt"],
    ["docusaurus", docusaurusAdapter, "docusaurus/static/llms.txt"],
  ];

  for (const [name, adapter, file] of cases) {
    it(`${name}: one manual action, no robots file written`, () => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
      const plan = planInstall(adapter, [robots, makeFile(file)], dir);
      const manual = robotsManual(plan);
      expect(manual).toHaveLength(1);
      expect(manual[0].reason).toContain("not installed");
      expect(manual[0].reason).toContain("--output");
      expect(plan.actions.some((a) => a.type === "write" && a.dest.endsWith("robots.txt"))).toBe(
        false,
      );
    });
  }

  it("wordpress: planned robots-rules suppresses the manual action", () => {
    mkdirSync(join(dir, "wp-content"), { recursive: true });
    writeFileSync(join(dir, "wp-config.php"), "<?php\n");
    const plan = planInstall(
      wordpressAdapter,
      [
        robots,
        makeFile("wordpress/w2agent/data/robots-rules.txt", "x"),
        makeFile("wordpress/w2agent/w2agent.php", "<?php"),
      ],
      dir,
    );
    expect(plan.actions.some((a) => a.dest.endsWith("robots-rules.txt"))).toBe(true);
    expect(robotsManual(plan)).toHaveLength(0);
  });

  it("shopify: planned robots.txt.liquid suppresses the manual action", () => {
    mkdirSync(join(dir, "templates"), { recursive: true });
    const plan = planInstall(
      shopifyAdapter,
      [robots, makeFile("shopify/templates/robots.txt.liquid", "{{ x }}")],
      dir,
    );
    expect(plan.actions.some((a) => a.dest === "templates/robots.txt.liquid")).toBe(true);
    expect(robotsManual(plan)).toHaveLength(0);
  });

  it("no manual action when the plan has no actions (refused plan)", () => {
    const plan = planInstall(nextjsAdapter, [robots, makeFile("nextjs/middleware.ts")], dir);
    expect(plan.actions).toHaveLength(0);
    expect(robotsManual(plan)).toHaveLength(0);
  });

  it("no manual action when no robots.txt was generated", () => {
    const plan = planInstall(astroAdapter, [makeFile("astro/public/llms.txt")], dir);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(robotsManual(plan)).toHaveLength(0);
  });
});

describe("Astro WebMcpScript and build script wiring", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-astro-wiring-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const files = [
    makeFile("astro/src/components/WebMcpScript.astro", "---\n---\n<script></script>"),
    makeFile("astro/w2agent-build.mjs", "// build"),
  ];

  it("installs the component under src/ and names the mount step", () => {
    const plan = planInstall(astroAdapter, files, dir);
    expect(
      plan.actions.some(
        (a) => a.type === "write" && a.dest === "src/components/WebMcpScript.astro",
      ),
    ).toBe(true);
    const step = plan.postInstallSteps.find((s) => s.includes("WebMcpScript"));
    expect(step).toContain("src/components/WebMcpScript.astro");
    expect(step).toContain("<WebMcpScript />");
  });

  it("adds the prebuild step when the build script is written", () => {
    const plan = planInstall(astroAdapter, files, dir);
    expect(
      plan.postInstallSteps.some((s) => s.includes('"prebuild": "node w2agent-build.mjs"')),
    ).toBe(true);
  });

  it("no mount step when the component already exists", () => {
    mkdirSync(join(dir, "src", "components"), { recursive: true });
    writeFileSync(join(dir, "src", "components", "WebMcpScript.astro"), "mine");
    const plan = planInstall(astroAdapter, files, dir);
    expect(plan.postInstallSteps.some((s) => s.includes("WebMcpScript"))).toBe(false);
  });

  it("no prebuild step when the build script already exists", () => {
    writeFileSync(join(dir, "w2agent-build.mjs"), "mine");
    const plan = planInstall(astroAdapter, files, dir);
    expect(plan.postInstallSteps.some((s) => s.includes("prebuild"))).toBe(false);
  });
});
