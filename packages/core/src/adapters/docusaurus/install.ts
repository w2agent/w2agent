import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../../generate/types.js";
import { guardInstallActions, willWrite } from "../../install/guard.js";
import type { InstallAction, InstallPlan } from "../../install/types.js";

interface DocusaurusLayout {
  hasConfig: boolean;
  hasW2agentInConfig: boolean;
  hasExistingStaticLlms: boolean;
  hasExistingPlugin: boolean;
  hasGrayMatter: boolean;
}

export function detectDocusaurusLayout(projectDir: string): DocusaurusLayout {
  let hasConfig = false;
  let hasW2agentInConfig = false;
  for (const name of ["docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs"]) {
    const configPath = join(projectDir, name);
    if (existsSync(configPath)) {
      hasConfig = true;
      try {
        const content = readFileSync(configPath, "utf-8");
        if (content.includes("w2agent")) {
          hasW2agentInConfig = true;
        }
      } catch {}
      break;
    }
  }

  let hasGrayMatter = false;
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      hasGrayMatter = !!deps["gray-matter"];
    } catch {}
  }

  return {
    hasConfig,
    hasW2agentInConfig,
    hasExistingStaticLlms: existsSync(join(projectDir, "static", "llms.txt")),
    hasExistingPlugin: existsSync(join(projectDir, "w2agent-plugin.js")),
    hasGrayMatter,
  };
}

export function resolveDocusaurusInstall(files: GeneratedFile[], projectDir: string): InstallPlan {
  const layout = detectDocusaurusLayout(projectDir);
  const actions: InstallAction[] = [];
  const warnings: string[] = [];
  const postInstallSteps: string[] = [];

  if (!layout.hasConfig) {
    warnings.push("No docusaurus.config found — installing files to static/ anyway.");
  }

  const prefix = "docusaurus/";
  const platformFiles = files.filter((f) => f.filename.startsWith(prefix));

  let pluginDest: string | null = null;

  for (const file of platformFiles) {
    const relPath = file.filename.slice(prefix.length);
    const baseName = relPath.split("/").pop() || relPath;

    if (baseName === "INSTALL.md") continue;

    // Plugin file
    if (baseName === "w2agent-plugin.js") {
      if (layout.hasExistingPlugin || layout.hasW2agentInConfig) {
        actions.push({
          type: "skip",
          dest: relPath,
          reason: "already configured",
        });
        warnings.push("w2agent plugin already configured — skipping plugin file.");
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      pluginDest = relPath;
      continue;
    }

    // Static files
    if (relPath.startsWith("static/")) {
      if (relPath === "static/llms.txt" && layout.hasExistingStaticLlms) {
        actions.push({ type: "skip", dest: relPath, reason: "file already exists" });
        warnings.push("Existing static/llms.txt found — skipping.");
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    actions.push({ type: "write", dest: relPath, content: file.content });
  }

  const guarded = guardInstallActions(actions, projectDir);
  warnings.push(...guarded.warnings);
  if (pluginDest && willWrite(guarded.actions, pluginDest)) {
    postInstallSteps.push('Add plugin to docusaurus.config.js: plugins: ["./w2agent-plugin.js"]');
  }

  if (!layout.hasGrayMatter && pluginDest && willWrite(guarded.actions, pluginDest)) {
    postInstallSteps.push("Install gray-matter: npm install gray-matter");
  }

  return { platform: "docusaurus", actions: guarded.actions, warnings, postInstallSteps };
}
