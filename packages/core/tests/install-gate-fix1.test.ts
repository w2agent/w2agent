import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docusaurusAdapter } from "../src/adapters/docusaurus/index.js";
import { wordpressAdapter } from "../src/adapters/wordpress/index.js";
import { resolveWordPressInstall } from "../src/adapters/wordpress/install.js";
import type { GeneratedFile } from "../src/generate/types.js";
import { executeInstallPlan, formatInstallSummary } from "../src/install/executor.js";
import { planInstall } from "../src/install/planner.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

const wpFiles = [
  makeFile("robots.txt", "User-agent: GPTBot\nAllow: /\n"),
  makeFile("wordpress/w2agent-plugin.php", "<?php"),
  makeFile("wordpress/data/robots-rules.txt", "# rules"),
];

describe("gate fix round 1", () => {
  let dir: string;
  let other: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-gate1-"));
    other = mkdtempSync(join(tmpdir(), "w2agent-gate1-other-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  const setConfig = (body: string, at = dir) =>
    writeFileSync(join(at, "wp-config.php"), `<?php\n${body}\n`);

  it("1: refused WordPress plan gets no robots manual action", () => {
    setConfig(`define('WP_PLUGIN_DIR', '${other}');`);
    const plan = planInstall(wordpressAdapter, wpFiles, dir);
    expect(plan.actions.some((a) => a.dest === "wp-config.php")).toBe(true);
    expect(plan.actions.some((a) => a.dest === "robots.txt")).toBe(false);
  });

  it("3: symlinked project dir with a real absolute WP_PLUGIN_DIR plans inside", () => {
    const real = mkdtempSync(join(tmpdir(), "w2agent-gate1-real-"));
    const link = join(dir, "link");
    try {
      symlinkSync(real, link);
      setConfig(`define('WP_PLUGIN_DIR', '${realpathSync(real)}/custom');`, real);
      const plan = resolveWordPressInstall(wpFiles, link);
      const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
      expect(dests.length).toBeGreaterThan(0);
      expect(dests.every((d) => d.startsWith("custom/w2agent/"))).toBe(true);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("3: a WP_PLUGIN_DIR through an in-project symlink to outside is refused", () => {
    symlinkSync(other, join(dir, "esc"));
    setConfig("define('WP_PLUGIN_DIR', 'esc/plugins');");
    const plan = resolveWordPressInstall(wpFiles, dir);
    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
    expect(plan.actions.some((a) => a.type === "manual")).toBe(true);
  });

  it("4: define text inside a PHP string is not read as code", () => {
    setConfig(`$note = "define('WP_PLUGIN_DIR','fake')"; define('WP_PLUGIN_DIR','../outside');`);
    const plan = resolveWordPressInstall(wpFiles, dir);
    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
    expect(plan.warnings.some((w) => w.includes("outside the project directory"))).toBe(true);
  });

  it("4: a string-only define never sets the dir", () => {
    setConfig(`$note = 'define("WP_PLUGIN_DIR", "fake")';`);
    const plan = resolveWordPressInstall(wpFiles, dir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
    expect(dests.every((d) => d.startsWith("wp-content/plugins/w2agent/"))).toBe(true);
  });

  it("4: a define for another constant is not read as WP_PLUGIN_DIR", () => {
    setConfig("define('WP_HOME', '../outside');");
    const plan = resolveWordPressInstall(wpFiles, dir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
    expect(dests.length).toBeGreaterThan(0);
    expect(dests.every((d) => d.startsWith("wp-content/plugins/w2agent/"))).toBe(true);
  });

  it("5: WP_PLUGIN_DIR '.' means the project root", () => {
    setConfig("define('WP_PLUGIN_DIR', '.');");
    const plan = resolveWordPressInstall(wpFiles, dir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
    expect(dests.length).toBeGreaterThan(0);
    expect(dests.every((d) => d.startsWith("w2agent/"))).toBe(true);
  });

  it("6: no gray-matter step when the plugin write was guarded out", () => {
    writeFileSync(join(dir, "w2agent-plugin.ts"), "// mine");
    const plan = planInstall(docusaurusAdapter, [makeFile("docusaurus/w2agent-plugin.js")], dir);
    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
    expect(plan.postInstallSteps.some((s) => s.includes("gray-matter"))).toBe(false);
  });

  it("6: gray-matter step stays when the plugin is written", () => {
    const plan = planInstall(docusaurusAdapter, [makeFile("docusaurus/w2agent-plugin.js")], dir);
    expect(plan.postInstallSteps.some((s) => s.includes("gray-matter"))).toBe(true);
  });

  it("2: executor reports fs write failures and the summary withdraws post-install steps", () => {
    mkdirSync(join(dir, "ro"));
    chmodSync(join(dir, "ro"), 0o500);
    const plan = {
      platform: "nuxt" as const,
      actions: [{ type: "write" as const, dest: "ro/x.mjs", content: "x" }],
      warnings: [],
      postInstallSteps: ["Add postbuild"],
    };
    const result = executeInstallPlan(plan, dir);
    chmodSync(join(dir, "ro"), 0o700);
    expect(result.failed).toHaveLength(1);
    const text = formatInstallSummary(plan, result, dir, "https://x.test", "Nuxt");
    expect(text).toContain("do not apply");
  });

  it("2: no failure and an untouched summary when writes succeed", () => {
    const plan = {
      platform: "nuxt" as const,
      actions: [{ type: "write" as const, dest: "a.txt", content: "x" }],
      warnings: [],
      postInstallSteps: ["Add postbuild"],
    };
    const result = executeInstallPlan(plan, dir);
    expect(result.failed).toEqual([]);
    expect(formatInstallSummary(plan, result, dir, "https://x.test", "Nuxt")).not.toContain(
      "do not apply",
    );
  });

  it("r2-1: '..' after a symlink segment applies to the real parent", () => {
    const deep = join(other, "deep");
    mkdirSync(deep);
    symlinkSync(deep, join(dir, "esc"));
    setConfig("define('WP_PLUGIN_DIR', 'esc/../plugins');");
    const plan = resolveWordPressInstall(wpFiles, dir);
    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
    expect(plan.warnings.some((w) => w.includes("outside the project directory"))).toBe(true);
  });

  it("r2-1: '..' inside the project still resolves to a relative dir", () => {
    mkdirSync(join(dir, "a"));
    setConfig("define('WP_PLUGIN_DIR', 'a/../plugins');");
    const plan = resolveWordPressInstall(wpFiles, dir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
    expect(dests.length).toBeGreaterThan(0);
    expect(dests.every((d) => d.startsWith("plugins/w2agent/"))).toBe(true);
  });

  it("r2-2: interpolation with a nested quote does not end the string early", () => {
    setConfig(
      `$note = "{$a["define('WP_PLUGIN_DIR','fake')"]}"; define('WP_PLUGIN_DIR','../outside');`,
    );
    const plan = resolveWordPressInstall(wpFiles, dir);
    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
    expect(plan.actions.some((a) => a.type === "manual")).toBe(true);
  });

  it("r2-2: a heredoc with interpolation next to WP_PLUGIN_DIR plans no writes", () => {
    setConfig("$x = <<<EOT\n${y} {$z}\nEOT;\ndefine('WP_PLUGIN_DIR', 'custom');");
    const plan = resolveWordPressInstall(wpFiles, dir);
    expect(plan.actions.some((a) => a.type === "write")).toBe(false);
  });

  it("r2-2: interpolation without WP_PLUGIN_DIR does not block the install", () => {
    setConfig('$x = "{$y}";');
    const plan = resolveWordPressInstall(wpFiles, dir);
    expect(plan.actions.some((a) => a.type === "write")).toBe(true);
  });

  it("r2-3: an execute-time guard failure is recorded as failed", () => {
    const plan = {
      platform: "nuxt" as const,
      actions: [
        { type: "write" as const, dest: "../x.txt", content: "x" },
        { type: "write" as const, dest: "ok.txt", content: "x" },
      ],
      warnings: [],
      postInstallSteps: ["Add postbuild"],
    };
    const result = executeInstallPlan(plan, dir);
    expect(result.installed).toEqual(["ok.txt"]);
    expect(result.failed).toEqual(["../x.txt"]);
  });
});
