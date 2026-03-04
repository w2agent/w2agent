import type { Command } from "commander";
import ora from "ora";
import { writeFileSync } from "node:fs";
import {
  runAudit,
  registerChecks,
  clearChecks,
  allChecks,
  loadConfig,
  mergeConfigWithOptions,
  type AuditOptions,
  type CategoryId,
} from "@w2agent/core";
import { formatReport, formatVerboseReport } from "../output/terminal.js";
import { formatJson } from "../output/json.js";

export function registerAuditCommand(program: Command): void {
  program
    .command("audit")
    .description("Audit a website for AI agent readiness")
    .argument("<url>", "URL to audit")
    .option("-d, --depth <number>", "Maximum pages to scan", "20")
    .option("-f, --format <format>", "Output format: terminal, json", "terminal")
    .option("-o, --output <file>", "Write report to file")
    .option("-c, --category <category>", "Audit specific category only")
    .option("-v, --verbose", "Show all checks, not just failures")
    .option("--ci", "CI mode: exit with code based on grade")
    .option("--threshold <score>", "Minimum score threshold for CI mode", "70")
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .action(async (url: string, opts) => {
      const config = loadConfig();

      const categories = opts.category
        ? [opts.category as CategoryId]
        : undefined;

      const auditOptions = mergeConfigWithOptions(config, {
        maxPages: parseInt(opts.depth),
        timeout: parseInt(opts.timeout),
        categories,
        verbose: opts.verbose ?? false,
      }) as AuditOptions;

      // Ensure URL has protocol
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      clearChecks();
      registerChecks(allChecks);

      const spinner = ora("Starting audit...").start();

      try {
        const report = await runAudit(url, auditOptions, (status) => {
          spinner.text = status;
        });

        spinner.stop();

        const output = opts.format === "json"
          ? formatJson(report)
          : opts.verbose
            ? formatVerboseReport(report)
            : formatReport(report);

        if (opts.output) {
          writeFileSync(opts.output, output, "utf-8");
          console.log(`Report written to ${opts.output}`);
        } else {
          console.log(output);
        }

        if (opts.ci) {
          const threshold = parseInt(opts.threshold);
          if (report.overallScore < threshold) {
            console.error(
              `Score ${report.overallScore} is below threshold ${threshold}`,
            );
            process.exit(1);
          }
        }
      } catch (err) {
        spinner.fail(`Audit failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
