import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

    actions.push({ type: "write", dest: relPath, content: file.content });
  }

  const guarded = guardInstallActions(actions, projectDir);
  warnings.push(...guarded.warnings);
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
