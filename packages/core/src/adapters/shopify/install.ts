import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../../generate/types.js";
import { guardInstallActions, willWrite } from "../../install/guard.js";
import type { InstallAction, InstallPlan } from "../../install/types.js";

interface ShopifyLayout {
  isThemeDir: boolean;
}

const OUTPUT_HINT = "`w2agent integrate <url> --platform shopify --output <dir>` writes the file";

const MANUAL_REASONS: Record<string, string> = {
  "templates/llms.txt.liquid": `Optional. Shopify already serves /llms.txt. This template would replace the managed content at /llms.txt only (not /agents.md); add it as templates/llms.txt.liquid in your theme only if you want it. ${OUTPUT_HINT}.`,
  "data/robots-txt-additions.txt": `Not a theme file. Paste its groups at the end of your theme's existing templates/robots.txt.liquid (after the robots.default_groups loop and your own rules). If the theme has no robots.txt.liquid, do not create one from these groups alone. ${OUTPUT_HINT}.`,
  "W2AGENT-MCP-WEBHOOK.md": `Not a theme file. It holds webhook notes for the MCP server. ${OUTPUT_HINT}.`,
};

export function detectShopifyLayout(projectDir: string): ShopifyLayout {
  const isThemeDir =
    existsSync(join(projectDir, "layout", "theme.liquid")) ||
    existsSync(join(projectDir, "config", "settings_schema.json"));

  return { isThemeDir };
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

    if (relPath in MANUAL_REASONS) {
      actions.push({ type: "manual", dest: relPath, reason: MANUAL_REASONS[relPath] });
      continue;
    }

    if (!relPath.startsWith("snippets/")) continue;

    actions.push({ type: "write", dest: relPath, content: file.content });
  }

  const guarded = guardInstallActions(actions, projectDir);
  warnings.push(...guarded.warnings);

  const headWritten = willWrite(guarded.actions, "snippets/w2agent-head.liquid");
  const webmcpWritten = willWrite(guarded.actions, "snippets/w2agent-webmcp.liquid");
  if (headWritten) {
    postInstallSteps.push("Add {% render 'w2agent-head' %} to your theme.liquid <head> section.");
  }
  if (webmcpWritten) {
    postInstallSteps.push(
      "Add {% render 'w2agent-webmcp' %} to your theme.liquid just before </body>.",
    );
  }
  const written = guarded.actions.filter((a) => a.type === "write").map((a) => a.dest);
  if (written.length > 0) {
    const pushed = headWritten || webmcpWritten ? [...written, "layout/theme.liquid"] : written;
    const only = pushed.map((d) => `--only ${d}`).join(" ");
    postInstallSteps.push(
      `Push the new files and your edited layout/theme.liquid to a copy of your theme, not the live one: shopify theme push --theme <development-theme-id-or-name> ${only}. Preview it, then publish from the admin.`,
    );
  }

  return { platform: "shopify", actions: guarded.actions, warnings, postInstallSteps };
}
