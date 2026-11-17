import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectWordPressLayout,
  resolveWordPressInstall,
} from "../src/adapters/wordpress/install.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeWpFiles(): GeneratedFile[] {
  return [
    makeFile("wordpress/w2agent-plugin.php", "<?php /* Plugin */"),
    makeFile("wordpress/data/llms.txt", "# LLMs"),
    makeFile("wordpress/data/agent-card.json", "{}"),
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

  it("installs plugin files to wp-content/plugins/w2agent-site/", () => {
    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests).toContain("wp-content/plugins/w2agent-site/w2agent-plugin.php");
    expect(dests).toContain("wp-content/plugins/w2agent-site/data/llms.txt");
    expect(dests).toContain("wp-content/plugins/w2agent-site/data/agent-card.json");
    expect(plan.postInstallSteps.some((s) => s.includes("Activate"))).toBe(true);
  });

  it("adds a manual robots.txt action only when a physical robots.txt exists", () => {
    const manual = (plan: ReturnType<typeof resolveWordPressInstall>) =>
      plan.actions.filter((a) => a.type === "manual" && a.dest === "robots.txt");
    expect(manual(resolveWordPressInstall(makeWpFiles(), tempDir))).toHaveLength(0);

    writeFileSync(join(tempDir, "robots.txt"), "User-agent: *\nDisallow: /\n");
    const found = manual(resolveWordPressInstall(makeWpFiles(), tempDir));
    expect(found).toHaveLength(1);
    const reason = found[0].type === "manual" ? found[0].reason : "";
    expect(reason).toContain("physical robots.txt");
    expect(reason).toContain("never runs");
    expect(reason).toContain("--output");
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
    mkdirSync(join(tempDir, "wp-content", "plugins", "w2agent-site"), { recursive: true });
    writeFileSync(
      join(tempDir, "wp-content", "plugins", "w2agent-site", "w2agent-plugin.php"),
      "<?php",
      "utf-8",
    );

    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    expect(plan.actions.length).toBe(0);
    expect(plan.warnings.some((w) => w.includes("already exists"))).toBe(true);
  });

  function writeFolderPlugin(folder: string, source: string) {
    const dir = join(tempDir, "wp-content", "plugins", folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "w2agent-plugin.php"), source, "utf-8");
  }

  it("installs beside the standalone plugin that sits in w2agent/", () => {
    writeFolderPlugin(
      "w2agent",
      "<?php\n/**\n * Plugin Name: w2agent — AI Agent Discoverability\n */\n",
    );
    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
    expect(dests.length).toBeGreaterThan(0);
    expect(dests.every((d) => d.startsWith("wp-content/plugins/w2agent-site/"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("older generated"))).toBe(false);
  });

  it("writes nothing and warns when an older generated plugin sits in w2agent/", () => {
    for (const marker of [
      "<?php\ndefine('W2AGENT_PLUGIN_DIR', plugin_dir_path(__FILE__));\n",
      "<?php\n/**\n * Plugin Name: w2agent — AI Readiness\n */\n",
    ]) {
      writeFolderPlugin("w2agent", marker);
      const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
      expect(plan.actions).toEqual([]);
      expect(plan.postInstallSteps).toEqual([]);
      expect(
        plan.warnings.some((w) => w.includes("older generated") && w.includes("w2agent/")),
      ).toBe(true);
    }
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

    expect(dests[0]).toContain("custom-plugins/w2agent-site/");
    expect(dests.every((d) => d.startsWith("custom-plugins/w2agent-site/"))).toBe(true);
  });

  it("suggests activating plugin as post-install step", () => {
    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    expect(plan.postInstallSteps.some((s) => s.includes("Activate"))).toBe(true);
  });

  it("returns no actions when plugin already exists", () => {
    mkdirSync(join(tempDir, "wp-content", "plugins", "w2agent-site"), { recursive: true });
    writeFileSync(
      join(tempDir, "wp-content", "plugins", "w2agent-site", "w2agent-plugin.php"),
      "<?php",
      "utf-8",
    );

    const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
    expect(plan.actions.length).toBe(0);
    expect(plan.postInstallSteps.length).toBe(0);
  });

  describe("WP_PLUGIN_DIR handling", () => {
    function setConfig(body: string) {
      writeFileSync(join(tempDir, "wp-config.php"), `<?php\n${body}\n`, "utf-8");
    }

    function expectDefaultDir(plan: ReturnType<typeof resolveWordPressInstall>) {
      const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
      expect(dests.length).toBeGreaterThan(0);
      expect(dests.every((d) => d.startsWith("wp-content/plugins/w2agent-site/"))).toBe(true);
    }

    function expectRefused(plan: ReturnType<typeof resolveWordPressInstall>) {
      expect(plan.actions.some((a) => a.type === "write")).toBe(false);
      const manual = plan.actions.find((a) => a.type === "manual");
      expect(manual?.reason).toContain("outside the project directory");
      expect(manual?.reason).toContain("--output");
      expect(plan.warnings.some((w) => w.includes("outside the project directory"))).toBe(true);
      expect(plan.postInstallSteps).toEqual([]);
    }

    it("refuses an absolute WP_PLUGIN_DIR outside the project", () => {
      const outside = mkdtempSync(join(tmpdir(), "w2agent-wp-outside-"));
      try {
        setConfig(`define('WP_PLUGIN_DIR', '${outside}');`);
        expectRefused(resolveWordPressInstall(makeWpFiles(), tempDir));
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("converts an absolute WP_PLUGIN_DIR inside the project to a relative path", () => {
      const abs = join(tempDir, "abs-plugins");
      setConfig(`define('WP_PLUGIN_DIR', "${abs}");`);
      const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
      const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
      expect(dests.length).toBeGreaterThan(0);
      expect(dests.every((d) => d.startsWith("abs-plugins/w2agent-site/"))).toBe(true);
    });

    it("refuses a relative WP_PLUGIN_DIR that escapes the project", () => {
      setConfig("define('WP_PLUGIN_DIR', '../outside');");
      expectRefused(resolveWordPressInstall(makeWpFiles(), tempDir));
    });

    it("ignores a commented-out WP_PLUGIN_DIR", () => {
      setConfig(
        [
          "// define('WP_PLUGIN_DIR', '../outside');",
          "# define('WP_PLUGIN_DIR', '/etc');",
          "/* define('WP_PLUGIN_DIR', 'custom'); */",
        ].join("\n"),
      );
      const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
      expectDefaultDir(plan);
      expect(plan.warnings).toEqual([]);
    });

    it("does not treat // inside a string as a comment", () => {
      setConfig("define('WP_HOME', 'http://example.test'); define('WP_PLUGIN_DIR', 'custom');");
      const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
      const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
      expect(dests.every((d) => d.startsWith("custom/w2agent-site/"))).toBe(true);
    });

    it("falls back to the default and warns on an expression value", () => {
      for (const value of [
        "dirname(__FILE__) . '/plugins'",
        "'a' . '/b'",
        "ABSPATH . 'plugins'",
        "SOME_CONSTANT",
        '"$base/plugins"',
      ]) {
        setConfig(`define('WP_PLUGIN_DIR', ${value});`);
        const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
        expectDefaultDir(plan);
        expect(plan.warnings.some((w) => w.includes("WP_PLUGIN_DIR") && w.includes("read"))).toBe(
          true,
        );
      }
    });

    it("checks for an existing plugin in the resolved custom directory", () => {
      setConfig("define('WP_PLUGIN_DIR', 'custom');");
      mkdirSync(join(tempDir, "custom", "w2agent-site"), { recursive: true });
      const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
      expect(plan.actions).toEqual([]);
      expect(plan.warnings.some((w) => w.includes("already exists"))).toBe(true);
    });

    it("reads define() and const forms case-insensitively and refuses outside values", () => {
      for (const body of [
        `DEFINE("WP_PLUGIN_DIR", "/etc/outside");`,
        `Define('WP_PLUGIN_DIR', '../outside');`,
        `const WP_PLUGIN_DIR = "/etc/outside";`,
      ]) {
        setConfig(body);
        expectRefused(resolveWordPressInstall(makeWpFiles(), tempDir));
      }
    });

    it("reads a const literal inside the project", () => {
      setConfig("const WP_PLUGIN_DIR = 'custom';");
      const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
      const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
      expect(dests.every((d) => d.startsWith("custom/w2agent-site/"))).toBe(true);
    });

    it("warns on non-literal const and uppercase DEFINE forms", () => {
      for (const body of [
        `const WP_PLUGIN_DIR = ABSPATH . 'p';`,
        `DEFINE('WP_PLUGIN_DIR', FOO);`,
      ]) {
        setConfig(body);
        const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
        expectDefaultDir(plan);
        expect(plan.warnings.some((w) => w.includes("WP_PLUGIN_DIR") && w.includes("read"))).toBe(
          true,
        );
      }
    });

    it("does not match a different function name ending in define", () => {
      setConfig("my_define('WP_PLUGIN_DIR', '../outside');");
      const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
      expectDefaultDir(plan);
      expect(plan.warnings).toEqual([]);
    });

    it("ends // and # comments at ?> so a live define after it is honoured", () => {
      setConfig("// note ?><?php define('WP_PLUGIN_DIR', '../outside');");
      expectRefused(resolveWordPressInstall(makeWpFiles(), tempDir));
      setConfig("# note ?><?php define('WP_PLUGIN_DIR', '/etc/outside');");
      expectRefused(resolveWordPressInstall(makeWpFiles(), tempDir));
    });

    it("skips heredoc and nowdoc bodies so an apostrophe does not flip string state", () => {
      for (const open of ["<<<EOT", '<<<"EOT"', "<<<'EOT'"]) {
        setConfig(`$x = ${open}\nit's\nEOT;\n// define('WP_PLUGIN_DIR', 'custom/plugins');\n`);
        const plan = resolveWordPressInstall(makeWpFiles(), tempDir);
        expectDefaultDir(plan);
        expect(plan.warnings).toEqual([]);
      }
    });

    it("ignores a define that only appears inside a heredoc body", () => {
      setConfig("$x = <<<EOT\ndefine('WP_PLUGIN_DIR', 'custom');\nEOT;\n");
      expectDefaultDir(resolveWordPressInstall(makeWpFiles(), tempDir));
    });

    it("keeps detectWordPressLayout fields and reports the outside state", () => {
      setConfig("define('WP_PLUGIN_DIR', '../outside');");
      const layout = detectWordPressLayout(tempDir);
      expect(layout.isWpRoot).toBe(true);
      expect(layout.pluginDirOutside).toBe(true);
      expect(layout.hasExistingPlugin).toBe(false);
    });
  });
});
