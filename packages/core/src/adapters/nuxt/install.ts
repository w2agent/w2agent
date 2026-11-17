import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { GeneratedFile } from "../../generate/types.js";
import { guardInstallActions, hasWrittenCopy, willWrite } from "../../install/guard.js";
import type { InstallAction, InstallPlan } from "../../install/types.js";

interface NuxtLayout {
  version: number | null;
  hasServerDir: boolean;
  hasExistingRoutes: boolean;
  hasExistingMiddleware: boolean;
  hasW2agentMiddleware: boolean;
  hasExistingPublicLlms: boolean;
  hasExistingBuildScript: boolean;
}

export function detectNuxtLayout(projectDir: string): NuxtLayout {
  let version: number | null = null;
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const nuxtVer = deps.nuxt || deps.nuxt3;
      if (nuxtVer) {
        const match = nuxtVer.match(/(\d+)/);
        if (match) version = parseInt(match[1], 10);
      }
    } catch {}
  }

  const hasServerDir = existsSync(join(projectDir, "server"));
  const hasExistingRoutes =
    existsSync(join(projectDir, "server", "routes", "llms.txt.ts")) ||
    existsSync(join(projectDir, "server", "routes", "llms.txt.js"));

  const middlewarePath = join(projectDir, "server", "middleware", "content-negotiation.ts");
  const hasExistingMiddleware = existsSync(middlewarePath);
  let hasW2agentMiddleware = false;
  if (hasExistingMiddleware) {
    const content = readFileSync(middlewarePath, "utf-8");
    hasW2agentMiddleware = content.includes("w2agent") || content.includes("llms.txt");
  }

  const hasExistingPublicLlms = existsSync(join(projectDir, "public", "llms.txt"));
  const hasExistingBuildScript = existsSync(join(projectDir, "w2agent-build.mjs"));

  return {
    version,
    hasServerDir,
    hasExistingRoutes,
    hasExistingMiddleware,
    hasW2agentMiddleware,
    hasExistingPublicLlms,
    hasExistingBuildScript,
  };
}

const NUXT_CONFIG_NAMES = [
  "nuxt.config.ts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.mts",
];
const SRC_DIR_LITERAL = /\bsrcDir\s*:\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`$\\\n]*)`)/;

function readNuxtConfigText(projectDir: string): string {
  for (const name of NUXT_CONFIG_NAMES) {
    const path = join(projectDir, name);
    if (!existsSync(path)) continue;
    try {
      return readFileSync(path, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    } catch {}
  }
  return "";
}

function installedNuxtMajor(projectDir: string): number | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(projectDir, "node_modules", "nuxt", "package.json"), "utf-8"),
    );
    const match = String(pkg.version).match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

// Mirrors @nuxt/schema's `srcDir` resolution. Returns the srcDir relative to the project
// ("" for the root) and a warning when nuxt.config sets srcDir with a non-literal value.
export function resolveNuxtSrcDir(
  projectDir: string,
  version: number | null,
): { dir: string; warning?: string } {
  const config = readNuxtConfigText(projectDir);
  const literal = config.match(SRC_DIR_LITERAL);
  const explicit = literal ? (literal[1] ?? literal[2] ?? literal[3]) : "";
  if (explicit) {
    const rel = relative(resolve(projectDir), resolve(projectDir, explicit));
    return { dir: rel.split(sep).join("/") };
  }
  const warning =
    !literal && /\bsrcDir\s*:/.test(config)
      ? "nuxt.config sets srcDir with a value that is not a string literal; placing the WebMCP plugin by Nuxt's default rule. Move plugins/w2agent-webmcp.client.ts into <srcDir>/plugins/ if that differs."
      : undefined;

  const major = version ?? installedNuxtMajor(projectDir);
  const nuxt4Mode =
    (major !== null && major >= 4) || /\bcompatibilityVersion\s*:\s*4\b/.test(config);
  if (!nuxt4Mode) return { dir: "", warning };

  const appDir = join(projectDir, "app");
  if (!existsSync(appDir)) return { dir: "", warning };
  let entries: string[] = [];
  try {
    entries = readdirSync(appDir);
  } catch {}
  const hasContent = entries.some(
    (name) => name !== "spa-loading-template.html" && !name.startsWith("router.options"),
  );
  if (hasContent) return { dir: "app", warning };
  const rootMarkers = ["app.vue", "App.vue", "assets", "layouts", "middleware", "pages", "plugins"];
  if (rootMarkers.some((name) => existsSync(join(projectDir, name)))) return { dir: "", warning };
  return { dir: "app", warning };
}

export function resolveNuxtInstall(files: GeneratedFile[], projectDir: string): InstallPlan {
  const layout = detectNuxtLayout(projectDir);
  const actions: InstallAction[] = [];
  const warnings: string[] = [];
  const postInstallSteps: string[] = [];

  // Nuxt 2 not supported
  if (layout.version !== null && layout.version < 3) {
    warnings.push(
      "Nuxt 3+ required for Nitro server routes. This project appears to be Nuxt 2. Use --output mode and follow INSTALL.md.",
    );
    return { platform: "nuxt", actions, warnings, postInstallSteps };
  }

  const prefix = "nuxt/";
  const platformFiles = files.filter((f) => f.filename.startsWith(prefix));
  const mergeCopies: { dest: string; name: string }[] = [];

  for (const file of platformFiles) {
    const relPath = file.filename.slice(prefix.length);
    const baseName = relPath.split("/").pop() || relPath;

    if (baseName === "INSTALL.md") continue;

    // Server routes
    if (relPath.startsWith("server/routes/")) {
      if (
        layout.hasExistingRoutes &&
        (relPath.includes("llms.txt") || relPath.includes("llms-full.txt"))
      ) {
        actions.push({ type: "skip", dest: relPath, reason: "route already exists" });
        warnings.push(`Existing ${relPath} found — skipping.`);
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    // Middleware
    if (relPath.startsWith("server/middleware/")) {
      if (layout.hasW2agentMiddleware) {
        actions.push({ type: "skip", dest: relPath, reason: "already has w2agent integration" });
        continue;
      }
      if (layout.hasExistingMiddleware) {
        const mergedName = relPath.replace(/\.(ts|js)$/, ".w2agent.$1");
        actions.push({ type: "write", dest: mergedName, content: file.content });
        mergeCopies.push({ dest: mergedName, name: mergedName.split("/").pop() ?? mergedName });
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    // Public seed files
    if (relPath.startsWith("public/")) {
      if (relPath === "public/llms.txt" && layout.hasExistingPublicLlms) {
        actions.push({ type: "skip", dest: relPath, reason: "file already exists" });
        warnings.push("Existing public/llms.txt found — skipping seed file.");
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    // Build script
    if (baseName === "w2agent-build.mjs") {
      if (layout.hasExistingBuildScript) {
        actions.push({ type: "skip", dest: relPath, reason: "already exists" });
        warnings.push("Existing w2agent-build.mjs found — skipping.");
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    // Client plugins are only bundled from the srcDir (app/ in Nuxt 4 layouts)
    if (relPath.startsWith("plugins/")) {
      const srcDir = resolveNuxtSrcDir(projectDir, layout.version);
      if (srcDir.warning) warnings.push(srcDir.warning);
      const dest = srcDir.dir ? `${srcDir.dir}/${relPath}` : relPath;
      actions.push({ type: "write", dest, content: file.content });
      continue;
    }

    actions.push({ type: "write", dest: relPath, content: file.content });
  }

  const guarded = guardInstallActions(actions, projectDir);
  warnings.push(...guarded.warnings);
  const moduleKept = guarded.actions.find(
    (a) =>
      a.dest === "modules/w2agent.ts" && a.type === "skip" && a.reason !== "already up to date",
  );
  if (
    moduleKept &&
    guarded.actions.some((a) => a.type === "write" && a.dest.startsWith("server/routes/"))
  ) {
    warnings.push(
      "The installed routes read the llms files that modules/w2agent.ts inlines at build time. Make your existing module register a server asset named w2agent for them, or they return 404.",
    );
  }
  for (const copy of mergeCopies) {
    if (hasWrittenCopy(guarded.actions, copy.dest)) {
      warnings.push(`Existing middleware found — saved as ${copy.name}. Merge manually.`);
    }
  }

  if (willWrite(guarded.actions, "w2agent-build.mjs")) {
    postInstallSteps.push(
      'Add `"prebuild": "node w2agent-build.mjs"` to your package.json scripts (it must run before the build so files land in public/). Needs the w2agent CLI installed in this project: it is not published on npm yet, so build it from the w2agent repo and run `npm install -D <path-to-w2agent>/packages/cli`.',
    );
  }

  return { platform: "nuxt", actions: guarded.actions, warnings, postInstallSteps };
}
