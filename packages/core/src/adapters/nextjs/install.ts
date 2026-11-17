import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../../generate/types.js";
import { guardInstallActions, hasWrittenCopy, willWrite } from "../../install/guard.js";
import type { InstallAction, InstallPlan } from "../../install/types.js";

interface NextjsLayout {
  hasSrcDir: boolean;
  hasAppDir: boolean;
  hasPagesDir: boolean;
  hasMiddleware: boolean;
  hasExistingLlmsRoute: boolean;
  hasExistingW2agentLlms: boolean;
  hasExistingBuildScript: boolean;
  hasW2agentRefs: boolean;
}

export function detectNextjsLayout(projectDir: string): NextjsLayout {
  const hasSrcDir = existsSync(join(projectDir, "src"));
  const hasAppDir =
    existsSync(join(projectDir, "app")) || existsSync(join(projectDir, "src", "app"));
  const hasPagesDir =
    existsSync(join(projectDir, "pages")) || existsSync(join(projectDir, "src", "pages"));

  const hasMiddleware =
    existsSync(join(projectDir, "middleware.ts")) ||
    existsSync(join(projectDir, "middleware.js")) ||
    existsSync(join(projectDir, "src", "middleware.ts")) ||
    existsSync(join(projectDir, "src", "middleware.js"));

  const appRoot = hasSrcDir && existsSync(join(projectDir, "src", "app")) ? "src/app" : "app";
  const hasExistingLlmsRoute = existsSync(join(projectDir, appRoot, "llms.txt", "route.ts"));
  const hasExistingW2agentLlms = existsSync(join(projectDir, ".w2agent", "llms.txt"));
  const hasExistingBuildScript = existsSync(join(projectDir, "w2agent-build.mjs"));

  let hasW2agentRefs = false;
  if (hasMiddleware) {
    for (const p of [
      join(projectDir, "middleware.ts"),
      join(projectDir, "middleware.js"),
      join(projectDir, "src", "middleware.ts"),
      join(projectDir, "src", "middleware.js"),
    ]) {
      if (existsSync(p)) {
        const content = readFileSync(p, "utf-8");
        if (content.includes("w2agent") || content.includes("llms.txt")) {
          hasW2agentRefs = true;
          break;
        }
      }
    }
  }

  return {
    hasSrcDir: hasSrcDir && existsSync(join(projectDir, "src", "app")),
    hasAppDir,
    hasPagesDir,
    hasMiddleware,
    hasExistingLlmsRoute,
    hasExistingW2agentLlms,
    hasExistingBuildScript,
    hasW2agentRefs,
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

  for (const file of platformFiles) {
    const relPath = file.filename.slice(prefix.length);
    const baseName = relPath.split("/").pop() || relPath;

    // Skip INSTALL.md
    if (baseName === "INSTALL.md") continue;

    // Route handler files — adjust for src/app layout
    if (relPath.startsWith("app/")) {
      const adjustedPath = relPath.replace(/^app\//, `${appPrefix}/`);

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
      actions.push({ type: "write", dest: adjustedPath, content: file.content });
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

    // middleware.ts
    if (baseName === "middleware.ts" || baseName === "middleware.js") {
      if (layout.hasW2agentRefs) {
        actions.push({
          type: "skip",
          dest: relPath,
          reason: "already has w2agent integration",
        });
        continue;
      }

      if (layout.hasMiddleware) {
        const mergedName = relPath.replace(/\.(ts|js)$/, ".w2agent.$1");
        actions.push({ type: "write", dest: mergedName, content: file.content });
        mergeCopies.push({ dest: mergedName, manualDest: relPath });
        continue;
      }

      actions.push({ type: "write", dest: relPath, content: file.content });
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

    // Everything else: write
    actions.push({ type: "write", dest: relPath, content: file.content });
  }

  // Post-install: suggest adding build script to package.json
  const guarded = guardInstallActions(actions, projectDir);
  warnings.push(...guarded.warnings);
  for (const copy of mergeCopies) {
    const name = copy.dest.split("/").pop();
    if (hasWrittenCopy(guarded.actions, copy.dest)) {
      guarded.actions.push({
        type: "manual",
        dest: copy.manualDest,
        reason: `Existing middleware found. Merge the content from ${name} into your existing middleware.`,
      });
      warnings.push(`Existing middleware found — saved as ${name}. Merge manually.`);
    } else {
      guarded.actions.push({
        type: "manual",
        dest: copy.manualDest,
        reason:
          "Existing middleware found, but the w2agent middleware was not written (see warnings). " +
          "Merge it by hand, for example from `w2agent integrate <url> --output <dir>`.",
      });
    }
  }

  if (willWrite(guarded.actions, "w2agent-build.mjs")) {
    postInstallSteps.push(
      'Add `"postbuild": "node w2agent-build.mjs"` to your package.json scripts.',
    );
  }

  const webmcpWrite = guarded.actions.find(
    (a) => a.type === "write" && a.dest.endsWith("/WebMcpScript.tsx"),
  );
  if (webmcpWrite) {
    const existing = ["tsx", "jsx", "ts", "js"]
      .map((ext) => `${appPrefix}/layout.${ext}`)
      .find((p) => existsSync(join(projectDir, p)));
    const target = existing ? existing : `your root layout (${appPrefix}/layout.tsx)`;
    postInstallSteps.push(
      `Import WebMcpScript from ${webmcpWrite.dest} in ${target} and render <WebMcpScript /> inside <body> so the WebMCP tools register on every page.`,
    );
  }

  return { platform: "nextjs", actions: guarded.actions, warnings, postInstallSteps };
}
