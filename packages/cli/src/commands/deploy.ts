import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { getApiUrl, getAuthHeaders, isHeaderSafeToken, loadCredentials } from "../auth.js";

interface DeployResult {
  slug: string;
  agentEndpoint: string;
  pagesIndexed: number;
  totalPagesFound?: number;
  tools: Array<{ name: string; description?: string }>;
  webhookUrl?: string;
  webhookToken?: string;
  isRedeploy: boolean;
}

interface SseMessage {
  type: "progress" | "result" | "error";
  data: unknown;
}

async function handleDeployAction(
  url: string,
  opts: { apiKey?: string; slug?: string; showToken?: boolean },
): Promise<void> {
  const apiUrl = getApiUrl();
  const authHeaders = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : getAuthHeaders();

  const token = opts.apiKey || loadCredentials()?.token;
  if (token !== undefined && !isHeaderSafeToken(token)) {
    if (opts.apiKey) {
      console.error(
        chalk.red("✗ Invalid API key: use visible ASCII characters only (it starts with w2a_)."),
      );
      process.exit(2);
    }
    console.error(
      chalk.red(
        "✗ The saved credentials are not valid. Run `w2agent login --force` to log in again.",
      ),
    );
    process.exit(1);
  }

  if (Object.keys(authHeaders).length === 0) {
    console.log(
      chalk.yellow(
        "⚠ Not logged in. Deploying anonymously — run `w2agent login` to claim ownership.",
      ),
    );
  }

  const spinner = ora("Connecting to w2agent.dev...").start();

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/agent/deploy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ url, stream: true, ...(opts.slug ? { slug: opts.slug } : {}) }),
    });
  } catch (err) {
    spinner.fail("Could not reach w2agent.dev");
    console.error(chalk.red(`  ${(err as Error).message}`));
    process.exit(1);
  }

  if (!response.ok) {
    spinner.stop();
    let errMsg = `HTTP ${response.status}`;
    try {
      const json = (await response.json()) as { error?: string };
      if (json.error) errMsg = json.error;
    } catch {}

    if (response.status === 401) {
      const hint = opts.apiKey
        ? "The API key passed with --api-key was rejected."
        : Object.keys(authHeaders).length > 0
          ? "The saved credentials were rejected. Run `w2agent login --force` to log in again."
          : "Authentication failed. Run `w2agent login` to authenticate.";
      console.error(chalk.red(`✗ ${hint}`));
    } else if (response.status === 403) {
      console.error(chalk.red(`✗ ${errMsg}`));
    } else if (response.status === 400) {
      console.error(chalk.red(`✗ Invalid request: ${errMsg}`));
    } else {
      console.error(chalk.red(`✗ Agentize failed: ${errMsg}`));
    }
    process.exit(1);
  }

  // Parse SSE stream
  const reader = response.body?.getReader();
  if (!reader) {
    spinner.fail("No response body");
    process.exit(1);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const parseLine = (line: string): SseMessage | null => {
    if (!line.startsWith("data:")) return null;
    const payload = line.slice(5);
    try {
      return JSON.parse(payload.startsWith(" ") ? payload.slice(1) : payload) as SseMessage;
    } catch {
      return null;
    }
  };

  const handleMessage = (msg: SseMessage): boolean => {
    if (msg.type === "progress") {
      spinner.text = String(msg.data);
    } else if (msg.type === "result") {
      spinner.succeed("Agentize complete");
      printResult(msg.data as DeployResult, opts.showToken ?? false);
      return true;
    } else if (msg.type === "error") {
      spinner.fail("Agentize failed");
      console.error(chalk.red(`  ${describeError(msg.data)}`));
      process.exit(1);
    }
    return false;
  };

  const processLine = (rawLine: string): boolean => {
    const msg = parseLine(rawLine);
    return msg ? handleMessage(msg) : false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (processLine(line)) return;
    }
  }

  buffer += decoder.decode();
  for (const line of buffer.split("\n")) {
    if (processLine(line)) return;
  }

  spinner.fail("Agentize ended without a result");
  process.exit(1);
}

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy <url>")
    .description("Agentize your website — host it as a live agent server on w2agent.dev")
    .option("--api-key <key>", "API key for one-shot agentize (without saving credentials)")
    .option("--slug <slug>", "Custom slug for the deployment")
    .option("--show-token", "Print the webhook token in plaintext")
    .action((url, opts) => handleDeployAction(url, opts));
}

export function registerAgentizeCommand(program: Command): void {
  program
    .command("agentize <url>")
    .description("Agentize your website — host it as a live agent server on w2agent.dev")
    .option("--api-key <key>", "API key for one-shot agentize (without saving credentials)")
    .option("--slug <slug>", "Custom slug for the deployment")
    .option("--show-token", "Print the webhook token in plaintext")
    .action((url, opts) => handleDeployAction(url, opts));
}

function describeError(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(data) ?? "unknown error";
}

function maskToken(token: string): string {
  const idx = token.indexOf("_");
  return idx !== -1 ? `${token.slice(0, idx + 1)}****` : "****";
}

function printResult(result: DeployResult, showToken: boolean): void {
  console.log();
  if (result.isRedeploy) {
    console.log(chalk.yellow("  Re-agentized") + chalk.gray(` → ${result.slug}`));
  } else {
    console.log(chalk.green("  Agentized") + chalk.gray(` → ${result.slug}`));
  }
  console.log();
  console.log(`  ${chalk.gray("Agent endpoint")}  ${chalk.white(result.agentEndpoint)}`);
  console.log(
    `  ${chalk.gray("Pages")}         ${chalk.white(result.pagesIndexed)}${result.totalPagesFound && result.totalPagesFound > result.pagesIndexed ? chalk.gray(` / ${result.totalPagesFound} found`) : ""}`,
  );

  const tools = result.tools ?? [];
  if (tools.length > 0) {
    console.log(
      `  ${chalk.gray("Tools")}         ${chalk.white(tools.map((t) => t.name).join(", "))}`,
    );
  }

  if (result.webhookUrl) {
    console.log(`  ${chalk.gray("Webhook")}       ${chalk.white(result.webhookUrl)}`);
  }
  if (result.webhookToken) {
    const displayToken = showToken ? result.webhookToken : maskToken(result.webhookToken);
    console.log(`  ${chalk.gray("Webhook token")} ${chalk.gray(displayToken)}`);
  }
  console.log();
}
