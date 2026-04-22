import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import {
  executeInstallPlan,
  formatInstallSummary,
  getAdapter,
  type PlatformId,
  planInstall,
  runGenerate,
} from "w2agent-core";

const NPM_PACKAGES: Partial<Record<PlatformId, string>> = {
  nuxt: "@w2agent/nuxt",
  astro: "@w2agent/astro",
  docusaurus: "@w2agent/docusaurus",
};

const PLATFORM_NAMES: Record<PlatformId, string> = {
  wordpress: "WordPress",
  nextjs: "Next.js",
  shopify: "Shopify",
  docusaurus: "Docusaurus",
  nuxt: "Nuxt",
  astro: "Astro",
};

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
    .option(
      "--allow-host <host>",
      "Allow off-origin host for generated-tool fetch targets (repeatable)",
      (value: string, acc: string[] = []) => acc.concat(value),
      [] as string[],
    )
    .option("--install", "Install files directly into your project instead of an output directory")
    .option("--project-dir <dir>", "Project root for --install (default: current directory)", ".")
    .option("--dry-run", "Show what --install would do without writing files")
    .action(async (url: string, opts) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      const allowedOffOriginHosts: string[] | undefined =
        Array.isArray(opts.allowHost) && opts.allowHost.length > 0 ? opts.allowHost : undefined;

      const spinner = ora("Starting integration generation...").start();

      try {
        const result = await runGenerate(
          url,
          {
            maxPages: parseInt(opts.maxPages, 10),
            timeout: parseInt(opts.timeout, 10),
            formats: ["llms-txt", "full", "robots-txt", "agent-card", "webmcp"],
            ...(allowedOffOriginHosts ? { allowedOffOriginHosts } : {}),
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

        if (opts.install || opts.dryRun) {
          const projectDir = resolve(opts.projectDir);
          const plan = planInstall(adapter, result.files, projectDir);

          if (opts.dryRun) {
            // Dry run: simulate result without writing
            const simulated = simulatePlan(plan);
            const summary = formatInstallSummary(
              plan,
              simulated,
              projectDir,
              url,
              platformName,
              true,
            );
            console.log(summary);
          } else {
            const execResult = executeInstallPlan(plan, projectDir);
            const summary = formatInstallSummary(plan, execResult, projectDir, url, platformName);
            console.log(summary);
          }
        } else {
          // Default mode: write to output directory
          const outputDir = resolve(opts.output);
          for (const file of result.files) {
            const filePath = resolve(outputDir, file.filename);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, file.content, "utf-8");
          }

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

          const npmPkg = NPM_PACKAGES[platformId];
          if (npmPkg) {
            console.log(chalk.bold(`  Recommended: use the npm package`));
            console.log(`    ${chalk.cyan(`npm install ${npmPkg}`)}`);
            console.log(
              chalk.gray(
                `  The generated files above are an alternative for manual setup.`,
              ),
            );
            console.log("");
          }

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

function simulatePlan(plan: ReturnType<typeof planInstall>) {
  const installed: string[] = [];
  const skipped: string[] = [];
  const manual: string[] = [];
  const deleted: string[] = [];

  for (const action of plan.actions) {
    switch (action.type) {
      case "write":
        installed.push(action.dest);
        break;
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
      case "delete":
        deleted.push(action.dest);
        break;
    }
  }

  return { installed, skipped, manual, deleted };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
