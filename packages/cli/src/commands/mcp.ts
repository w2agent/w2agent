import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import {
  type GenerateContext,
  type GenerateOptions,
  generateMcpServer,
  runGenerate,
  type SelfHostPlatform,
} from "w2agent-core";

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Generate self-hosted MCP servers for any website");

  // --- mcp deploy ---
  mcp
    .command("deploy")
    .description("Generate a self-hosted MCP server for a website")
    .argument("<url>", "URL to generate MCP server for")
    .option("--self-host <platform>", "Self-host platform: vercel, cf")
    .option("-o, --output <dir>", "Output directory", "./w2agent-output")
    .option("-m, --max-pages <number>", "Maximum pages to crawl", "50")
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .action(async (url: string, opts) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }

      const selfHost = opts.selfHost as SelfHostPlatform | undefined;
      if (selfHost && !["vercel", "cf"].includes(selfHost)) {
        console.error(chalk.red(`Unknown self-host platform: ${selfHost}. Use "vercel" or "cf".`));
        process.exit(1);
      }

      const generateOptions: Partial<GenerateOptions> = {
        maxPages: parseInt(opts.maxPages, 10),
        timeout: parseInt(opts.timeout, 10),
        formats: ["mcp-server"],
      };

      const spinner = ora("Crawling site and generating MCP server...").start();

      try {
        // Run the generate pipeline to get crawled data + context
        const result = await runGenerate(url, generateOptions, (status) => {
          spinner.text = status;
        });

        let mcpFiles = result.files.filter((f) => f.filename.startsWith("mcp-server/"));

        // If self-host, re-generate with platform templates
        if (selfHost) {
          spinner.text = `Generating ${selfHost} template...`;
          // Extract the ctx from the result - rebuild from generated data
          const pagesFile = result.files.find((f) => f.filename === "mcp-server/data/pages.json");
          const pages = pagesFile ? JSON.parse(pagesFile.content) : [];
          const ctx: GenerateContext = {
            pages,
            rawPages: [],
            metadata: { baseUrl: new URL(url).origin, wellKnown: {} },
            baseUrl: new URL(url).origin,
          };
          mcpFiles = generateMcpServer(ctx, selfHost);
        }

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
        console.log(chalk.bold("  w2agent mcp deploy — Self-Host MCP Server"));
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
          console.log(`  Mode: ${chalk.magenta("Standalone MCP server")}`);
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
          console.log(chalk.gray("  npm install && vercel --prod"));
        } else if (selfHost === "cf") {
          console.log("  Next steps:");
          console.log(`${chalk.gray("  cd")} ${chalk.cyan(resolve(outputDir, "mcp-server"))}`);
          console.log(chalk.gray("  npm install"));
          console.log(chalk.gray("  # Edit wrangler.toml with your KV namespace ID"));
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
        spinner.fail(`MCP server generation failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // --- mcp status ---
  mcp
    .command("status")
    .description("Check status of a hosted MCP deployment")
    .argument("[slug]", "Deployment slug")
    .action(async (slug?: string) => {
      if (!slug) {
        console.log(chalk.yellow("Usage: w2agent mcp status <slug>"));
        console.log(
          chalk.gray("  Check health of a hosted MCP deployment at <slug>.mcp.w2agent.dev"),
        );
        return;
      }

      const spinner = ora(`Checking status of ${slug}.mcp.w2agent.dev...`).start();

      try {
        const res = await fetch(`https://${slug}.mcp.w2agent.dev/.well-known/mcp`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });

        spinner.stop();

        if (res.ok) {
          console.log(`  ${chalk.green("✓")} ${slug}.mcp.w2agent.dev is ${chalk.green("live")}`);
        } else {
          console.log(`  ${chalk.red("✗")} ${slug}.mcp.w2agent.dev returned ${res.status}`);
        }
      } catch (err) {
        spinner.stop();
        console.log(`  ${chalk.red("✗")} Could not reach ${slug}.mcp.w2agent.dev`);
        console.log(chalk.gray(`    ${(err as Error).message}`));
      }
    });

  // --- mcp update ---
  mcp
    .command("update")
    .description("Re-crawl and update a hosted MCP deployment")
    .argument("<slug>", "Deployment slug to update")
    .action(async (slug: string) => {
      const spinner = ora(`Triggering re-crawl for ${slug}...`).start();

      try {
        const res = await fetch(`https://w2agent.dev/api/mcp/webhook/${slug}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        spinner.stop();

        if (res.ok || res.status === 202) {
          console.log(`  ${chalk.green("✓")} Re-crawl triggered for ${slug}`);
          console.log(chalk.gray("    Updates will be reflected within a few minutes."));
        } else {
          console.log(`  ${chalk.red("✗")} Update failed: ${res.status} ${res.statusText}`);
        }
      } catch (err) {
        spinner.stop();
        console.log(`  ${chalk.red("✗")} Could not trigger update for ${slug}`);
        console.log(chalk.gray(`    ${(err as Error).message}`));
      }
    });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
