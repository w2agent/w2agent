import type { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  runGenerate,
  type GenerateFormat,
  type GenerateOptions,
  DEFAULT_GENERATE_OPTIONS,
} from "@w2agent/core";

export function registerGenerateCommand(program: Command): void {
  program
    .command("generate")
    .description("Generate llms.txt, llms-full.txt, and markdown files for a site")
    .argument("<url>", "URL to generate content for")
    .option("-o, --output <dir>", "Output directory", "./w2agent-output")
    .option("-f, --format <format>", "Output format: llms-txt, full, markdown, all", "all")
    .option("-m, --max-pages <number>", "Maximum pages to crawl", "50")
    .option("-s, --sections <sections>", "Only include these URL sections (comma-separated)")
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .action(async (url: string, opts) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      const formats = parseFormats(opts.format);
      const sections = opts.sections
        ? opts.sections.split(",").map((s: string) => s.trim())
        : undefined;

      const generateOptions: Partial<GenerateOptions> = {
        maxPages: parseInt(opts.maxPages),
        timeout: parseInt(opts.timeout),
        formats,
        sections,
      };

      const spinner = ora("Starting generation...").start();

      try {
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
        console.log(chalk.gray("  " + "─".repeat(40)));
        console.log("");
        console.log(`  URL: ${chalk.cyan(url)}`);
        console.log(`  Pages crawled: ${result.pagesProcessed}`);
        console.log(`  Time: ${(result.duration / 1000).toFixed(1)}s`);
        console.log("");
        console.log("  Generated:");

        for (const file of result.files) {
          const size = formatSize(file.size);
          if (file.filename === "llms.txt") {
            const entries = result.pagesProcessed;
            const sects = result.sections.length;
            console.log(`  ${chalk.green("✓")} llms.txt           (${size}, ${entries} entries across ${sects} sections)`);
          } else if (file.filename === "llms-full.txt") {
            console.log(`  ${chalk.green("✓")} llms-full.txt      (${size}, ${result.pagesProcessed} pages)`);
          } else if (file.filename.startsWith("markdown/")) {
            // Count markdown files — only print summary once
          }
        }

        const mdFiles = result.files.filter(f => f.filename.startsWith("markdown/"));
        if (mdFiles.length > 0) {
          const avgSize = Math.round(mdFiles.reduce((sum, f) => sum + f.size, 0) / mdFiles.length);
          console.log(`  ${chalk.green("✓")} ${mdFiles.length} markdown files  (avg ${formatSize(avgSize)} each)`);
        }

        console.log("");
        console.log(`  Output: ${chalk.cyan(outputDir)}`);
        console.log("");
        console.log(chalk.gray("  Deploy: Copy files to your site root, or use a platform adapter:"));
        console.log(chalk.gray("  →") + " WordPress:  " + chalk.cyan("npx w2agent wordpress-plugin"));
        console.log(chalk.gray("  →") + " Next.js:    " + chalk.cyan("npm install @w2agent/next"));
        console.log(chalk.gray("  →") + " Any site:   " + chalk.cyan(`npx w2agent serve --proxy ${url}`));
        console.log("");
      } catch (err) {
        spinner.fail(`Generation failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function parseFormats(format: string): GenerateFormat[] {
  if (format === "all") return ["llms-txt", "full", "markdown"];
  const map: Record<string, GenerateFormat> = {
    "llms-txt": "llms-txt",
    "full": "full",
    "markdown": "markdown",
  };
  return [map[format] || "llms-txt"];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
