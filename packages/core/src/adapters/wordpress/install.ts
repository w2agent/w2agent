import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GeneratedFile } from "../../generate/types.js";
import { guardInstallActions } from "../../install/guard.js";
import type { InstallAction, InstallPlan } from "../../install/types.js";

interface WordPressLayout {
  isWpRoot: boolean;
  pluginDir: string;
  pluginDirOutside: boolean;
  pluginDirWarnings: string[];
  hasExistingPlugin: boolean;
}

const DEFAULT_PLUGIN_DIR = "wp-content/plugins";

function stripPhpComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
    } else if (ch === "#" || (ch === "/" && next === "/")) {
      while (i < source.length && source[i] !== "\n" && !source.startsWith("?>", i)) i++;
    } else if (ch === "<" && next === "<") {
      const heredoc = source.slice(i).match(/^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1\r?\n/);
      if (!heredoc) {
        out += ch;
        i++;
        continue;
      }
      const bodyStart = i + heredoc[0].length;
      const close = new RegExp(`(^|\\n)[ \\t]*${heredoc[2]}(?!\\w)`).exec(source.slice(bodyStart));
      i = close ? bodyStart + close.index + close[0].length : source.length;
      out += " ";
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function readPluginDirLiteral(wpConfig: string): { literal: string | null; found: boolean } {
  const code = stripPhpComments(wpConfig);
  const value = `(?:'([^'\\\\]*)'|"([^"\\\\$]*)")`;
  const literal =
    code.match(
      new RegExp(
        `(?<![\\w$>:])define\\s*\\(\\s*['"]WP_PLUGIN_DIR['"]\\s*,\\s*${value}\\s*\\)`,
        "i",
      ),
    ) ?? code.match(new RegExp(`(?<![\\w$>:])const\\s+WP_PLUGIN_DIR\\s*=\\s*${value}\\s*;`, "i"));
  if (literal) return { literal: literal[1] ?? literal[2], found: true };
  return {
    literal: null,
    found:
      /(?<![\w$>:])define\s*\(\s*['"]WP_PLUGIN_DIR['"]|(?<![\w$>:])const\s+WP_PLUGIN_DIR\b/i.test(
        code,
      ),
  };
}

export function detectWordPressLayout(projectDir: string): WordPressLayout {
  const isWpRoot = existsSync(join(projectDir, "wp-content", "plugins"));

  let pluginDir = DEFAULT_PLUGIN_DIR;
  let pluginDirOutside = false;
  const pluginDirWarnings: string[] = [];
  const wpConfigPath = join(projectDir, "wp-config.php");
  if (existsSync(wpConfigPath)) {
    try {
      const { literal, found } = readPluginDirLiteral(readFileSync(wpConfigPath, "utf-8"));
      if (literal !== null) {
        const root = resolve(projectDir);
        const rel = relative(root, resolve(root, literal));
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          pluginDirOutside = true;
          pluginDirWarnings.push(
            `WP_PLUGIN_DIR (${literal}) points outside the project directory. Nothing was written.`,
          );
        } else if (rel !== "") {
          pluginDir = rel.split(sep).join("/");
        }
      } else if (found) {
        pluginDirWarnings.push(
          `Could not read WP_PLUGIN_DIR from wp-config.php (only a plain string literal is supported). Using ${DEFAULT_PLUGIN_DIR}.`,
        );
      }
    } catch {}
  }

  const hasExistingPlugin = !pluginDirOutside && existsSync(join(projectDir, pluginDir, "w2agent"));

  return { isWpRoot, pluginDir, pluginDirOutside, pluginDirWarnings, hasExistingPlugin };
}

export function resolveWordPressInstall(files: GeneratedFile[], projectDir: string): InstallPlan {
  const layout = detectWordPressLayout(projectDir);
  const actions: InstallAction[] = [];
  const warnings: string[] = [...layout.pluginDirWarnings];
  const postInstallSteps: string[] = [];

  if (layout.pluginDirOutside) {
    actions.push({
      type: "manual",
      dest: "wp-config.php",
      reason:
        "WP_PLUGIN_DIR points outside the project directory, so the plugin was not installed. " +
        "Copy the plugin there by hand, for example from `w2agent integrate <url> --output <dir>`.",
    });
    return { platform: "wordpress", actions, warnings, postInstallSteps };
  }

  if (!layout.isWpRoot) {
    warnings.push(
      "Not a WordPress root directory (wp-content/plugins/ not found). Files will still be written.",
    );
  }

  if (layout.hasExistingPlugin) {
    warnings.push(
      "w2agent plugin already exists. Remove the old version first, then re-run --install.",
    );
    return { platform: "wordpress", actions, warnings, postInstallSteps };
  }

  const prefix = "wordpress/";
  const platformFiles = files.filter((f) => f.filename.startsWith(prefix));
  const targetDir = `${layout.pluginDir}/w2agent`;

  for (const file of platformFiles) {
    const relPath = file.filename.slice(prefix.length);
    const baseName = relPath.split("/").pop() || relPath;

    if (baseName === "INSTALL.md") continue;

    // Remap files into the plugin directory
    const dest = `${targetDir}/${relPath}`;
    actions.push({ type: "write", dest, content: file.content });
  }

  const guarded = guardInstallActions(actions, projectDir);
  warnings.push(...guarded.warnings);
  if (guarded.actions.some((a) => a.type === "write")) {
    postInstallSteps.push("Activate the w2agent plugin in WordPress Admin → Plugins.");
  }

  return { platform: "wordpress", actions: guarded.actions, warnings, postInstallSteps };
}
