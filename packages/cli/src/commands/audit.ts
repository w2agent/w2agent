import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import ora from "ora";
import {
  AuditError,
  type AuditOptions,
  allChecks,
  type CategoryId,
  clearChecks,
  type EdgeEvidence,
  formatEdgeEvidenceLine,
  loadConfig,
  mergeConfigWithOptions,
  registerChecks,
  runAudit,
} from "w2agent-core";
import { formatJson } from "../output/json.js";
import { formatReport, formatVerboseReport } from "../output/terminal.js";

function isPlausibleUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  // Forgiving: anything with structure passes. Custom TLDs (.internal, .corp,
  // .local), IPv4 (dots), IPv6 (colons), and localhost are all accepted.
  // Only bare words like "not-a-url" or "foo" are rejected.
  return host.includes(".") || host.includes(":") || host === "localhost";
}

/**
 * Duck-typed like the platform's catch sites: an AuditError from a differently
 * built copy of core is not `instanceof` ours, and a non-AuditError throw must
 * not turn into a second failure here.
 */
export function edgeEvidenceOf(err: unknown): EdgeEvidence | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { name?: unknown; evidence?: { edge?: EdgeEvidence } };
  if (!(err instanceof AuditError) && e.name !== "AuditError") return undefined;
  return e.evidence?.edge;
}

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
    .option(
      "--allow-host <host>",
      "Allow off-origin host when discovering OpenAPI/Swagger specs (repeatable)",
      (value: string, acc: string[] = []) => acc.concat(value),
      [] as string[],
    )
    .action(async (url: string, opts) => {
      const config = loadConfig();

      const categories = opts.category ? [opts.category as CategoryId] : undefined;
      const allowedOffOriginHosts: string[] | undefined =
        Array.isArray(opts.allowHost) && opts.allowHost.length > 0 ? opts.allowHost : undefined;

      const auditOptions = mergeConfigWithOptions(config, {
        maxPages: parseInt(opts.depth, 10),
        timeout: parseInt(opts.timeout, 10),
        categories,
        verbose: opts.verbose ?? false,
        ...(allowedOffOriginHosts ? { allowedOffOriginHosts } : {}),
      }) as AuditOptions;

      // Ensure URL has protocol
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      if (!isPlausibleUrl(url)) {
        console.error(`Invalid URL: "${url}". Please provide a full URL like https://example.com.`);
        process.exit(1);
      }

      clearChecks();
      registerChecks(allChecks);

      const spinner = ora("Starting audit...").start();

      try {
        const report = await runAudit(url, auditOptions, (status) => {
          spinner.text = status;
        });

        spinner.stop();

        const output =
          opts.format === "json"
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
          const threshold = parseInt(opts.threshold, 10);
          if (report.overallScore < threshold) {
            console.error(`Score ${report.overallScore} is below threshold ${threshold}`);
            process.exit(1);
          }
        }
      } catch (err) {
        spinner.fail(`Audit failed: ${(err as Error).message}`);
        const edge = edgeEvidenceOf(err);
        if (edge) console.error(formatEdgeEvidenceLine(edge));
        process.exit(1);
      }
    });
}
