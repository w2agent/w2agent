import { existsSync, readFileSync, realpathSync } from "node:fs";
import nodePath, { join, win32 } from "node:path";
import type { GeneratedFile } from "../../generate/types.js";
import { guardInstallActions } from "../../install/guard.js";
import type { InstallAction, InstallPlan } from "../../install/types.js";

interface WordPressLayout {
  isWpRoot: boolean;
  pluginDir: string;
  pluginDirOutside: boolean;
  pluginDirUnreadable: boolean;
  pluginDirWarnings: string[];
  hasExistingPlugin: boolean;
}

const DEFAULT_PLUGIN_DIR = "wp-content/plugins";

const TOKEN = "\u0001";

type PathApi = typeof nodePath;

const SAFE_BLOCK = /^(?:[\w$[\]\->:]|'[^\\{}"']*')*$/;

function hasUnsafeBlock(body: string): boolean {
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === "\\") {
      k++;
      continue;
    }
    let open = -1;
    if (c === "{" && body[k + 1] === "$") open = k + 1;
    else if (c === "$" && body[k + 1] === "{") open = k + 2;
    if (open === -1) continue;
    const close = body.indexOf("}", open);
    if (close === -1 || !SAFE_BLOCK.test(body.slice(open, close))) return true;
    k = close;
  }
  return false;
}

function skipInlineHtml(source: string, from: number): number {
  const reopen = /<\?(?:php|=)?/gi;
  reopen.lastIndex = from;
  const open = reopen.exec(source);
  return open ? open.index + open[0].length : source.length;
}

function stripPhpComments(source: string): {
  code: string;
  strings: string[];
  interpolated: boolean;
} {
  const strings: string[] = [];
  let interpolated = false;
  let out = "";
  let i = skipInlineHtml(source, 0);
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      const raw = source.slice(i, j + 1);
      if (ch === '"' && hasUnsafeBlock(raw.slice(1, j < source.length ? -1 : undefined))) {
        interpolated = true;
      }
      out += `${TOKEN}${strings.length}${TOKEN}`;
      strings.push(raw);
      i = j + 1;
    } else if (ch === "?" && next === ">") {
      i = skipInlineHtml(source, i + 2);
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
    } else if (ch === "#" || (ch === "/" && next === "/")) {
      while (i < source.length && source[i] !== "\n" && !source.startsWith("?>", i)) i++;
    } else if (ch === "<" && next === "<") {
      const heredoc = source
        .slice(i)
        .match(/^<<<[ \t]*(['"]?)([A-Za-z_\u0080-￿][\w\u0080-￿]*)\1\r?\n/);
      if (!heredoc) {
        out += ch;
        i++;
        continue;
      }
      const bodyStart = i + heredoc[0].length;
      const close = new RegExp(`(^|\\n)[ \\t]*${heredoc[2]}(?![\\w\\u0080-\\uffff])`).exec(
        source.slice(bodyStart),
      );
      const end = close ? bodyStart + close.index + close[0].length : source.length;
      if (heredoc[1] !== "'" && hasUnsafeBlock(source.slice(bodyStart, end))) interpolated = true;
      i = end;
      out += " ";
    } else {
      out += ch;
      i++;
    }
  }
  return { code: out, strings, interpolated };
}

export function readPluginDirLiteral(wpConfig: string): {
  literal: string | null;
  found: boolean;
  unreliable: boolean;
} {
  const { code, strings, interpolated } = stripPhpComments(wpConfig);
  if (interpolated && /WP_PLUGIN_DIR/i.test(wpConfig)) {
    return { literal: null, found: true, unreliable: true };
  }
  const tok = `${TOKEN}(\\d+)${TOKEN}`;
  const isName = (index: string) => {
    const raw = strings[Number(index)];
    return raw.length > 2 && raw.slice(1, -1).toUpperCase() === "WP_PLUGIN_DIR";
  };
  const plain = (index: string): string | null => {
    const raw = strings[Number(index)];
    const body = raw.slice(1, -1);
    if (raw.length < 2 || raw[raw.length - 1] !== raw[0]) return null;
    if (raw[0] === "'") return body.replace(/\\([\\'])/g, "$1");
    if (body.includes("\\") || body.includes("$")) return null;
    return body;
  };
  const forms = [
    new RegExp(`(?<![\\w$>:])define\\s*\\(\\s*${tok}\\s*,\\s*${tok}\\s*\\)`, "gi"),
    new RegExp(`(?<![\\w$>:])const\\s+WP_PLUGIN_DIR\\s*=\\s*${tok}\\s*;`, "gi"),
  ];
  for (const [n, re] of forms.entries()) {
    for (const m of code.matchAll(re)) {
      const valueIndex = n === 0 ? m[2] : m[1];
      if (n === 0 && !isName(m[1])) continue;
      const value = plain(valueIndex);
      if (value !== null) return { literal: value, found: true, unreliable: false };
    }
  }
  const defineStart = new RegExp(`(?<![\\w$>:])define\\s*\\(\\s*${tok}`, "gi");
  const found = [...code.matchAll(defineStart)].some((m) => isName(m[1]));
  return {
    literal: null,
    unreliable: false,
    found: found || /(?<![\w$>:])const\s+WP_PLUGIN_DIR\b/i.test(code),
  };
}

function resolvePhysical(start: string, rest: string, p: PathApi): string {
  let cur = start;
  for (const seg of rest.split(p.sep === "\\" ? /[\\/]+/ : /\/+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      cur = p.dirname(cur);
      continue;
    }
    const next = p.join(cur, seg);
    try {
      cur = realpathSync(next);
    } catch {
      cur = next;
    }
  }
  return cur;
}

function realWithRemainder(path: string, p: PathApi = nodePath): string {
  const rest: string[] = [];
  let cur = path;
  for (;;) {
    try {
      return p.join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = p.dirname(cur);
      if (parent === cur) return path;
      rest.push(p.basename(cur));
      cur = parent;
    }
  }
}

export function isBackslashNameOffWindows(literal: string, p: PathApi = nodePath): boolean {
  return (
    p.sep !== "\\" &&
    literal.includes("\\") &&
    !/^[A-Za-z]:/.test(literal) &&
    (p.isAbsolute(literal) || !win32.isAbsolute(literal))
  );
}

export function resolvePluginDirLiteral(
  projectDir: string,
  literal: string,
  p: PathApi = nodePath,
): string | null {
  if (/^[A-Za-z]:(?![\\/])/.test(literal)) return null;
  const root = realWithRemainder(p.resolve(projectDir), p);
  let start = root;
  let rest = literal;
  if (win32.isAbsolute(literal) || p.isAbsolute(literal)) {
    if (p.sep !== "\\") {
      if (!p.isAbsolute(literal)) return null;
      start = p.resolve("/");
    } else {
      const literalRoot = win32.parse(literal).root;
      start = /^(?:[A-Za-z]:|[\\/]{2})/.test(literalRoot) ? literalRoot : win32.parse(root).root;
      rest = literal.slice(literalRoot.length);
    }
  }
  const rel = p.relative(root, resolvePhysical(start, rest, p));
  if (rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) return null;
  return rel.split(p.sep).join("/");
}

export function detectWordPressLayout(projectDir: string): WordPressLayout {
  const isWpRoot = existsSync(join(projectDir, "wp-content", "plugins"));

  let pluginDir = DEFAULT_PLUGIN_DIR;
  let pluginDirOutside = false;
  let pluginDirUnreadable = false;
  const pluginDirWarnings: string[] = [];
  const wpConfigPath = join(projectDir, "wp-config.php");
  if (existsSync(wpConfigPath)) {
    try {
      const { literal, found, unreliable } = readPluginDirLiteral(
        readFileSync(wpConfigPath, "utf-8"),
      );
      if (unreliable) {
        pluginDirUnreadable = true;
        pluginDirWarnings.push(
          "WP_PLUGIN_DIR could not be read reliably from wp-config.php (string interpolation). Nothing was written.",
        );
      } else if (literal !== null && !isBackslashNameOffWindows(literal)) {
        const rel = resolvePluginDirLiteral(projectDir, literal);
        if (rel === null) {
          pluginDirOutside = true;
          pluginDirWarnings.push(
            `WP_PLUGIN_DIR (${literal}) points outside the project directory. Nothing was written.`,
          );
        } else {
          pluginDir = rel;
        }
      } else if (found || literal !== null) {
        pluginDirWarnings.push(
          `Could not read WP_PLUGIN_DIR from wp-config.php (only a plain string literal is supported). Using ${DEFAULT_PLUGIN_DIR}.`,
        );
      }
    } catch {}
  }

  const hasExistingPlugin =
    !pluginDirOutside && !pluginDirUnreadable && existsSync(join(projectDir, pluginDir, "w2agent"));

  return {
    isWpRoot,
    pluginDir,
    pluginDirOutside,
    pluginDirUnreadable,
    pluginDirWarnings,
    hasExistingPlugin,
  };
}

export function resolveWordPressInstall(files: GeneratedFile[], projectDir: string): InstallPlan {
  const layout = detectWordPressLayout(projectDir);
  const actions: InstallAction[] = [];
  const warnings: string[] = [...layout.pluginDirWarnings];
  const postInstallSteps: string[] = [];

  if (layout.pluginDirUnreadable) {
    actions.push({
      type: "manual",
      dest: "wp-config.php",
      reason:
        "WP_PLUGIN_DIR could not be read reliably, so the plugin was not installed. " +
        "Copy the plugin into your plugin directory by hand, for example from `w2agent integrate <url> --output <dir>`.",
    });
    return { platform: "wordpress", actions, warnings, postInstallSteps };
  }

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
  const targetDir = layout.pluginDir ? `${layout.pluginDir}/w2agent` : "w2agent";

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
