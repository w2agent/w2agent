import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectWordPressLayout,
  isBackslashNameOffWindows,
  readPluginDirLiteral,
  resolvePluginDirLiteral,
} from "../src/adapters/wordpress/install.js";

const DEFAULT_DIR = "wp-content/plugins";

describe("wp-config.php WP_PLUGIN_DIR reader carry-overs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-wp-reader-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const layout = (body: string) => {
    writeFileSync(join(dir, "wp-config.php"), `<?php\n${body}\n`);
    return detectWordPressLayout(dir);
  };

  describe("heredoc labels with bytes >= 0x80", () => {
    it.each(["é", "世", "😀"])("terminator lookahead treats %s as a label byte", (ch) => {
      const l = layout(`$x = <<<EOT\nEOT${ch}\ndefine('WP_PLUGIN_DIR', 'fake');\nEOT;\n`);
      expect(l.pluginDir).toBe(DEFAULT_DIR);
      expect(l.pluginDirWarnings).toEqual([]);
    });

    it.each(["é", "世", "😀"])("opening label ending in %s hides a fake define", (ch) => {
      const l = layout(`$x = <<<EOT${ch}\ndefine('WP_PLUGIN_DIR', 'fake');\nEOT${ch};\n`);
      expect(l.pluginDir).toBe(DEFAULT_DIR);
      expect(l.pluginDirWarnings).toEqual([]);
    });

    it("a label that starts with a high byte works, and a real define after it is read", () => {
      const l = layout(
        "$x = <<<'é世'\ndefine('WP_PLUGIN_DIR', 'fake');\né世;\ndefine('WP_PLUGIN_DIR', 'real/dir');",
      );
      expect(l.pluginDir).toBe("real/dir");
    });
  });

  describe("single-quoted escapes", () => {
    it("decodes \\\\ to one backslash in the literal", () => {
      const r = readPluginDirLiteral(
        "<?php define('WP_PLUGIN_DIR', 'content\\\\site\\\\plugins');",
      );
      expect(r.literal).toBe("content\\site\\plugins");
    });

    it("a decoded backslash is not a separator on POSIX: default folder and a warning", () => {
      const l = layout("define('WP_PLUGIN_DIR', 'custom\\\\plugins');");
      expect(l.pluginDir).toBe(DEFAULT_DIR);
      expect(l.pluginDirOutside).toBe(false);
      expect(l.pluginDirWarnings.some((w) => w.includes("Could not read"))).toBe(true);
    });

    it("a decoded backslash is a separator when the path API is win32", () => {
      expect(isBackslashNameOffWindows("custom\\plugins", win32)).toBe(false);
      expect(resolvePluginDirLiteral("C:\\proj", "custom\\plugins", win32)).toBe("custom/plugins");
    });

    it("the POSIX resolver never splits on a backslash", () => {
      expect(resolvePluginDirLiteral(dir, "custom\\plugins", posix)).toBe("custom\\plugins");
    });

    it("the backslash rule leaves Windows-absolute literals to the outside refusal", () => {
      expect(isBackslashNameOffWindows("C:\\site\\x")).toBe(false);
      expect(isBackslashNameOffWindows("\\\\srv\\share\\x")).toBe(false);
      expect(isBackslashNameOffWindows("C:foo\\x")).toBe(false);
      expect(isBackslashNameOffWindows("a\\b")).toBe(true);
      expect(isBackslashNameOffWindows("/abs/a\\b")).toBe(true);
    });

    it("decodes \\' to a quote", () => {
      const l = layout("define('WP_PLUGIN_DIR', 'it\\'s/plugins');");
      expect(l.pluginDir).toBe("it's/plugins");
    });

    it("keeps any other backslash literal", () => {
      const r = readPluginDirLiteral("<?php define('WP_PLUGIN_DIR', 'a\\nb');");
      expect(r.literal).toBe("a\\nb");
    });

    it("still rejects a backslash in a double-quoted string", () => {
      const l = layout('define("WP_PLUGIN_DIR", "a\\\\b");');
      expect(l.pluginDir).toBe(DEFAULT_DIR);
      expect(l.pluginDirWarnings.some((w) => w.includes("Could not read"))).toBe(true);
    });
  });

  describe("drive and UNC paths off Windows", () => {
    it.each([
      "C:/site/plugins",
      "C:\\\\site\\\\plugins",
      "\\\\\\\\server\\\\share\\\\p",
    ])("refuses %s as outside the project", (lit) => {
      const l = layout(`define('WP_PLUGIN_DIR', '${lit}');`);
      expect(l.pluginDirOutside).toBe(true);
      expect(l.pluginDir).toBe(DEFAULT_DIR);
    });

    it("refuses a drive-relative path", () => {
      const l = layout("define('WP_PLUGIN_DIR', 'C:foo');");
      expect(l.pluginDirOutside).toBe(true);
    });
  });

  describe("win32 resolution (path.win32 on this host, not a real Windows run)", () => {
    const proj = "C:\\proj";
    const run = (lit: string) => resolvePluginDirLiteral(proj, lit, win32);

    it("reads a drive path inside the project", () => {
      expect(run("C:\\proj\\wp\\plugins")).toBe("wp/plugins");
      expect(run("C:/proj/wp/plugins")).toBe("wp/plugins");
    });

    it("refuses another drive, UNC and drive-relative", () => {
      expect(run("D:\\proj\\wp")).toBeNull();
      expect(run("\\\\srv\\share\\p")).toBeNull();
      expect(run("C:wp")).toBeNull();
    });

    it("anchors a slash-rooted literal at the project's drive root", () => {
      expect(run("/proj/x")).toBe("x");
      expect(run("/elsewhere/x")).toBeNull();
      expect(resolvePluginDirLiteral("D:\\site", "/site/p", win32)).toBe("p");
    });

    it("keeps relative paths and '..' working", () => {
      expect(run("wp\\plugins")).toBe("wp/plugins");
      expect(run("a/../b")).toBe("b");
      expect(run("..\\x")).toBeNull();
    });
  });

  describe("interpolation blocks", () => {
    const wpHome = `define('WP_HOME', "http://{$_SERVER['HTTP_HOST']}");`;

    it("a safe block with a commented WP_PLUGIN_DIR installs to the default", () => {
      const l = layout(`${wpHome}\n// define('WP_PLUGIN_DIR', 'nope');`);
      expect(l.pluginDirUnreadable).toBe(false);
      expect(l.pluginDir).toBe(DEFAULT_DIR);
      expect(l.pluginDirWarnings).toEqual([]);
    });

    it("a safe block with a live define reads it", () => {
      const l = layout(`${wpHome}\ndefine('WP_PLUGIN_DIR', 'content/plugins');`);
      expect(l.pluginDir).toBe("content/plugins");
      expect(l.pluginDirUnreadable).toBe(false);
    });

    it.each([
      "$x = \"${y} {$a->b} {$a[0]} {$a['k']} {$a::$b}\";",
      "$x = <<<EOT\n${y} {$z['k']}\nEOT;",
    ])("safe forms are trusted: %#", (src) => {
      const l = layout(`${src}\ndefine('WP_PLUGIN_DIR', 'custom');`);
      expect(l.pluginDir).toBe("custom");
      expect(l.pluginDirUnreadable).toBe(false);
    });

    it("a call inside a block refuses", () => {
      const l = layout(`$a=[1=>'x']; $x = "{$a[define('WP_PLUGIN_DIR', 'custom')]}";`);
      expect(l.pluginDirUnreadable).toBe(true);
    });

    it("a comment opener inside a block key refuses", () => {
      const l = layout(
        `$a=['/*'=>'x']; $x = "{$a["/*"]}"; define('WP_PLUGIN_DIR', 'custom'); $tail = "*/";`,
      );
      expect(l.pluginDirUnreadable).toBe(true);
    });

    it.each([
      ["a nested brace", `$x = "{$a[{$b}]}"; define('WP_PLUGIN_DIR', 'c');`],
      ["a slash", `$x = "{$a/*}"; define('WP_PLUGIN_DIR', 'c'); $y = "*/";`],
      ["a newline", `$x = "{$a\n}"; define('WP_PLUGIN_DIR', 'c');`],
      ["whitespace", `$x = "{$a }"; define('WP_PLUGIN_DIR', 'c');`],
      ["a backslash", `$x = "{$a['\\\\']}"; define('WP_PLUGIN_DIR', 'c');`],
      ["no closing brace", `$x = "{$a"; define('WP_PLUGIN_DIR', 'c');`],
      ["a ${ call", `$x = "\${a(1)}"; define('WP_PLUGIN_DIR', 'c');`],
      ["a heredoc block with a call", `$x = <<<EOT\n{$a(1)}\nEOT;\ndefine('WP_PLUGIN_DIR', 'c');`],
    ])("%s refuses", (_n, src) => {
      expect(layout(src).pluginDirUnreadable).toBe(true);
    });

    it("an escaped \\{$ is not a block", () => {
      const l = layout(`define('X', "\\{$a"); define('WP_PLUGIN_DIR', 'real/dir'); $b = "}";`);
      expect(l.pluginDir).toBe("real/dir");
    });

    it("an escaped {\\$ is not a block", () => {
      const l = layout(`define('X', "{\\$a"); define('WP_PLUGIN_DIR', 'real/dir'); $b = "}";`);
      expect(l.pluginDir).toBe("real/dir");
    });
  });

  describe("inline HTML", () => {
    it("an apostrophe after ?> does not hide a real define", () => {
      const l = layout("?>it's<?php define('WP_PLUGIN_DIR', 'real/dir');");
      expect(l.pluginDir).toBe("real/dir");
    });

    it("<?= reopens PHP and a quote in HTML is ignored", () => {
      const l = layout("?>\"<?= 1 ?>'<?php define('WP_PLUGIN_DIR', 'real/dir');");
      expect(l.pluginDir).toBe("real/dir");
    });

    it("text before the first open tag is HTML, not code", () => {
      writeFileSync(
        join(dir, "wp-config.php"),
        "Banner: it's\n<?php\ndefine('WP_PLUGIN_DIR','real/dir');\n",
      );
      expect(detectWordPressLayout(dir).pluginDir).toBe("real/dir");
    });

    it("a define in inline HTML is not code", () => {
      const l = layout("?>define('WP_PLUGIN_DIR', 'fake');<?php");
      expect(l.pluginDir).toBe(DEFAULT_DIR);
    });

    it("?> inside a string or comment does not start inline HTML", () => {
      const l = layout("$a = '?>'; /* ?> */ define('WP_PLUGIN_DIR', 'real/dir');");
      expect(l.pluginDir).toBe("real/dir");
    });
  });
});
