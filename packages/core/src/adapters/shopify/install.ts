import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../../generate/types.js";
import { guardInstallActions, hasWrittenCopy, willWrite } from "../../install/guard.js";
import type { InstallAction, InstallPlan } from "../../install/types.js";

interface ShopifyLayout {
  isThemeDir: boolean;
  hasExistingHeadSnippet: boolean;
  hasExistingRobotsTxt: boolean;
}

export function detectShopifyLayout(projectDir: string): ShopifyLayout {
  const isThemeDir =
    existsSync(join(projectDir, "layout", "theme.liquid")) ||
    existsSync(join(projectDir, "config", "settings_schema.json"));

  return {
    isThemeDir,
    hasExistingHeadSnippet: existsSync(join(projectDir, "snippets", "w2agent-head.liquid")),
    hasExistingRobotsTxt: existsSync(join(projectDir, "templates", "robots.txt.liquid")),
  };
}

export function resolveShopifyInstall(files: GeneratedFile[], projectDir: string): InstallPlan {
  const layout = detectShopifyLayout(projectDir);
  const actions: InstallAction[] = [];
  const warnings: string[] = [];
  const postInstallSteps: string[] = [];

  if (!layout.isThemeDir) {
    warnings.push(
      "Not a Shopify theme directory (no layout/theme.liquid or config/settings_schema.json). Files will be written to the output directory structure.",
    );
  }

  const prefix = "shopify/";
  const platformFiles = files.filter((f) => f.filename.startsWith(prefix));

  for (const file of platformFiles) {
    const relPath = file.filename.slice(prefix.length);
    const baseName = relPath.split("/").pop() || relPath;

    if (baseName === "INSTALL.md") continue;

    // Head snippet
    if (relPath === "snippets/w2agent-head.liquid") {
      if (layout.hasExistingHeadSnippet) {
        actions.push({ type: "skip", dest: relPath, reason: "snippet already exists" });
        warnings.push("Existing snippets/w2agent-head.liquid — skipping.");
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    // robots.txt.liquid — never overwrite
    if (relPath === "templates/robots.txt.liquid") {
      if (layout.hasExistingRobotsTxt) {
        actions.push({
          type: "skip",
          dest: relPath,
          reason: "existing robots.txt.liquid — merge w2agent rules manually",
        });
        continue;
      }
      actions.push({ type: "write", dest: relPath, content: file.content });
      continue;
    }

    // Data files — always write
    actions.push({ type: "write", dest: relPath, content: file.content });
  }

  const guarded = guardInstallActions(actions, projectDir);
  warnings.push(...guarded.warnings);
  if (willWrite(guarded.actions, "snippets/w2agent-head.liquid")) {
    postInstallSteps.push("Add {% render 'w2agent-head' %} to your theme.liquid <head> section.");
  }
  if (
    guarded.actions.some((a) => a.type === "skip" && a.dest === "templates/robots.txt.liquid") &&
    hasWrittenCopy(guarded.actions, "data/robots-txt-additions.txt")
  ) {
    postInstallSteps.push(
      "Merge w2agent rules from data/robots-txt-additions.txt into your existing templates/robots.txt.liquid.",
    );
  }

  return { platform: "shopify", actions: guarded.actions, warnings, postInstallSteps };
}
