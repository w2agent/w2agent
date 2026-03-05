import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAdapter, type PlatformId, runGenerate } from "@w2agent/core";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";

const PLATFORM_NAMES: Record<PlatformId, string> = {
  wordpress: "WordPress",
  nextjs: "Next.js",
  shopify: "Shopify",
  docusaurus: "Docusaurus",
  nuxt: "Nuxt",
  astro: "Astro",
};

// Files to skip when installing (not actual project files)
const SKIP_ON_INSTALL = ["INSTALL.md"];

// Files that need special merge handling (user may already have them)
const MERGE_FILES = ["middleware.ts"];

export function registerIntegrateCommand(program: Command): void {
  program
    .command("integrate")
    .description(
      "Generate platform-specific integration files (WordPress plugin, Next.js middleware, etc.)",
    )
    .argument("<url>", "URL to generate integration for")
    .option("-o, --output <dir>", "Output directory", "./w2agent-output")
    .option("-p, --platform <platform>", "Force platform: wordpress, nextjs, shopify, docusaurus")
    .option("-m, --max-pages <number>", "Maximum pages to crawl", "100")
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .option("--install", "Install files directly into your project instead of an output directory")
    .option("--project-dir <dir>", "Project root for --install (default: current directory)", ".")
    .action(async (url: string, opts) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      const spinner = ora("Starting integration generation...").start();

      try {
        // Run full generate to get core files + platform detection
        const result = await runGenerate(
          url,
          {
            maxPages: parseInt(opts.maxPages, 10),
            timeout: parseInt(opts.timeout, 10),
            formats: ["llms-txt", "full", "robots-txt", "agent-card"],
          },
          (status) => {
            spinner.text = status;
          },
        );

        spinner.stop();

        // Determine platform
        const validPlatforms: PlatformId[] = [
          "wordpress",
          "nextjs",
          "shopify",
          "docusaurus",
          "nuxt",
          "astro",
        ];
        let platformId: PlatformId | undefined;
        if (opts.platform) {
          if (!validPlatforms.includes(opts.platform as PlatformId)) {
            console.error(
              chalk.red(
                `Unknown platform: ${opts.platform}. Valid options: ${validPlatforms.join(", ")}`,
              ),
            );
            process.exit(1);
          }
          platformId = opts.platform as PlatformId;
        } else if (result.platform) {
          platformId = result.platform.platform as PlatformId;
        }

        if (!platformId) {
          console.log("");
          console.log(chalk.yellow("  Could not auto-detect platform."));
          console.log("");
          console.log("  Specify manually with --platform:");
          console.log(`    ${chalk.cyan(`w2agent integrate ${url} --platform wordpress`)}`);
          console.log(`    ${chalk.cyan(`w2agent integrate ${url} --platform nextjs`)}`);
          console.log(`    ${chalk.cyan(`w2agent integrate ${url} --platform shopify`)}`);
          console.log(`    ${chalk.cyan(`w2agent integrate ${url} --platform docusaurus`)}`);
          console.log("");
          console.log(chalk.gray("  Core files were still generated in the output directory."));

          // Still write core files
          const outputDir = resolve(opts.output);
          for (const file of result.files) {
            const filePath = resolve(outputDir, file.filename);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, file.content, "utf-8");
          }
          return;
        }

        const adapter = getAdapter(platformId);
        if (!adapter) {
          console.error(chalk.red(`Unknown platform: ${platformId}`));
          process.exit(1);
        }

        // If platform was forced (not auto-detected), generate integration files manually
        const integrationFiles = result.files.filter((f) =>
          f.filename.startsWith(`${platformId}/`),
        );

        if (integrationFiles.length === 0) {
          // Platform was forced — generate integration now
          const ctx = {
            pages: [],
            rawPages: [],
            metadata: { baseUrl: new URL(url).origin, wellKnown: {} },
            baseUrl: new URL(url).origin,
          };
          const coreFiles = result.files;
          const generated = adapter.generateIntegration(ctx, coreFiles);
          result.files.push(...generated);
        }

        const platformFiles = result.files.filter((f) => f.filename.startsWith(`${platformId}/`));
        const platformName = PLATFORM_NAMES[platformId] || platformId;
        const prefix = `${platformId}/`;

        if (opts.install) {
          // --install mode: copy platform files directly into project
          const projectDir = resolve(opts.projectDir);
          const installed: string[] = [];
          const skipped: string[] = [];

          // Check if platform files include route handlers that would conflict
          // with public/ seed files (e.g., Next.js app/llms.txt/route.ts vs public/llms.txt)
          const hasRouteHandlers = platformFiles.some(
            (f) =>
              f.filename.includes("/app/llms.txt/") || f.filename.includes("/app/llms-full.txt/"),
          );

          if (!hasRouteHandlers) {
            // Only install seed files if there are no route handlers that conflict
            const seedFiles = result.files.filter(
              (f) => f.filename === "llms.txt" || f.filename === "llms-full.txt",
            );
            for (const file of seedFiles) {
              const destPath = resolve(projectDir, "public", file.filename);
              mkdirSync(dirname(destPath), { recursive: true });
              writeFileSync(destPath, file.content, "utf-8");
              installed.push(`public/${file.filename}`);
            }
          }

          for (const file of platformFiles) {
            const relPath = file.filename.slice(prefix.length);
            const baseName = relPath.split("/").pop() || relPath;

            // Skip non-project files
            if (SKIP_ON_INSTALL.includes(baseName)) continue;

            const destPath = resolve(projectDir, relPath);

            // Handle merge files (middleware, etc.)
            if (MERGE_FILES.includes(baseName) && existsSync(destPath)) {
              const existing = readFileSync(destPath, "utf-8");
              if (existing.includes("w2agent") || existing.includes("llms.txt")) {
                skipped.push(`${relPath} (already has w2agent integration)`);
                continue;
              }
              // Write as .w2agent.ts so user can merge manually
              const mergePath = destPath.replace(/\.ts$/, ".w2agent.ts");
              writeFileSync(mergePath, file.content, "utf-8");
              skipped.push(
                `${relPath} → saved as ${baseName.replace(/\.ts$/, ".w2agent.ts")} (merge manually — existing middleware found)`,
              );
              continue;
            }

            mkdirSync(dirname(destPath), { recursive: true });
            writeFileSync(destPath, file.content, "utf-8");
            installed.push(relPath);
          }

          // Print install summary
          console.log("");
          console.log(chalk.bold(`  w2agent integrate --install — ${platformName}`));
          console.log(chalk.gray(`  ${"─".repeat(40)}`));
          console.log("");
          console.log(`  URL: ${chalk.cyan(url)}`);
          console.log(`  Project: ${chalk.cyan(projectDir)}`);
          console.log("");
          console.log("  Installed:");
          for (const f of installed) {
            console.log(`  ${chalk.green("✓")} ${f}`);
          }
          if (skipped.length > 0) {
            console.log("");
            console.log("  Skipped:");
            for (const f of skipped) {
              console.log(`  ${chalk.yellow("⚠")} ${f}`);
            }
          }
          console.log("");
          console.log(chalk.gray("  Re-run your audit to verify the score improvement."));
          console.log("");
        } else {
          // Default mode: write to output directory
          const outputDir = resolve(opts.output);
          for (const file of result.files) {
            const filePath = resolve(outputDir, file.filename);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, file.content, "utf-8");
          }

          // Print summary
          console.log("");
          console.log(chalk.bold(`  w2agent integrate — ${platformName} Integration`));
          console.log(chalk.gray(`  ${"─".repeat(40)}`));
          console.log("");
          console.log(`  URL: ${chalk.cyan(url)}`);
          console.log(
            `  Platform: ${chalk.magenta(platformName)}${result.platform ? ` (${Math.round(result.platform.confidence * 100)}% confidence)` : " (manual)"}`,
          );
          console.log(`  Time: ${(result.duration / 1000).toFixed(1)}s`);
          console.log("");
          console.log("  Integration files:");
          for (const file of platformFiles) {
            const size = formatSize(file.size);
            console.log(`  ${chalk.green("✓")} ${file.filename.padEnd(45)} (${size})`);
          }
          console.log("");
          console.log(`  Output: ${chalk.cyan(outputDir)}`);
          console.log("");

          // Suggest --install
          console.log(
            chalk.gray(
              `  Tip: Use ${chalk.cyan("--install")} to copy files directly into your project:`,
            ),
          );
          console.log(chalk.gray(`    ${chalk.cyan(`w2agent integrate ${url} --install`)}`));
          console.log("");

          const installFile = platformFiles.find((f) => f.filename.endsWith("INSTALL.md"));
          if (installFile) {
            console.log(chalk.gray(`  Or see ${installFile.filename} for manual instructions.`));
            console.log("");
          }
        }
      } catch (err) {
        spinner.fail(`Integration generation failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
