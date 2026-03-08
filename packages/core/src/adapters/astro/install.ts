import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../../generate/types.js";
import type { InstallAction, InstallPlan } from "../../install/types.js";

type AstroOutputMode = "static" | "server" | "hybrid" | "unknown";

interface AstroLayout {
  outputMode: AstroOutputMode;
  configFile: string | null;
  hasExistingPublicLlms: boolean;
  hasExistingBuildScript: boolean;
  hasExistingIntegration: boolean;
}

export function detectAstroLayout(projectDir: string): AstroLayout {
  let configFile: string | null = null;
  for (const name of ["astro.config.mjs", "astro.config.ts", "astro.config.js"]) {
    if (existsSync(join(projectDir, name))) {
      configFile = name;
      break;
    }
  }

  let outputMode: AstroOutputMode = "static";
  if (configFile) {
    try {
      const content = readFileSync(join(projectDir, configFile), "utf-8");
      if (/output\s*:\s*["']server["']/.test(content)) {
        outputMode = "server";
      } else if (/output\s*:\s*["']hybrid["']/.test(content)) {
        outputMode = "hybrid";
      }
    } catch {
      outputMode = "unknown";
    }
  } else {
    outputMode = "unknown";
  }

  return {
    outputMode,
    configFile,
    hasExistingPublicLlms: existsSync(join(projectDir, "public", "llms.txt")),
    hasExistingBuildScript: existsSync(join(projectDir, "w2agent-build.mjs")),
    hasExistingIntegration: existsSync(join(projectDir, "w2agent-integration.mjs")),
  };
}

export function resolveAstroInstall(files: GeneratedFile[], projectDir: string): InstallPlan {
  const layout = detectAstroLayout(projectDir);
  const actions: InstallAction[] = [];
  const warnings: string[] = [];
  const postInstallSteps: string[] = [];

  if (!layout.configFile) {
    warnings.push("Could not detect astro.config — proceeding with public/ files only.");
  }

  const isSSR = layout.outputMode === "server" || layout.outputMode === "hybrid";
  const prefix = "astro/";
  const platformFiles = files.filter((f) => f.filename.startsWith(prefix));

  for (const file of platformFiles) {
    const relPath = file.filename.slice(prefix.length);
    const baseName = relPath.split("/").pop() || relPath;

    if (baseName === "INSTALL.md") continue;

    // SSR endpoints — only install in server/hybrid mode
    if (relPath.startsWith("src/pages/")) {
      if (!isSSR) {
        actions.push({
          type: "skip",
          dest: relPath,
          reason: "static output mode — SSR endpoints not applicable",
        });
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    // Public files
    if (relPath.startsWith("public/")) {
      if (relPath === "public/llms.txt" && layout.hasExistingPublicLlms) {
        actions.push({ type: "skip", dest: relPath, reason: "file already exists" });
        warnings.push("Existing public/llms.txt found — skipping.");
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    // Integration plugin
    if (baseName === "w2agent-integration.mjs") {
      if (layout.hasExistingIntegration) {
        actions.push({ type: "skip", dest: relPath, reason: "already exists" });
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      postInstallSteps.push(
        "Add w2agent integration to your astro.config: integrations: [w2agentIntegration()]",
      );
      continue;
    }

    // Build script
    if (baseName === "w2agent-build.mjs") {
      if (layout.hasExistingBuildScript) {
        actions.push({ type: "skip", dest: relPath, reason: "already exists" });
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    actions.push({ type: "write", dest: relPath, content: file.content });
  }

  return { platform: "astro", actions, warnings, postInstallSteps };
}
