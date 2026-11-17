import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { type GenerateOptions, runGenerate, type SelfHostPlatform } from "w2agent-core";
import { failWith } from "../agent/output.js";
import { apiUrlProblem, getApiUrl, isHeaderSafeToken } from "../auth.js";

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("agent")
    .description("Generate self-hosted agent servers for any website");

  // --- mcp deploy ---
  mcp
    .command("deploy")
    .description("Generate a self-hosted agent server for a website")
    .argument("<url>", "URL to generate MCP server for")
    .option("--self-host <platform>", "Self-host platform: vercel, cf")
    .option("-o, --output <dir>", "Output directory", "./w2agent-output")
    .option("-m, --max-pages <number>", "Maximum pages to crawl", "50")
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .option(
      "--allow-host <host>",
      "Allow off-origin host for generated-tool fetch targets (repeatable)",
      (value: string, acc: string[] = []) => acc.concat(value),
      [] as string[],
    )
    .action(async (url: string, opts) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      const selfHost = opts.selfHost as SelfHostPlatform | undefined;
      if (selfHost && !["vercel", "cf"].includes(selfHost)) {
        console.error(chalk.red(`Unknown self-host platform: ${selfHost}. Use "vercel" or "cf".`));
        process.exit(1);
      }

      const allowedOffOriginHosts: string[] | undefined =
        Array.isArray(opts.allowHost) && opts.allowHost.length > 0 ? opts.allowHost : undefined;

      const generateOptions: Partial<GenerateOptions> = {
        maxPages: parseInt(opts.maxPages, 10),
        timeout: parseInt(opts.timeout, 10),
        formats: ["mcp-server"],
        ...(selfHost ? { mcpSelfHost: selfHost } : {}),
        ...(allowedOffOriginHosts ? { allowedOffOriginHosts } : {}),
      };

      const spinner = ora("Crawling site and generating agent server...").start();

      try {
        // Run the generate pipeline to get crawled data + context
        const result = await runGenerate(url, generateOptions, (status) => {
          spinner.text = status;
        });

        if (result.pagesProcessed === 0) {
          spinner.fail(
            result.pagesFetched === 0
              ? `No pages could be crawled from ${url} (nothing written)`
              : `No page at ${url} had extractable content (nothing written)`,
          );
          process.exit(1);
        }

        const mcpFiles = result.files.filter((f) => f.filename.startsWith("mcp-server/"));

        spinner.stop();

        // Write files to disk
        const outputDir = resolve(opts.output);
        for (const file of mcpFiles) {
          const filePath = resolve(outputDir, file.filename);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, file.content, "utf-8");
        }

        // Summary
        console.log("");
        console.log(chalk.bold("  w2agent agent deploy — Self-Host Agent Server"));
        console.log(chalk.gray(`  ${"─".repeat(42)}`));
        console.log("");
        console.log(`  Source: ${chalk.cyan(url)}`);
        console.log(`  Pages crawled: ${result.pagesProcessed}`);
        console.log(`  Time: ${(result.duration / 1000).toFixed(1)}s`);
        console.log("");

        if (selfHost === "vercel") {
          console.log(`  Mode: ${chalk.magenta("Self-host (Vercel)")}`);
        } else if (selfHost === "cf") {
          console.log(`  Mode: ${chalk.magenta("Self-host (Cloudflare Workers)")}`);
        } else {
          console.log(`  Mode: ${chalk.magenta("Standalone agent server")}`);
        }

        console.log("");
        console.log("  Generated files:");
        for (const file of mcpFiles) {
          const shortName = file.filename.replace("mcp-server/", "");
          console.log(`  ${chalk.green("✓")} ${shortName} (${formatSize(file.size)})`);
        }

        console.log("");
        console.log(`  Output: ${chalk.cyan(resolve(outputDir, "mcp-server"))}`);
        console.log("");

        if (selfHost === "vercel") {
          console.log("  Next steps:");
          console.log(`${chalk.gray("  cd")} ${chalk.cyan(resolve(outputDir, "mcp-server"))}`);
          console.log(chalk.gray("  npm install && npx vercel --prod"));
        } else if (selfHost === "cf") {
          console.log("  Next steps:");
          console.log(`${chalk.gray("  cd")} ${chalk.cyan(resolve(outputDir, "mcp-server"))}`);
          console.log(chalk.gray("  npm install"));
          console.log(chalk.gray("  bash setup.sh --local && npx wrangler dev   # local test"));
          console.log(chalk.gray("  npx wrangler kv namespace create MCP_DATA"));
          console.log(
            chalk.gray('  # set id = "<id>" under the MCP_DATA binding in wrangler.toml'),
          );
          console.log(chalk.gray("  bash setup.sh && npx wrangler deploy"));
        } else {
          console.log("  Next steps:");
          console.log(`${chalk.gray("  cd")} ${chalk.cyan(resolve(outputDir, "mcp-server"))}`);
          console.log(chalk.gray("  npm install"));
          console.log(chalk.gray("  npm start"));
        }
        console.log("");

        if (result.platform) {
          console.log(`  Platform detected: ${chalk.magenta(result.platform.platform)}`);
        }
      } catch (err) {
        spinner.fail(`Agent server generation failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // --- mcp status ---
  mcp
    .command("status")
    .description("Check status of a hosted agent deployment")
    .argument("[slug]", "Deployment slug")
    .action(async (slug?: string) => {
      if (!slug) {
        console.log(chalk.yellow("Usage: w2agent agent status <slug>"));
        console.log(chalk.gray("  Check health of a hosted agent deployment"));
        return;
      }
      if (!isValidSlug(slug)) badSlug(slug);

      const problem = apiUrlProblem();
      if (problem) {
        await failWith(undefined, { reason: "invalid_argument", message: problem });
        return;
      }

      const spinner = ora(`Checking status of ${slug}...`).start();
      let res: Response;
      try {
        res = await fetch(`${getApiUrl()}/api/agent/${encodeURIComponent(slug)}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(HOSTED_TIMEOUT_MS),
        });
      } catch (err) {
        spinner.stop();
        failNetwork(`check ${slug}`, err);
      }
      spinner.stop();

      failRedirect(res);
      if (res.status === 404) {
        console.error(`  ${chalk.red("✗")} No hosted deployment named ${slug}`);
        process.exit(1);
      }
      if (!res.ok) {
        console.error(`  ${chalk.red("✗")} Status check failed: ${res.status} ${res.statusText}`);
        process.exit(1);
      }

      let info: HostedAgentInfo;
      try {
        const parsed: unknown = await res.json();
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new SyntaxError("not an object");
        }
        info = parsed as HostedAgentInfo;
      } catch (err) {
        const name = (err as Error).name;
        if (name === "TimeoutError" || name === "AbortError") failNetwork(`read ${slug}`, err);
        console.error(`  ${chalk.red("✗")} Unexpected response from ${getApiUrl()}`);
        process.exit(1);
      }
      console.log(`  ${chalk.green("✓")} ${slug} is ${chalk.green("deployed")}`);
      if (info.agentEndpoint) console.log(`    Endpoint:       ${info.agentEndpoint}`);
      if (info.pagesIndexed !== undefined) console.log(`    Pages indexed:  ${info.pagesIndexed}`);
      if (Array.isArray(info.tools)) {
        const names = info.tools.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean);
        console.log(`    Tools:          ${names.join(", ")}`);
      }
      if (info.updatedAt) console.log(`    Last update:    ${info.updatedAt}`);
    });

  // --- mcp update ---
  mcp
    .command("update")
    .description("Re-crawl and update a hosted agent deployment")
    .argument("<slug>", "Deployment slug to update")
    .option(
      "--token <token>",
      "Webhook token printed by `w2agent deploy` (prefer the W2AGENT_WEBHOOK_TOKEN env var; a flag lands in shell history)",
    )
    .action(async (slug: string, opts: { token?: string }) => {
      if (!isValidSlug(slug)) badSlug(slug);

      const problem = apiUrlProblem();
      if (problem) {
        await failWith(undefined, { reason: "invalid_argument", message: problem });
        return;
      }

      const token = (opts.token?.trim() || process.env.W2AGENT_WEBHOOK_TOKEN?.trim()) ?? "";
      if (!token) {
        console.error(`  ${chalk.red("✗")} No webhook token.`);
        console.error(
          chalk.gray(
            "    `w2agent deploy` prints it (`--show-token` shows it in full). Pass --token or set W2AGENT_WEBHOOK_TOKEN.",
          ),
        );
        process.exit(1);
      }

      if (!isHeaderSafeToken(token)) {
        console.error(
          `  ${chalk.red("✗")} Webhook token contains characters that are not allowed in a header (visible ASCII only).`,
        );
        process.exit(1);
      }

      const spinner = ora(`Triggering re-crawl for ${slug}...`).start();
      let res: Response;
      try {
        res = await fetch(`${getApiUrl()}/api/agent/webhook/${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(HOSTED_TIMEOUT_MS),
        });
      } catch (err) {
        spinner.stop();
        failNetwork(`trigger update for ${slug}`, err);
      }
      spinner.stop();

      failRedirect(res);
      if (res.ok) {
        console.log(`  ${chalk.green("✓")} Re-crawl triggered for ${slug}`);
        console.log(chalk.gray("    Updates will be reflected within a few minutes."));
        return;
      }
      if (res.status === 401 || res.status === 403) {
        console.error(`  ${chalk.red("✗")} Webhook token rejected for ${slug}`);
      } else if (res.status === 404) {
        console.error(`  ${chalk.red("✗")} No hosted deployment named ${slug}`);
      } else {
        console.error(`  ${chalk.red("✗")} Update failed: ${res.status} ${res.statusText}`);
      }
      process.exit(1);
    });
}

const HOSTED_TIMEOUT_MS = 30_000;

interface HostedAgentInfo {
  agentEndpoint?: string;
  pagesIndexed?: number;
  tools?: Array<string | { name?: string }>;
  updatedAt?: string;
}

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}

function badSlug(slug: string): never {
  console.error(
    `  ${chalk.red("✗")} Invalid slug ${JSON.stringify(slug)}: use lowercase letters, digits and hyphens only.`,
  );
  process.exit(2);
}

function failRedirect(res: Response): void {
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location");
    console.error(`  ${chalk.red("✗")} Unexpected redirect: ${res.status}${to ? ` to ${to}` : ""}`);
    process.exit(1);
  }
}

function failNetwork(action: string, err: unknown): never {
  const e = err as Error;
  const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
  console.error(
    `  ${chalk.red("✗")} Could not ${action}: ${timedOut ? `no response within ${HOSTED_TIMEOUT_MS / 1000}s` : e.message}`,
  );
  process.exit(1);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
