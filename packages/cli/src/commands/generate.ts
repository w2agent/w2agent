import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import {
  type AuditOptions,
  allChecks,
  clearChecks,
  type GenerateFormat,
  type GenerateOptions,
  mapFailedChecksToFormats,
  registerChecks,
  runAudit,
  runGenerate,
} from "w2agent-core";

export function registerGenerateCommand(program: Command): void {
  program
    .command("generate")
    .description(
      "Generate AI-ready files: llms.txt, markdown, robots.txt, schema.org, agent card, FAQ",
    )
    .argument("<url>", "URL to generate content for")
    .option("-o, --output <dir>", "Output directory", "./w2agent-output")
    .option(
      "-f, --format <format>",
      "Output format, comma-separated or repeated: llms-txt, full, markdown, robots-txt, schema-org, agent-card, faq, webmcp, mcp-server, skill-md, openclaw, agents-md, all (default: all)",
      (value: string, acc: string[] = []) => acc.concat(value),
    )
    .option("-m, --max-pages <number>", "Maximum pages to crawl", "100")
    .option("-s, --sections <sections>", "Only include these URL sections (comma-separated)")
    .option("--mcp-endpoint <url>", "MCP server endpoint URL (for skill-md format)")
    .option(
      "--a2a-endpoint <url>",
      "Your live A2A agent endpoint URL (agent-card format is skipped without it)",
    )
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .option(
      "--allow-host <host>",
      "Allow off-origin host for generated-tool fetch targets (repeatable)",
      (value: string, acc: string[] = []) => acc.concat(value),
      [] as string[],
    )
    .option("--no-platform", "Do not write platform integration files (nextjs/, nuxt/, ...)")
    .option("--from-audit", "Run audit first, then generate fixes for failed checks only")
    .action(async (url: string, opts) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      let formats: GenerateFormat[];
      try {
        formats = parseFormats(opts.format);
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        process.exit(1);
      }
      const sections = opts.sections
        ? opts.sections.split(",").map((s: string) => s.trim())
        : undefined;
      let unfixableChecks: Array<{ id: string; message: string }> = [];

      const allowedOffOriginHosts: string[] | undefined =
        Array.isArray(opts.allowHost) && opts.allowHost.length > 0 ? opts.allowHost : undefined;

      const generateOptions: Partial<GenerateOptions> = {
        maxPages: parseInt(opts.maxPages, 10),
        timeout: parseInt(opts.timeout, 10),
        formats,
        platformFiles: opts.platform !== false,
        sections,
        mcpEndpoint: opts.mcpEndpoint,
        a2aEndpoint: opts.a2aEndpoint,
        ...(allowedOffOriginHosts ? { allowedOffOriginHosts } : {}),
      };

      const spinner = ora("Starting generation...").start();

      try {
        if (opts.fromAudit) {
          clearChecks();
          registerChecks(allChecks);

          spinner.text = "Running audit...";
          const auditReport = await runAudit(
            url,
            {
              maxPages: parseInt(opts.maxPages, 10),
              timeout: parseInt(opts.timeout, 10),
              ...(allowedOffOriginHosts ? { allowedOffOriginHosts } : {}),
            } as AuditOptions,
            (status) => {
              spinner.text = status;
            },
          );
          spinner.stop();

          const { formats: auditFormats, unfixable } = mapFailedChecksToFormats(auditReport);

          const gc = gradeColorFn(auditReport.grade);
          console.log("");
          console.log(chalk.bold("  w2agent audit → generate"));
          console.log(chalk.gray(`  ${"─".repeat(40)}`));
          console.log("");
          console.log(
            `  Audit Score: ${gc(`${auditReport.overallScore}/100`)} (${gc(auditReport.grade)})`,
          );
          console.log("");

          if (auditFormats.length === 0) {
            console.log(chalk.green("  ✓ All checks passed — nothing to generate!"));
            console.log("");
            return;
          }

          console.log(
            `  Generating fixes for ${chalk.cyan(String(auditFormats.length))} format(s):`,
          );
          for (const f of auditFormats) {
            console.log(`    ${chalk.blue("→")} ${f}`);
          }
          console.log("");

          generateOptions.formats = auditFormats;
          unfixableChecks = unfixable.map((c) => ({ id: c.id, message: c.message }));

          spinner.start("Starting generation...");
        }

        const result = await runGenerate(url, generateOptions, (status) => {
          spinner.text = status;
        });

        if (result.pagesFetched === 0) {
          spinner.fail(`No pages could be crawled from ${url} (nothing written)`);
          process.exit(1);
        }

        const requested = generateOptions.formats ?? [];
        if (result.pagesProcessed === 0 && requested.some((f) => CONTENT_FORMATS.includes(f))) {
          spinner.fail(
            `No page at ${url} had extractable content${sections ? " (or matched --sections)" : ""} (nothing written)`,
          );
          process.exit(1);
        }

        spinner.stop();

        if (result.pagesProcessed === 0) {
          console.log(
            chalk.yellow(
              "  ⚠ No page had extractable content (or matched --sections); output may be empty.",
            ),
          );
        }

        // Platform files embed crawl-derived seeds (llms.txt and friends), so an empty crawl
        // must not write them over a good seed.
        if (result.pagesProcessed === 0 && result.platform) {
          const prefix = `${result.platform.platform}/`;
          const skipped = result.files.filter((f) => f.filename.startsWith(prefix));
          if (skipped.length > 0) {
            result.files = result.files.filter((f) => !f.filename.startsWith(prefix));
            console.log(
              chalk.yellow(
                `  ⚠ ${skipped.length} ${result.platform.platform} platform files skipped: no page had extractable content.`,
              ),
            );
          }
        }

        // Write files to disk
        const outputDir = resolve(opts.output);
        for (const file of result.files) {
          const filePath = resolve(outputDir, file.filename);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, file.content, "utf-8");
        }

        // Print summary
        console.log("");
        console.log(chalk.bold("  w2agent generate — AI Content Generator"));
        console.log(chalk.gray(`  ${"─".repeat(40)}`));
        console.log("");
        console.log(`  URL: ${chalk.cyan(url)}`);
        console.log(`  Pages crawled: ${result.pagesProcessed}`);
        if (result.totalPagesFound > result.pagesProcessed) {
          console.log(
            chalk.yellow(
              `  ⚠ ${result.totalPagesFound} pages found, limited to ${result.pagesProcessed}. Self-host or upgrade for full coverage.`,
            ),
          );
        }
        console.log(`  Time: ${(result.duration / 1000).toFixed(1)}s`);
        console.log("");
        console.log("  Generated:");

        for (const file of result.files) {
          const size = formatSize(file.size);
          if (file.filename === "llms.txt") {
            const entries = result.pagesProcessed;
            const sects = result.sections.length;
            console.log(
              `  ${chalk.green("✓")} llms.txt           (${size}, ${entries} entries across ${sects} sections)`,
            );
          } else if (file.filename === "llms-full.txt") {
            console.log(
              `  ${chalk.green("✓")} llms-full.txt      (${size}, ${result.pagesProcessed} pages)`,
            );
          } else if (file.filename === "robots.txt") {
            console.log(`  ${chalk.green("✓")} robots.txt         (${size})`);
          } else if (file.filename === "schema-org.json") {
            console.log(`  ${chalk.green("✓")} schema-org.json    (${size})`);
          } else if (file.filename === "agent-card.json") {
            console.log(`  ${chalk.green("✓")} agent-card.json    (${size})`);
          } else if (file.filename === "faq.json") {
            console.log(`  ${chalk.green("✓")} faq.json           (${size})`);
          } else if (file.filename === "agents.md") {
            console.log(`  ${chalk.green("✓")} agents.md          (${size})`);
          } else if (/^(openclaw\/)?skills\/[^/]+\/SKILL\.md$/.test(file.filename)) {
            console.log(`  ${chalk.green("✓")} ${file.filename} (${size})`);
          } else if (file.filename.startsWith("markdown/")) {
            // Count markdown files — only print summary once
          } else if (file.filename.startsWith("webmcp/")) {
            // Count webmcp files — handled below
          }
        }

        if (generateOptions.formats?.includes("agent-card") && !opts.a2aEndpoint) {
          console.log(
            chalk.gray(
              "  - agent-card.json    skipped: pass --a2a-endpoint <url> only if this site runs an A2A agent",
            ),
          );
        }

        const mdFiles = result.files.filter((f) => f.filename.startsWith("markdown/"));
        if (mdFiles.length > 0) {
          const avgSize = Math.round(mdFiles.reduce((sum, f) => sum + f.size, 0) / mdFiles.length);
          console.log(
            `  ${chalk.green("✓")} ${mdFiles.length} markdown files  (avg ${formatSize(avgSize)} each)`,
          );
        }

        const webmcpFiles = result.files.filter((f) => f.filename.startsWith("webmcp/"));
        if (webmcpFiles.length > 0) {
          console.log(
            `  ${chalk.green("✓")} ${webmcpFiles.length} webmcp files    (declarative HTML + imperative JS)`,
          );
        }

        console.log("");
        console.log(`  Output: ${chalk.cyan(outputDir)}`);
        // Show platform detection info
        if (result.platform) {
          const p = result.platform;
          console.log(
            `  Platform: ${chalk.magenta(p.platform)} (${Math.round(p.confidence * 100)}% confidence)`,
          );
          const platformFiles = result.files.filter((f) => f.filename.startsWith(`${p.platform}/`));
          if (platformFiles.length > 0) {
            console.log(
              `  ${chalk.green("✓")} ${platformFiles.length} ${p.platform} integration files generated`,
            );
            console.log(
              chalk.gray(
                `    Run ${chalk.cyan(`w2agent integrate ${url}`)} for deployment instructions`,
              ),
            );
          }
        } else {
          console.log(
            chalk.gray(
              "  Deploy: Copy files to your site root, or generate platform-specific files:",
            ),
          );
          console.log(
            `${chalk.gray("  →")} ${chalk.cyan(`w2agent integrate ${url} --platform wordpress`)}`,
          );
          console.log(
            `${chalk.gray("  →")} ${chalk.cyan(`w2agent integrate ${url} --platform nextjs`)}`,
          );
        }
        console.log("");

        if (unfixableChecks.length > 0) {
          console.log(chalk.bold("  Manual fixes needed:"));
          for (const check of unfixableChecks) {
            console.log(`  ${chalk.yellow("!")} ${check.message} ${chalk.gray(`(${check.id})`)}`);
          }
          console.log("");
        }
      } catch (err) {
        spinner.fail(`Generation failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

const ALL_FORMATS: GenerateFormat[] = [
  "llms-txt",
  "full",
  "markdown",
  "robots-txt",
  "schema-org",
  "agent-card",
  "faq",
  "webmcp",
];

const CONTENT_FORMATS: GenerateFormat[] = [
  "llms-txt",
  "full",
  "markdown",
  "agents-md",
  "mcp-server",
  "skill-md",
  "openclaw",
];

const OPT_IN_FORMATS: GenerateFormat[] = ["mcp-server", "skill-md", "openclaw", "agents-md"];

export function parseFormats(values?: string | string[]): GenerateFormat[] {
  const raw = values === undefined ? ["all"] : Array.isArray(values) ? values : [values];
  const tokens = raw.length === 0 ? ["all"] : raw.flatMap((v) => v.split(",").map((t) => t.trim()));
  const valid = ["all", ...ALL_FORMATS, ...OPT_IN_FORMATS];
  const bad = tokens.filter((t) => !valid.includes(t));
  if (bad.length > 0) {
    const shown = bad.map((t) => (t === "" ? "(empty)" : `"${t}"`)).join(", ");
    throw new Error(`Unknown --format value(s): ${shown}. Valid formats: ${valid.join(", ")}`);
  }
  const out: GenerateFormat[] = [];
  for (const t of tokens) {
    for (const f of t === "all" ? ALL_FORMATS : [t as GenerateFormat]) {
      if (!out.includes(f)) out.push(f);
    }
  }
  return out;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function gradeColorFn(grade: string): (text: string) => string {
  switch (grade) {
    case "A":
      return chalk.green;
    case "B":
      return chalk.greenBright;
    case "C":
      return chalk.yellow;
    case "D":
      return chalk.hex("#FFA500");
    default:
      return chalk.red;
  }
}
