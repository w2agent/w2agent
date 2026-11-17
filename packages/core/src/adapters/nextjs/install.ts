import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../../generate/types.js";
import { guardInstallActions, hasWrittenCopy, willWrite } from "../../install/guard.js";
import type { InstallAction, InstallPlan } from "../../install/types.js";
import {
  type NextjsEdgeFn,
  nextjsMiddlewareSource,
  nextjsWebhookRouteSource,
  ROUTE_REVALIDATE_SEGMENT,
  type SourceLang,
  WEBHOOK_ROUTE_PATH,
} from "./templates.js";

const STAGED_ROBOTS = ".w2agent/robots.txt";

interface NextjsLayout {
  hasSrcDir: boolean;
  hasAppDir: boolean;
  hasPagesDir: boolean;
  hasMiddleware: boolean;
  hasProxy: boolean;
  existingEdgeFile: string | null;
  hasExistingLlmsRoute: boolean;
  hasExistingW2agentLlms: boolean;
  hasExistingBuildScript: boolean;
  hasW2agentRefs: boolean;
  refsFile: string | null;
  rootEdgeFile: string | null;
}

export function detectNextjsLayout(projectDir: string): NextjsLayout {
  const hasSrcDir = existsSync(join(projectDir, "src"));
  const hasAppDir =
    existsSync(join(projectDir, "app")) || existsSync(join(projectDir, "src", "app"));
  const hasPagesDir =
    existsSync(join(projectDir, "pages")) || existsSync(join(projectDir, "src", "pages"));

  const srcApp = hasSrcDir && existsSync(join(projectDir, "src", "app"));
  // The directory Next reads comes first, so it wins when a root and a src/ file both exist
  const edgeDirs = srcApp ? ["src/", ""] : ["", "src/"];
  const pathsIn = (dirs: string[], name: string) =>
    dirs.flatMap((dir) => ["ts", "js", "tsx", "jsx"].map((ext) => `${dir}${name}.${ext}`));
  const existing = (paths: string[]) => paths.find((p) => existsSync(join(projectDir, p))) ?? null;
  // A live src/ file in a src/app project alone decides; a root file beside it is ignored by Next
  const srcLive =
    srcApp &&
    existing([...pathsIn(["src/"], "middleware"), ...pathsIn(["src/"], "proxy")]) !== null;
  const liveDirs = srcLive ? ["src/"] : edgeDirs;
  const rootEdgeFile = srcApp
    ? existing([...pathsIn([""], "middleware"), ...pathsIn([""], "proxy")])
    : null;
  const edgePaths = (name: string) => pathsIn(liveDirs, name);
  const existingMiddleware = existing(edgePaths("middleware"));
  const existingProxy = existing(edgePaths("proxy"));
  const hasMiddleware = existingMiddleware !== null;
  const existingEdgeFile = existingMiddleware ?? existingProxy;

  const appRoot = srcApp ? "src/app" : "app";
  const hasExistingLlmsRoute = existsSync(join(projectDir, appRoot, "llms.txt", "route.ts"));
  const hasExistingW2agentLlms = existsSync(join(projectDir, ".w2agent", "llms.txt"));
  const hasExistingBuildScript = existsSync(join(projectDir, "w2agent-build.mjs"));

  let refsFile: string | null = null;
  for (const p of [...edgePaths("middleware"), ...edgePaths("proxy")]) {
    if (!existsSync(join(projectDir, p))) continue;
    const content = readFileSync(join(projectDir, p), "utf-8");
    if (content.includes("w2agent") || content.includes("llms.txt")) {
      refsFile = p;
      break;
    }
  }

  return {
    hasSrcDir: hasSrcDir && existsSync(join(projectDir, "src", "app")),
    hasAppDir,
    hasPagesDir,
    hasMiddleware,
    hasProxy: existingProxy !== null,
    existingEdgeFile,
    hasExistingLlmsRoute,
    hasExistingW2agentLlms,
    hasExistingBuildScript,
    hasW2agentRefs: refsFile !== null,
    refsFile,
    rootEdgeFile,
  };
}

const NEXT_CONFIG_NAMES = ["js", "mjs", "ts", "cjs", "mts"].map((ext) => `next.config.${ext}`);

function isNextjsProject(projectDir: string): boolean {
  if (NEXT_CONFIG_NAMES.some((name) => existsSync(join(projectDir, name)))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    return !!(pkg?.dependencies?.next || pkg?.devDependencies?.next);
  } catch {
    return false;
  }
}

function majorOf(version: unknown): number | null {
  if (typeof version !== "string") return null;
  // An upper bound alone (`<17`, `<=16`) names no version that is installed
  if (/^\s*</.test(version)) return null;
  const match = /^\s*(?:[\^~]|[<>]=?|=)?\s*v?(\d+)/.exec(version);
  return match?.[1] ? Number(match[1]) : null;
}

// Installed version first, then the package.json range; null when neither names a number
// (`latest`, `canary`, `*`, workspace and git specs).
export function detectNextMajor(projectDir: string): number | null {
  try {
    const installed = JSON.parse(
      readFileSync(join(projectDir, "node_modules", "next", "package.json"), "utf-8"),
    );
    const major = majorOf(installed?.version);
    if (major !== null) return major;
  } catch {}
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    return majorOf(pkg?.dependencies?.next ?? pkg?.devDependencies?.next);
  } catch {
    return null;
  }
}

// Text only: the config is never imported or executed. Any mention of the flag counts
// except a `: false` that is the whole value (`false || true` still counts).
export function usesCacheComponents(projectDir: string): boolean {
  for (const name of NEXT_CONFIG_NAMES) {
    let text: string;
    try {
      text = readFileSync(join(projectDir, name), "utf-8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/\b(?:cacheComponents|dynamicIO)\b/g)) {
      const rest = text.slice(match.index + match[0].length);
      if (!/^["']?\s*:\s*false\s*(?:[,}\n]|\/\/|\/\*|$)/.test(rest)) return true;
    }
  }
  return false;
}

// Text only, like usesCacheComponents. A comment that quotes `output: "export"` also matches.
export function usesStaticExport(projectDir: string): boolean {
  for (const name of NEXT_CONFIG_NAMES) {
    let text: string;
    try {
      text = readFileSync(join(projectDir, name), "utf-8");
    } catch {
      continue;
    }
    if (/\boutput["']?\s*:\s*(["'`])export\1/.test(text)) return true;
  }
  return false;
}

// `output` set by an expression that holds the "export" literal (`env ? "export" : undefined`).
// Same-line text only; the plain literal is usesStaticExport's.
export function usesConditionalExport(projectDir: string): boolean {
  for (const name of NEXT_CONFIG_NAMES) {
    let text: string;
    try {
      text = readFileSync(join(projectDir, name), "utf-8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/\boutput["']?\s*:([^\n]*)/g)) {
      const value = match[1] ?? "";
      if (/(["'`])export\1/.test(value) && !/^\s*(["'`])export\1/.test(value)) return true;
    }
  }
  return false;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function resolveNextjsInstall(files: GeneratedFile[], projectDir: string): InstallPlan {
  const layout = detectNextjsLayout(projectDir);
  const actions: InstallAction[] = [];
  const warnings: string[] = [];
  const postInstallSteps: string[] = [];

  if (!isNextjsProject(projectDir)) {
    warnings.push(
      `${projectDir} is not a Next.js project (no next dependency in package.json and no next.config). ` +
        "Pass --project-dir <your Next.js app>; in a monorepo, the app package.",
    );
    return { platform: "nextjs", actions, warnings, postInstallSteps };
  }

  // Pages Router only — no App Router support
  if (layout.hasPagesDir && !layout.hasAppDir) {
    warnings.push(
      "App Router required for route handlers. This project only has pages/. Use --output mode and follow INSTALL.md for manual setup.",
    );
    return { platform: "nextjs", actions, warnings, postInstallSteps };
  }

  const prefix = "nextjs/";
  const platformFiles = files.filter((f) => f.filename.startsWith(prefix));

  // Determine app dir prefix for path rewriting
  const appPrefix = layout.hasSrcDir ? "src/app" : "app";

  const mergeCopies: { dest: string; manualDest: string }[] = [];

  // No tsconfig.json: a JavaScript project, so install .js/.jsx (Next asks to install typescript otherwise)
  const lang: SourceLang = existsSync(join(projectDir, "tsconfig.json")) ? "ts" : "js";
  const ext = lang === "ts" ? "ts" : "js";
  const nextMajor = detectNextMajor(projectDir);
  // An existing file decides the convention (Next rejects both side by side); a new install uses
  // `proxy` from Next 16 on and `middleware` before it or when the version is unknown (Next 15
  // silently ignores proxy.ts, Next 16 only warns about middleware.ts).
  const edgeFn: NextjsEdgeFn = layout.hasMiddleware
    ? "middleware"
    : layout.hasProxy || (nextMajor !== null && nextMajor >= 16)
      ? "proxy"
      : "middleware";
  // Next looks for middleware/proxy next to app/, so inside src/ for a src/app project
  const edgeDir = layout.hasSrcDir ? "src/" : "";
  const cacheComponents = usesCacheComponents(projectDir);
  const staticExport = usesStaticExport(projectDir);
  // A static export requires `revalidate` on the routes, so only a non-export build drops it
  const dropRevalidate = cacheComponents && !staticExport;
  if (staticExport) {
    warnings.push(
      'next.config sets `output: "export"`. Next.js disables middleware in a static export, so Accept negotiation on `/` is not installed, and `/llms.txt`, `/llms-full.txt` and `/index.md` are exported as static files at build time.',
    );
    if (cacheComponents) {
      warnings.push(
        "next.config also mentions cacheComponents. A static export requires `export const revalidate` on the installed routes and Next.js rejects it when cacheComponents is on, so the routes need a manual change in that combination.",
      );
    }
  } else if (usesConditionalExport(projectDir)) {
    warnings.push(
      'next.config sets `output` from an expression that can be `"export"`. The middleware is installed, but it does not run in builds where `output` is `"export"`.',
    );
  }

  for (const file of platformFiles) {
    const relPath = file.filename.slice(prefix.length);
    const baseName = relPath.split("/").pop() || relPath;

    // Skip INSTALL.md
    if (baseName === "INSTALL.md") continue;

    // Route handler files — adjust for src/app layout
    if (relPath.startsWith("app/")) {
      const adjustedPath = relPath
        .replace(/^app\//, `${appPrefix}/`)
        .replace(/route\.ts$/, `route.${ext}`);

      if (layout.hasExistingLlmsRoute && relPath.startsWith("app/llms.txt/")) {
        actions.push({
          type: "skip",
          dest: adjustedPath,
          reason: "route already exists",
        });
        warnings.push(`Existing ${adjustedPath} found — skipping.`);
        continue;
      }

      // A public/ file and a route on the same path make Next.js error; never delete the user's file
      const routeMatch = relPath.match(/^app\/(.+)\/route\.ts$/);
      const publicName = routeMatch ? routeMatch[1] : null;
      if (publicName && pathExists(join(projectDir, "public", publicName))) {
        actions.push({
          type: "skip",
          dest: adjustedPath,
          reason: `public/${publicName} already exists`,
        });
        actions.push({
          type: "manual",
          dest: `public/${publicName}`,
          reason:
            `Next.js errors when a public file and a route share the path /${publicName}. ` +
            `Remove or rename public/${publicName} and re-run to get the dynamic route.`,
        });
        warnings.push(
          `Existing public/${publicName} found — not installing ${adjustedPath}. Remove or rename the public file and re-run.`,
        );
        continue;
      }
      let content =
        file.filename === WEBHOOK_ROUTE_PATH ? nextjsWebhookRouteSource(lang) : file.content;
      if (dropRevalidate) content = content.replace(ROUTE_REVALIDATE_SEGMENT, "");
      actions.push({ type: "write", dest: adjustedPath, content });
      continue;
    }

    // .w2agent/ seed files
    if (relPath.startsWith(".w2agent/")) {
      if (relPath === ".w2agent/llms.txt" && layout.hasExistingW2agentLlms) {
        actions.push({
          type: "skip",
          dest: relPath,
          reason: "file already exists",
        });
        warnings.push("Existing .w2agent/llms.txt found — skipping seed file.");
        continue;
      }

      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    // middleware.ts: rendered for the project's language and Next convention, never copied from the input
    if (baseName === "middleware.ts" || baseName === "middleware.js") {
      if (staticExport) continue;
      const dest = `${edgeDir}${edgeFn}.${ext}`;
      const rootWarning = () => {
        const root = layout.rootEdgeFile;
        if (!root) return;
        const live = layout.refsFile ?? layout.existingEdgeFile;
        const isProxy = root.startsWith("proxy.");
        if (live?.startsWith("src/")) {
          warnings.push(
            `${root} at the project root ${isProxy ? "is" : "can be"} ignored by Next.js in a src/app project; remove it once ${live} has the w2agent code.`,
          );
        } else if (isProxy) {
          warnings.push(
            `Next.js ignores a root ${root} in a src/app project; move it to src/${root}.`,
          );
        } else {
          warnings.push(
            `Next.js 15, and Next.js 16 with webpack, ignore a root ${root} in a src/app project; move it to src/${root}.`,
          );
        }
      };
      if (layout.refsFile) {
        actions.push({
          type: "skip",
          dest: layout.refsFile,
          reason: "already has w2agent integration",
        });
        rootWarning();
        continue;
      }

      const content = nextjsMiddlewareSource({ lang, fn: edgeFn });
      if (layout.existingEdgeFile) {
        rootWarning();
        const existingDir = layout.existingEdgeFile.includes("/") ? "src/" : "";
        const mergedName = `${existingDir}${edgeFn}.w2agent.${ext}`;
        actions.push({ type: "write", dest: mergedName, content });
        mergeCopies.push({ dest: mergedName, manualDest: layout.existingEdgeFile });
        continue;
      }

      actions.push({ type: "write", dest, content });
      continue;
    }

    // w2agent-build.mjs
    if (baseName === "w2agent-build.mjs") {
      if (layout.hasExistingBuildScript) {
        actions.push({
          type: "skip",
          dest: relPath,
          reason: "already exists",
        });
        warnings.push("Existing w2agent-build.mjs found — skipping.");
        continue;
      }

      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    // Everything else: write (the one .tsx file, the WebMCP component, has no annotations, so JS is a rename)
    const renamed = lang === "js" ? relPath.replace(/\.tsx$/, ".jsx") : relPath;
    const dest = relPath.startsWith("components/")
      ? `${layout.hasSrcDir ? "src/" : ""}${renamed}`
      : renamed;
    actions.push({ type: "write", dest, content: file.content });
  }

  // Generated robots rules are staged, never served: the owner merges them (generator review is a later slice)
  const robots = files.find((f) => f.filename === "robots.txt");
  if (robots) actions.push({ type: "write", dest: STAGED_ROBOTS, content: robots.content });

  // Post-install: suggest adding build script to package.json
  const guarded = guardInstallActions(actions, projectDir);
  warnings.push(...guarded.warnings);
  for (const copy of mergeCopies) {
    const name = copy.dest.split("/").pop();
    if (hasWrittenCopy(guarded.actions, copy.dest)) {
      guarded.actions.push({
        type: "manual",
        dest: copy.manualDest,
        reason: `Existing ${edgeFn} found. Merge the content from ${name} into your existing ${edgeFn}.`,
      });
      warnings.push(`Existing ${edgeFn} found — saved as ${name}. Merge manually.`);
    } else {
      guarded.actions.push({
        type: "manual",
        dest: copy.manualDest,
        reason:
          `Existing ${edgeFn} found, but the w2agent ${edgeFn} was not written (see warnings). ` +
          "Merge it by hand, for example from `w2agent integrate <url> --output <dir>`.",
      });
    }
  }

  if (robots) {
    const staged = hasWrittenCopy(guarded.actions, STAGED_ROBOTS)
      ? STAGED_ROBOTS
      : `the generated AI-crawler rules (${STAGED_ROBOTS} was not written, see warnings; \`w2agent integrate <url> --output <dir>\` writes the file)`;
    const publicRobots = "public/robots.txt";
    const metadataRoute = [appPrefix, "app", "src/app"]
      .flatMap((dir) => ["ts", "js", "tsx", "jsx", "txt"].map((e) => `${dir}/robots.${e}`))
      .find((p) => existsSync(join(projectDir, p)));
    if (!existsSync(join(projectDir, publicRobots)) && metadataRoute) {
      guarded.actions.push({
        type: "manual",
        dest: metadataRoute,
        reason: metadataRoute.endsWith(".txt")
          ? `Merge the rules from ${staged} into your existing ${metadataRoute}.`
          : `Add the rules from ${staged} to what the metadata route ${metadataRoute} returns.`,
      });
    } else if (existsSync(join(projectDir, publicRobots))) {
      guarded.actions.push({
        type: "manual",
        dest: publicRobots,
        reason: `Merge the rules from ${staged} into your existing ${publicRobots}.`,
      });
    } else {
      guarded.actions.push({
        type: "manual",
        dest: publicRobots,
        reason: `No robots.txt found. Review ${staged} and copy it to ${publicRobots} to serve it.`,
      });
    }
  }

  if (willWrite(guarded.actions, "w2agent-build.mjs")) {
    postInstallSteps.push(
      'Add `"prebuild": "node w2agent-build.mjs"` to your package.json scripts (not postbuild: the routes are prerendered during `next build`, so a postbuild refresh is not served). Needs the w2agent CLI installed in this project: it is not published on npm yet, so build it from the w2agent repo and run `npm install -D <path-to-w2agent>/packages/cli`.',
    );
  }

  const webmcpWrite = guarded.actions.find(
    (a) => a.type === "write" && /\/WebMcpScript\.(tsx|jsx)$/.test(a.dest),
  );
  if (webmcpWrite) {
    const existing = ["tsx", "jsx", "ts", "js"]
      .map((layoutExt) => `${appPrefix}/layout.${layoutExt}`)
      .find((p) => existsSync(join(projectDir, p)));
    const target = existing
      ? existing
      : `your root layout (${appPrefix}/layout.${lang === "ts" ? "tsx" : "jsx"})`;
    postInstallSteps.push(
      `Import WebMcpScript from ${webmcpWrite.dest} in ${target} and render <WebMcpScript /> inside <body> so the WebMCP tools register on every page.`,
    );
  }

  return { platform: "nextjs", actions: guarded.actions, warnings, postInstallSteps };
}
