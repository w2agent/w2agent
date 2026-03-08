import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeneratedFile } from "../../generate/types.js";
import type { InstallAction, InstallPlan } from "../../install/types.js";

interface WordPressLayout {
  isWpRoot: boolean;
  pluginDir: string;
  hasExistingPlugin: boolean;
}

export function detectWordPressLayout(projectDir: string): WordPressLayout {
  const isWpRoot = existsSync(join(projectDir, "wp-content", "plugins"));

  // Check wp-config.php for custom plugin dir
  let pluginDir = "wp-content/plugins";
  const wpConfigPath = join(projectDir, "wp-config.php");
  if (existsSync(wpConfigPath)) {
    try {
      const content = readFileSync(wpConfigPath, "utf-8");
      const match = content.match(/WP_PLUGIN_DIR['"]\s*,\s*['"]([^'"]+)['"]/);
      if (match) pluginDir = match[1];
    } catch {}
  }

  const hasExistingPlugin = existsSync(join(projectDir, pluginDir, "w2agent"));

  return { isWpRoot, pluginDir, hasExistingPlugin };
}

export function resolveWordPressInstall(files: GeneratedFile[], projectDir: string): InstallPlan {
  const layout = detectWordPressLayout(projectDir);
  const actions: InstallAction[] = [];
  const warnings: string[] = [];
  const postInstallSteps: string[] = [];

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

  postInstallSteps.push("Activate the w2agent plugin in WordPress Admin → Plugins.");

  return { platform: "wordpress", actions, warnings, postInstallSteps };
}
