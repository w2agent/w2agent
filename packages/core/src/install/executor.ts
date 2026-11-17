import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkDestination, describeDestProblem } from "./guard.js";
import type { InstallPlan } from "./types.js";

export interface ExecuteResult {
  installed: string[];
  skipped: string[];
  manual: string[];
}

export function executeInstallPlan(plan: InstallPlan, projectDir: string): ExecuteResult {
  const installed: string[] = [];
  const skipped: string[] = [];
  const manual: string[] = [];

  for (const action of plan.actions) {
    switch (action.type) {
      case "write": {
        const problem = checkDestination(projectDir, action.dest);
        if (problem) {
          skipped.push(`${action.dest} (${describeDestProblem(problem)}, not written)`);
          break;
        }
        const destPath = resolve(projectDir, action.dest);
        try {
          mkdirSync(dirname(destPath), { recursive: true });
          writeFileSync(destPath, action.content ?? "", { encoding: "utf-8", flag: "wx" });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          skipped.push(
            code === "EEXIST"
              ? `${action.dest} (already exists, not overwritten)`
              : `${action.dest} (could not be written: ${code ?? (err as Error).message})`,
          );
          break;
        }
        installed.push(action.dest);
        break;
      }
      case "skip": {
        const msg = action.reason ? `${action.dest} (${action.reason})` : action.dest;
        skipped.push(msg);
        break;
      }
      case "manual": {
        const msg = action.reason ? `${action.dest}: ${action.reason}` : action.dest;
        manual.push(msg);
        break;
      }
    }
  }

  return { installed, skipped, manual };
}

export function formatInstallSummary(
  plan: InstallPlan,
  result: ExecuteResult,
  projectDir: string,
  url: string,
  platformName: string,
  dryRun = false,
): string {
  const lines: string[] = [];
  const label = dryRun ? "w2agent integrate --install --dry-run" : "w2agent integrate --install";

  lines.push("");
  lines.push(`  ${label} — ${platformName}`);
  lines.push(`  ${"─".repeat(40)}`);
  lines.push("");
  lines.push(`  URL: ${url}`);
  lines.push(`  Project: ${projectDir}`);
  lines.push("");

  if (result.installed.length > 0) {
    lines.push(dryRun ? "  Will install:" : "  Installed:");
    for (const f of result.installed) {
      lines.push(`  ✓ ${f}`);
    }
  }

  if (result.skipped.length > 0) {
    lines.push("");
    lines.push("  Skipped:");
    for (const f of result.skipped) {
      lines.push(`  ⚠ ${f}`);
    }
  }

  if (result.manual.length > 0) {
    lines.push("");
    lines.push("  Manual steps needed:");
    for (const f of result.manual) {
      lines.push(`  → ${f}`);
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("  Warnings:");
    for (const w of plan.warnings) {
      lines.push(`  ⚠ ${w}`);
    }
  }

  if (plan.postInstallSteps.length > 0) {
    lines.push("");
    lines.push("  Post-install steps:");
    for (let i = 0; i < plan.postInstallSteps.length; i++) {
      lines.push(`  ${i + 1}. ${plan.postInstallSteps[i]}`);
    }
  }

  lines.push("");
  if (!dryRun) {
    lines.push("  Re-run your audit to verify the score improvement.");
  }
  lines.push("");

  return lines.join("\n");
}
