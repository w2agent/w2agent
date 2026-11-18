import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import {
  classifyHomepage,
  DEFAULT_GENERATE_OPTIONS,
  executeInstallPlan,
  fetchPage,
  formatInstallSummary,
  getAdapter,
  type PlatformId,
  planInstall,
  runGenerate,
} from "w2agent-core";
import {
  currentArgv,
  enterJsonMode,
  failWith,
  insertFlags,
  type JsonMode,
  jsonRequested,
  REASONS,
  type Reason,
  reasonOfError,
  sanitizeNext,
} from "../agent/output.js";
import { isPlausibleUrl, parsePositiveInt } from "./audit.js";
import {
  applyArgv,
  dryRunArgv,
  JS_PLATFORMS,
  mapPlanChanges,
  rewriteOrigin,
  VALID_PLATFORMS,
} from "./integrate-support.js";

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

function projectProblem(
  projectDir: string,
  platformId: PlatformId | undefined,
): string | undefined {
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    return `Project directory does not exist: ${projectDir}`;
  }
  if (
    platformId &&
    JS_PLATFORMS.includes(platformId) &&
    !existsSync(join(projectDir, "package.json"))
  ) {
    return `No package.json in ${projectDir}; ${PLATFORM_NAMES[platformId]} needs a JavaScript project root. Pass --project-dir.`;
  }
  return undefined;
}

export function registerIntegrateCommand(program: Command): void {
  program
    .command("integrate")
    .description(
      "Generate platform-specific integration files (WordPress plugin, Next.js middleware, etc.)",
    )
    .argument("<url>", "URL to generate integration for")
    .option("-o, --output <dir>", "Output directory", "./w2agent-output")
    .option(
      "-p, --platform <platform>",
      "Force platform: wordpress, nextjs, shopify, docusaurus, nuxt, astro",
    )
    .option("-m, --max-pages <number>", "Maximum pages to crawl", "100")
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .option(
      "--a2a-endpoint <url>",
      "Your live A2A agent endpoint URL (no agent card is integrated without it)",
    )
    .option(
      "--allow-host <host>",
      "Allow off-origin host for generated-tool fetch targets (repeatable)",
      (value: string, acc: string[] = []) => acc.concat(value),
      [] as string[],
    )
    .option("--install", "Install files directly into your project instead of an output directory")
    .option("--project-dir <dir>", "Project root for --install (default: current directory)", ".")
    .option("--dry-run", "Show what --install would do without writing files")
    .option(
      "--site-url <url>",
      "Production URL to put in generated content when crawling another origin (e.g. localhost)",
    )
    .option("--json", "Print one JSON document on stdout (the result, or an error envelope)")
    .action(async (url: string, opts, command: Command) => {
      const json: JsonMode | undefined = jsonRequested() ? enterJsonMode() : undefined;
      const argv = currentArgv();
      const fail = async (
        failure: Parameters<typeof failWith>[1],
        human: string = failure.message,
      ) => failWith(json, failure, argv, chalk.red(human));

      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      if (!isPlausibleUrl(url)) {
        await fail({
          reason: "invalid_url",
          message: `Invalid URL: "${url}". Please provide a full URL like https://example.com.`,
        });
        return;
      }

      if (opts.platform !== undefined && !VALID_PLATFORMS.includes(opts.platform as PlatformId)) {
        await fail({
          reason: "invalid_argument",
          message: `Unknown platform: ${opts.platform}. Valid options: ${VALID_PLATFORMS.join(", ")}`,
          next: [["w2agent", "schema"]],
        });
        return;
      }

      for (const [flag, value] of [
        ["max-pages", opts.maxPages],
        ["timeout", opts.timeout],
      ]) {
        if (parsePositiveInt(value) === undefined) {
          await fail({
            reason: "invalid_argument",
            message: `Invalid --${flag} "${value}". Use a positive integer.`,
            next: [["w2agent", "schema"]],
          });
          return;
        }
      }

      let siteOrigin: string | undefined;
      if (opts.siteUrl !== undefined) {
        let site: URL | undefined;
        try {
          site = new URL(opts.siteUrl);
        } catch {
          site = undefined;
        }
        if (site && (site.username || site.password)) {
          await fail({
            reason: "invalid_url",
            message: "Invalid --site-url: it must not contain credentials.",
          });
          return;
        }
        if (!site || !/^https?:$/.test(site.protocol) || !isPlausibleUrl(site.href)) {
          await fail({
            reason: "invalid_url",
            message: `Invalid --site-url "${opts.siteUrl}". Use an absolute http(s) URL like https://example.com.`,
          });
          return;
        }
        siteOrigin = site.origin;
      }

      const planning = Boolean(opts.install || opts.dryRun);
      const projectDir = resolve(opts.projectDir);
      const forcedPlatform = opts.platform as PlatformId | undefined;
      if (planning) {
        const problem = projectProblem(projectDir, forcedPlatform);
        if (problem) {
          await fail({ reason: "not_a_project", message: problem });
          return;
        }
      }

      const allowedOffOriginHosts: string[] | undefined =
        Array.isArray(opts.allowHost) && opts.allowHost.length > 0 ? opts.allowHost : undefined;

      const timeout = parsePositiveInt(opts.timeout) as number;
      const spinner = json ? undefined : ora("Starting integration generation...").start();

      try {
        const result = await runGenerate(
          url,
          {
            maxPages: parsePositiveInt(opts.maxPages) as number,
            timeout,
            formats: ["llms-txt", "full", "robots-txt", "agent-card", "webmcp"],
            a2aEndpoint: opts.a2aEndpoint,
            ...(allowedOffOriginHosts ? { allowedOffOriginHosts } : {}),
            ...(forcedPlatform ? { platform: forcedPlatform } : {}),
          },
          (status) => {
            if (spinner) spinner.text = status;
          },
        );

        spinner?.stop();

        const warnings: string[] = [];

        // The crawler reports an unusable site as zero pages rather than throwing.
        // With a forced platform the scaffolding is still useful, so go on and say why it is empty.
        if (result.pagesProcessed === 0) {
          const empty = await classifyEmptyCrawl(url, timeout);
          if (!forcedPlatform) {
            await fail(empty);
            return;
          }
          const warning = `No readable pages were found at ${url}; generated files are scaffolding only. ${empty.message}`;
          warnings.push(warning);
          if (!json) console.error(chalk.yellow(`  ! ${warning}`));
        }

        if (!opts.a2aEndpoint) {
          console.log(
            chalk.gray(
              "  - agent-card.json    skipped: pass --a2a-endpoint <url> only if this site runs an A2A agent",
            ),
          );
        }

        const platformId: PlatformId | undefined =
          forcedPlatform ?? (result.platform?.platform as PlatformId | undefined);

        if (!platformId) {
          if (json) {
            await fail({
              reason: "no_platform_detected",
              message: "Could not auto-detect the platform. Pass --platform.",
              next: VALID_PLATFORMS.map((id) => insertFlags(argv, ["--platform", id])),
            });
            return;
          }
          console.log("");
          console.log(chalk.yellow("  Could not auto-detect platform."));
          console.log("");
          console.log("  Specify manually with --platform:");
          for (const id of VALID_PLATFORMS) {
            console.log(`    ${chalk.cyan(`w2agent integrate ${url} --platform ${id}`)}`);
          }
          console.log("");

          if (opts.install || opts.dryRun) {
            console.log(
              `  Nothing was written. Re-run with ${chalk.cyan("--platform <id> --install --project-dir <dir>")}.`,
            );
            process.exitCode = REASONS.no_platform_detected.exitCode;
            return;
          }

          console.log(chalk.gray("  Core files were still generated in the output directory."));

          const outputDir = resolve(opts.output);
          const siteFiles = siteOrigin ? rewriteOrigin(result.files, url, siteOrigin) : undefined;
          for (const file of siteFiles?.files ?? result.files) {
            const filePath = resolve(outputDir, file.filename);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, file.content, "utf-8");
          }
          for (const w of siteFiles?.warnings ?? []) console.error(chalk.yellow(`  ! ${w}`));
          return;
        }

        const adapter = getAdapter(platformId);
        if (!adapter) {
          await fail({ reason: "invalid_argument", message: `Unknown platform: ${platformId}` });
          return;
        }

        if (planning && !forcedPlatform) {
          const problem = projectProblem(projectDir, platformId);
          if (problem) {
            await fail({ reason: "not_a_project", message: problem });
            return;
          }
        }

        if (siteOrigin) {
          const rewritten = rewriteOrigin(result.files, url, siteOrigin);
          result.files = rewritten.files;
          warnings.push(...rewritten.warnings);
          if (!json) for (const w of rewritten.warnings) console.error(chalk.yellow(`  ! ${w}`));
        }

        const platformFiles = result.files.filter((f) => f.filename.startsWith(`${platformId}/`));
        const platformName = PLATFORM_NAMES[platformId] || platformId;

        if (planning) {
          const plan = planInstall(adapter, result.files, projectDir);
          const changes = mapPlanChanges(plan, projectDir);

          if (opts.dryRun) {
            // Dry run: simulate result without writing
            if (json) {
              if (plan.actions.length === 0) {
                await fail({ reason: "not_a_project", message: plan.warnings.join(" ") });
                return;
              }
              await json.emit({
                ok: true,
                outcome: "planned",
                platform: platformId,
                changes,
                warnings: [...plan.warnings, ...warnings],
                postInstallSteps: plan.postInstallSteps,
                next: sanitizeNext([applyArgv(argv)], argv),
              });
              return;
            }
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
            const upToDate = plan.actions.some(
              (a) => a.type === "skip" && a.reason === "already up to date",
            );
            const failedWrite = execResult.failed.length > 0;
            const nothingDone = execResult.installed.length === 0 && !upToDate;
            if (json) {
              if (failedWrite || nothingDone) {
                if (plan.actions.length === 0) {
                  await fail({ reason: "not_a_project", message: plan.warnings.join(" ") });
                  return;
                }
                const skippedText = execResult.skipped.join("; ");
                const message = failedWrite
                  ? `Some files could not be written: ${execResult.failed.join(", ")}. ${
                      execResult.installed.length > 0
                        ? `Installed: ${execResult.installed.join(", ")}. `
                        : "Nothing was installed. "
                    }${skippedText}. Post-install steps that name a failed file are left out; fix the cause and re-run (existing files are skipped).`
                  : `Nothing was installed. ${skippedText}`;
                await fail({
                  reason: "unknown_failure",
                  message,
                  changes: mapPlanChanges(plan, projectDir, execResult),
                  postInstallSteps: plan.postInstallSteps.filter(
                    (step) => !execResult.failed.some((f) => step.includes(f)),
                  ),
                });
                return;
              }
              await json.emit({
                ok: true,
                outcome: "installed",
                platform: platformId,
                changes: mapPlanChanges(plan, projectDir, execResult),
                warnings: [...plan.warnings, ...warnings],
                postInstallSteps: plan.postInstallSteps,
                next: sanitizeNext([reauditArgv(url, opts, command)], argv),
              });
              return;
            }
            const summary = formatInstallSummary(plan, execResult, projectDir, url, platformName);
            console.log(summary);
            if (failedWrite || nothingDone) process.exitCode = 1;
          }
        } else {
          // Default mode: write to output directory
          const outputDir = resolve(opts.output);
          for (const file of result.files) {
            const filePath = resolve(outputDir, file.filename);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, file.content, "utf-8");
          }

          if (json) {
            await json.emit({
              ok: true,
              outcome: "generated",
              platform: platformId,
              outputDir,
              files: result.files.map((f) => f.filename),
              warnings,
              next: sanitizeNext([dryRunArgv(argv)], argv),
            });
            return;
          }

          console.log("");
          console.log(chalk.bold(`  w2agent integrate — ${platformName} Integration`));
          console.log(chalk.gray(`  ${"─".repeat(40)}`));
          console.log("");
          console.log(`  URL: ${chalk.cyan(url)}`);
          const detected = result.platform;
          let platformNote: string;
          if (!detected) platformNote = " (forced)";
          else if (detected.platform === platformId)
            platformNote = ` (${Math.round(detected.confidence * 100)}% confidence)`;
          else
            platformNote = ` (forced; detected ${PLATFORM_NAMES[detected.platform as PlatformId] || detected.platform})`;
          console.log(`  Platform: ${chalk.magenta(platformName)}${platformNote}`);
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
              chalk.gray(`  The generated files above are an alternative for manual setup.`),
            );
            console.log("");
          }

          console.log(
            chalk.gray(
              `  Tip: Use ${chalk.cyan("--install")} to copy files directly into your project:`,
            ),
          );
          const siteFlag = siteOrigin ? ` --site-url ${siteOrigin}` : "";
          console.log(
            chalk.gray(`    ${chalk.cyan(`w2agent integrate ${url}${siteFlag} --install`)}`),
          );
          console.log("");

          const installFile = platformFiles.find((f) => f.filename.endsWith("INSTALL.md"));
          if (installFile) {
            console.log(chalk.gray(`  Or see ${installFile.filename} for manual instructions.`));
            console.log("");
          }
        }
      } catch (err) {
        const message = (err as Error).message;
        spinner?.fail(`Integration generation failed: ${message}`);
        if (json) {
          await failWith(json, { reason: reasonOfError(err), message }, argv);
        } else {
          process.exitCode = 1;
        }
      }
    });
}

/** Audits the crawled URL (not --site-url): run it after the postInstallSteps and a restart of the local server. */
function reauditArgv(url: string, opts: Record<string, unknown>, command: Command): string[] {
  const argv = ["w2agent", "audit", url, "--json"];
  if (command.getOptionValueSource("timeout") === "cli")
    argv.push("--timeout", String(opts.timeout));
  if (Array.isArray(opts.allowHost)) {
    for (const host of opts.allowHost) argv.push("--allow-host", String(host));
  }
  return argv;
}

async function classifyEmptyCrawl(
  url: string,
  timeout: number,
): Promise<{ reason: Reason; message: string }> {
  const page = await fetchPage(url, {
    timeout,
    userAgent: DEFAULT_GENERATE_OPTIONS.userAgent,
  });
  const failure = classifyHomepage(page, url);
  if (failure) return { reason: reasonOfError(failure), message: failure.message };
  const status = page.status > 0 ? ` (HTTP ${page.status})` : "";
  return {
    reason: "unknown_failure",
    message: `No readable pages were found at ${url}${status}.`,
  };
}

function simulatePlan(plan: ReturnType<typeof planInstall>) {
  const installed: string[] = [];
  const skipped: string[] = [];
  const manual: string[] = [];
  const failed: string[] = [];

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
    }
  }

  return { installed, skipped, manual, failed };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
