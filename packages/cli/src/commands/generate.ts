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
      "Output format: llms-txt, full, markdown, robots-txt, schema-org, agent-card, faq, mcp-server, skill-md, webmcp, all",
      "all",
    )
    .option("-m, --max-pages <number>", "Maximum pages to crawl", "100")
    .option("-s, --sections <sections>", "Only include these URL sections (comma-separated)")
    .option("--mcp-endpoint <url>", "MCP server endpoint URL (for skill-md format)")
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .option("--from-audit", "Run audit first, then generate fixes for failed checks only")
    .action(async (url: string, opts) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      const formats = parseFormats(opts.format);
      const sections = opts.sections
        ? opts.sections.split(",").map((s: string) => s.trim())
        : undefined;
      let unfixableChecks: Array<{ id: string; message: string }> = [];

      const generateOptions: Partial<GenerateOptions> = {
        maxPages: parseInt(opts.maxPages, 10),
        timeout: parseInt(opts.timeout, 10),
        formats,
        sections,
        mcpEndpoint: opts.mcpEndpoint,
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

        spinner.stop();

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
          } else if (file.filename === "skill.md") {
            console.log(`  ${chalk.green("✓")} skill.md           (${size})`);
          } else if (file.filename.startsWith("markdown/")) {
            // Count markdown files — only print summary once
          } else if (file.filename.startsWith("webmcp/")) {
            // Count webmcp files — handled below
          }
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

function parseFormats(format: string): GenerateFormat[] {
  if (format === "all")
    return ["llms-txt", "full", "markdown", "robots-txt", "schema-org", "agent-card", "faq"];
  const map: Record<string, GenerateFormat> = {
    "llms-txt": "llms-txt",
    full: "full",
    markdown: "markdown",
    "robots-txt": "robots-txt",
    "schema-org": "schema-org",
    "agent-card": "agent-card",
    faq: "faq",
    "mcp-server": "mcp-server",
    "skill-md": "skill-md",
    webmcp: "webmcp",
  };
  return [map[format] || "llms-txt"];
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
