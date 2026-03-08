import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PlatformAdapter, PlatformId } from "../adapters/types.js";
import type { GeneratedFile } from "../generate/types.js";
import type { InstallAction, InstallPlan } from "./types.js";

const SKIP_ON_INSTALL = ["INSTALL.md"];

const MERGE_FILES = ["middleware.ts"];

export function planInstall(
  adapter: PlatformAdapter,
  generatedFiles: GeneratedFile[],
  projectDir: string,
): InstallPlan {
  // If adapter has a custom resolver, use it
  if (adapter.resolveInstall) {
    return adapter.resolveInstall(generatedFiles, projectDir);
  }

  // Fallback: replicate current behavior as an InstallPlan
  return planInstallFallback(adapter.id, generatedFiles, projectDir);
}

function planInstallFallback(
  platformId: PlatformId,
  generatedFiles: GeneratedFile[],
  projectDir: string,
): InstallPlan {
  const prefix = `${platformId}/`;
  const platformFiles = generatedFiles.filter((f) => f.filename.startsWith(prefix));
  const actions: InstallAction[] = [];
  const warnings: string[] = [];
  const postInstallSteps: string[] = [];

  // Check if platform has route handlers (e.g., Next.js app/llms.txt/route.ts)
  const hasRouteHandlers = platformFiles.some(
    (f) => f.filename.includes("/app/llms.txt/") || f.filename.includes("/app/llms-full.txt/"),
  );

  // Seed files (core llms.txt / llms-full.txt) go to public/ if no route handlers
  if (!hasRouteHandlers) {
    const seedFiles = generatedFiles.filter(
      (f) => f.filename === "llms.txt" || f.filename === "llms-full.txt",
    );
    for (const file of seedFiles) {
      actions.push({
        type: "write",
        dest: `public/${file.filename}`,
        content: file.content,
      });
    }
  }

  for (const file of platformFiles) {
    const relPath = file.filename.slice(prefix.length);
    const baseName = relPath.split("/").pop() || relPath;

    if (SKIP_ON_INSTALL.includes(baseName)) {
      continue;
    }

    const destPath = resolve(projectDir, relPath);

    if (MERGE_FILES.includes(baseName) && existsSync(destPath)) {
      const existing = readFileSync(destPath, "utf-8");
      if (existing.includes("w2agent") || existing.includes("llms.txt")) {
        actions.push({
          type: "skip",
          dest: relPath,
          reason: "already has w2agent integration",
        });
        continue;
      }
      const mergedName = relPath.replace(/\.ts$/, ".w2agent.ts");
      actions.push({
        type: "write",
        dest: mergedName,
        content: file.content,
      });
      warnings.push(
        `Existing ${baseName} found — saved as ${baseName.replace(/\.ts$/, ".w2agent.ts")}. Merge manually.`,
      );
      continue;
    }

    actions.push({
      type: "write",
      dest: relPath,
      content: file.content,
    });
  }

  return { platform: platformId, actions, warnings, postInstallSteps };
}
