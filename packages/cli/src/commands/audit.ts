import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import ora from "ora";
import {
  AuditError,
  type AuditOptions,
  allChecks,
  CATEGORY_CONFIG,
  type CategoryId,
  clearChecks,
  type EdgeEvidence,
  type EdgeVerdict,
  formatEdgeEvidenceLine,
  loadConfig,
  mergeConfigWithOptions,
  registerChecks,
  runAudit,
} from "w2agent-core";
import {
  currentArgv,
  enterJsonMode,
  failWith,
  isReason,
  type JsonMode,
  jsonRequested,
  type Reason,
} from "../agent/output.js";
import { formatJson } from "../output/json.js";
import { formatReport, formatVerboseReport } from "../output/terminal.js";

export function isPlausibleUrl(url: string): boolean {
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
  const e = err as { name?: unknown; evidence?: { edge?: unknown } };
  if (!(err instanceof AuditError) && e.name !== "AuditError") return undefined;
  const edge = e.evidence?.edge;
  return isEdgeEvidence(edge) ? edge : undefined;
}

// Pinned to core's union in both directions: a core that adds a fifth verdict
// fails the build here instead of silently dropping a real payload, which would
// be indistinguishable from "no evidence collected".
const VERDICTS: readonly EdgeVerdict[] = Object.keys({
  "all-blocked": true,
  "agents-allowed": true,
  mixed: true,
  unknown: true,
} satisfies Record<EdgeVerdict, true>) as EdgeVerdict[];

/**
 * Only the fields the line reads, so a newer core carrying extra ones still
 * prints. A payload from a mismatched build that lacks `agents` would otherwise
 * throw inside the catch that was reporting the real audit failure.
 */
function isEdgeEvidence(edge: unknown): edge is EdgeEvidence {
  if (typeof edge !== "object" || edge === null || Array.isArray(edge)) return false;
  const e = edge as { verdict?: unknown; agents?: unknown };
  return (
    typeof e.verdict === "string" &&
    (VERDICTS as readonly string[]).includes(e.verdict) &&
    Array.isArray(e.agents)
  );
}

const FORMATS = ["terminal", "json"];

export function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function parseNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function withLargerTimeout(argv: readonly string[], currentMs: number): string[] {
  const larger = String(currentMs * 2);
  const end = argv.indexOf("--");
  const head = end === -1 ? argv : argv.slice(0, end);
  const tail = end === -1 ? [] : argv.slice(end);
  const out: string[] = [];
  let replaced = false;
  for (let i = 0; i < head.length; i++) {
    const arg = head[i];
    if (arg === "--timeout" && i + 1 < head.length) {
      out.push(arg, larger);
      i++;
      replaced = true;
    } else if (arg.startsWith("--timeout=")) {
      out.push(`--timeout=${larger}`);
      replaced = true;
    } else {
      out.push(arg);
    }
  }
  if (!replaced) out.push("--timeout", larger);
  return [...out, ...tail];
}

function invalidArgument(opts: Record<string, unknown>): string | undefined {
  if (!FORMATS.includes(opts.format as string)) {
    return `Invalid --format "${opts.format}". Use one of: ${FORMATS.join(", ")}.`;
  }
  const categoryIds = Object.keys(CATEGORY_CONFIG);
  if (opts.category !== undefined && !categoryIds.includes(opts.category as string)) {
    return `Invalid --category "${opts.category}". Use one of: ${categoryIds.join(", ")}.`;
  }
  for (const flag of ["depth", "timeout"]) {
    if (parsePositiveInt(opts[flag]) === undefined) {
      return `Invalid --${flag} "${opts[flag]}". Use a positive integer.`;
    }
  }
  if (parseNonNegativeInt(opts.threshold) === undefined) {
    return `Invalid --threshold "${opts.threshold}". Use a non-negative integer.`;
  }
  return undefined;
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
    .option("--ci", "CI mode: exit with non-zero code when the score is below the threshold")
    .option("--threshold <score>", "Minimum score threshold for CI mode", "70")
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .option("--json", "Print one JSON document on stdout (the report, or an error envelope)")
    .option(
      "--allow-host <host>",
      "Allow off-origin host when discovering OpenAPI/Swagger specs (repeatable)",
      (value: string, acc: string[] = []) => acc.concat(value),
      [] as string[],
    )
    .action(async (url: string, opts) => {
      const json: JsonMode | undefined = jsonRequested() ? enterJsonMode() : undefined;
      const argv = currentArgv();

      // Ensure URL has protocol
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      if (!isPlausibleUrl(url)) {
        await failWith(
          json,
          {
            reason: "invalid_url",
            message: `Invalid URL: "${url}". Please provide a full URL like https://example.com.`,
          },
          argv,
        );
        return;
      }

      const badArgument = invalidArgument(opts);
      if (badArgument) {
        await failWith(
          json,
          { reason: "invalid_argument", message: badArgument, next: [["w2agent", "schema"]] },
          argv,
        );
        return;
      }

      const config = loadConfig();

      const categories = opts.category ? [opts.category as CategoryId] : undefined;
      const allowedOffOriginHosts: string[] | undefined =
        Array.isArray(opts.allowHost) && opts.allowHost.length > 0 ? opts.allowHost : undefined;
      const timeout = parsePositiveInt(opts.timeout) as number;

      const auditOptions = mergeConfigWithOptions(config, {
        maxPages: parsePositiveInt(opts.depth),
        timeout,
        categories,
        verbose: opts.verbose ?? false,
        ...(allowedOffOriginHosts ? { allowedOffOriginHosts } : {}),
      }) as AuditOptions;

      clearChecks();
      registerChecks(allChecks);

      const spinner = json ? undefined : ora("Starting audit...").start();

      try {
        const report = await runAudit(url, auditOptions, (status) => {
          if (spinner) spinner.text = status;
        });

        spinner?.stop();

        const output =
          json || opts.format === "json"
            ? formatJson(report)
            : opts.verbose
              ? formatVerboseReport(report)
              : formatReport(report);

        if (opts.output) {
          writeFileSync(opts.output, output, "utf-8");
          console.log(`Report written to ${opts.output}`);
        }

        const threshold = parseNonNegativeInt(opts.threshold) as number;
        const below = opts.ci && report.overallScore < threshold;

        if (below && json) {
          await failWith(
            json,
            {
              reason: "below_threshold",
              message: `Score ${report.overallScore} is below threshold ${threshold}`,
            },
            argv,
          );
          return;
        }

        if (json) {
          await json.emit(output);
        } else if (!opts.output) {
          console.log(output);
        }

        if (below) {
          console.error(`Score ${report.overallScore} is below threshold ${threshold}`);
          process.exitCode = 1;
        }
      } catch (err) {
        const message = (err as Error).message;
        const rawKind = (err as { kind?: unknown }).kind;
        const isAuditError =
          err instanceof AuditError || (err as { name?: unknown }).name === "AuditError";
        const kind: Reason =
          isAuditError && typeof rawKind === "string" && isReason(rawKind)
            ? rawKind
            : "unknown_failure";
        const edge = edgeEvidenceOf(err);
        if (!json) {
          spinner?.fail(`Audit failed: ${message}`);
          if (edge) console.error(formatEdgeEvidenceLine(edge));
          process.exitCode = 1;
          return;
        }
        if (edge) console.error(formatEdgeEvidenceLine(edge));
        await failWith(
          json,
          {
            reason: kind,
            message,
            next: kind === "timeout" ? [withLargerTimeout(argv, timeout)] : [],
          },
          argv,
        );
      }
    });
}
