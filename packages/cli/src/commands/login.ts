import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { platform } from "node:os";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { clearCredentials, getApiUrl, loadCredentials, saveCredentials } from "../auth.js";

function openBrowser(url: string): void {
  const plat = platform();
  if (plat === "darwin") {
    execFile("open", [url], (err) => {
      if (err)
        console.log(chalk.yellow(`  Could not open browser. Open this URL manually:\n  ${url}`));
    });
  } else if (plat === "win32") {
    execFile("cmd", ["/c", "start", url], (err) => {
      if (err)
        console.log(chalk.yellow(`  Could not open browser. Open this URL manually:\n  ${url}`));
    });
  } else {
    execFile("xdg-open", [url], (err) => {
      if (err)
        console.log(chalk.yellow(`  Could not open browser. Open this URL manually:\n  ${url}`));
    });
  }
}

const SUCCESS_HTML = `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#09090b;color:#fafafa">
<h1>✓ Authenticated</h1><p>You can close this tab and return to your terminal.</p>
</body></html>`;

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Authenticate with w2agent")
    .option("--api-key <key>", "Authenticate with an API key directly")
    .option("--force", "Re-authenticate even if already logged in")
    .action(async (opts: { apiKey?: string; force?: boolean }) => {
      // --api-key path
      if (opts.apiKey) {
        const key = opts.apiKey;
        if (!key.startsWith("w2a_") || key.length <= 4) {
          console.error(chalk.red("Invalid API key format. Keys must start with w2a_"));
          process.exit(1);
        }
        saveCredentials(key);
        console.log(chalk.green("✓ API key saved successfully."));
        return;
      }

      // Already logged in check
      const existing = loadCredentials();
      if (existing && !opts.force) {
        const who = existing.email ? ` as ${existing.email}` : "";
        console.log(
          chalk.yellow(
            `Already logged in${who}. Use --force to re-authenticate or run \`w2agent logout\` first.`,
          ),
        );
        return;
      }

      // Browser OAuth path
      const state = randomBytes(16).toString("hex");

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end();
          return;
        }

        const token = url.searchParams.get("token");
        const returnedState = url.searchParams.get("state");
        const email = url.searchParams.get("email") ?? undefined;

        if (returnedState !== state) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("State mismatch. Please try again.");
          console.error(
            chalk.red("  ✗ State mismatch in callback. Possible CSRF attempt. Try again."),
          );
          return;
        }

        if (!token) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing token.");
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);

        setTimeout(() => server.close(), 500);

        saveCredentials(token, email);
        spinner.stop();
        const emailStr = email ? ` as ${chalk.white(email)}` : "";
        console.log(chalk.green(`✓ Logged in successfully${emailStr}.`));
      });

      let spinner: ReturnType<typeof ora>;

      server.on("error", (err) => {
        console.error(chalk.red(`Failed to start local server: ${err.message}`));
        console.log(chalk.yellow("Use --api-key instead: w2agent login --api-key <key>"));
        process.exit(1);
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          console.error(chalk.red("Could not determine server port."));
          process.exit(1);
        }
        const port = addr.port;
        const authUrl = `${getApiUrl()}/cli/auth?port=${port}&state=${state}`;

        spinner = ora("Waiting for browser authentication...").start();
        console.log(chalk.gray(`\n  Opening: ${authUrl}`));
        openBrowser(authUrl);
      });

      // 120s timeout
      setTimeout(() => {
        server.close();
        console.error(chalk.red("\n✗ Authentication timed out after 120 seconds."));
        console.log(chalk.yellow("Use --api-key instead: w2agent login --api-key <key>"));
        process.exit(1);
      }, 120_000);
    });
}

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Clear stored authentication credentials")
    .action(() => {
      const creds = loadCredentials();
      if (!creds) {
        console.log(chalk.yellow("Not currently logged in."));
        return;
      }
      clearCredentials();
      console.log(chalk.green("Logged out successfully."));
    });
}

export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Show current authentication status")
    .action(async () => {
      const creds = loadCredentials();
      if (!creds) {
        console.log(chalk.yellow("Not logged in. Run `w2agent login` to authenticate."));
        return;
      }

      console.log(`  Token: ${chalk.gray(`${creds.token.slice(0, 8)}...`)}`);
      if (creds.email) {
        console.log(`  Email: ${chalk.white(creds.email)}`);
      }

      const spinner = ora("Verifying with server...").start();
      try {
        const res = await fetch(`${getApiUrl()}/api/cli/whoami`, {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        spinner.stop();
        if (res.ok) {
          const data = (await res.json()) as { email?: string; plan?: string };
          console.log(`  Account: ${chalk.white(data.email)} (${data.plan || "free"})`);
          console.log(chalk.green("  ✓ Token is valid"));
        } else if (res.status === 401) {
          console.log(
            chalk.red("  ✗ Token is invalid or expired. Run `w2agent login` to re-authenticate."),
          );
        } else {
          console.log(chalk.yellow(`  ⚠ Server returned ${res.status}. Token may still be valid.`));
        }
      } catch {
        spinner.stop();
        console.log(chalk.yellow("  ⚠ Could not reach server. Showing local credentials only."));
      }
    });
}
