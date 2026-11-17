import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { platform } from "node:os";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import {
  enterJsonMode,
  failWith,
  type JsonMode,
  jsonRequested,
  loginRequiresApiKey,
} from "../agent/output.js";
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
    .option("--json", "Print one JSON document on stdout (result or error envelope)")
    .action(async (opts: { apiKey?: string; force?: boolean }) => {
      const json: JsonMode | undefined = jsonRequested() ? enterJsonMode() : undefined;

      // --api-key path
      if (opts.apiKey) {
        const key = opts.apiKey;
        if (!key.startsWith("w2a_") || key.length <= 4) {
          await failWith(
            json,
            {
              reason: "invalid_argument",
              message: "Invalid API key format. Keys must start with w2a_",
            },
            undefined,
            chalk.red("Invalid API key format. Keys must start with w2a_"),
          );
          return;
        }
        saveCredentials(key);
        if (json) await json.emit({ ok: true, outcome: "authenticated" });
        else console.log(chalk.green("✓ API key saved successfully."));
        return;
      }

      // Already logged in check
      const existing = loadCredentials();
      if (existing && !opts.force) {
        const who = existing.email ? ` as ${existing.email}` : "";
        if (json) {
          await json.emit({ ok: true, outcome: "already_authenticated" });
          return;
        }
        console.log(
          chalk.yellow(
            `Already logged in${who}. Use --force to re-authenticate or run \`w2agent logout\` first.`,
          ),
        );
        return;
      }

      if (loginRequiresApiKey(process.env, process.stdin.isTTY)) {
        const message =
          "Browser login needs an interactive terminal. Create an API key at https://w2agent.dev and run: w2agent login --api-key <api-key>";
        await failWith(
          json,
          {
            reason: "auth_required",
            message,
            next: [["w2agent", "login", "--api-key", "<api-key>"]],
          },
          undefined,
          message,
        );
        return;
      }

      await runBrowserLogin({ json });
    });
}

export interface BrowserLoginDeps {
  json?: JsonMode;
  timeoutMs?: number;
  open?: (url: string) => void;
  exit?: (code: number) => void;
}

/**
 * Resolves once the login has finished one way or the other. The timer is
 * cleared and the listener closed on success so nothing later fires or keeps
 * the process alive.
 */
export function runBrowserLogin(deps: BrowserLoginDeps = {}): Promise<void> {
  const {
    json,
    timeoutMs = 120_000,
    open = openBrowser,
    exit = (code: number) => process.exit(code),
  } = deps;
  return new Promise<void>((resolve) => {
    const state = randomBytes(16).toString("hex");
    let spinner: ReturnType<typeof ora> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const finishServer = () => {
      server.close();
      server.closeAllConnections();
    };

    const abort = (reason: "unknown_failure" | "timeout", message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spinner?.stop();
      finishServer();
      const done = () => {
        exit(1);
        resolve();
      };
      if (!json) {
        console.error(chalk.red(message));
        console.log(chalk.yellow("Use --api-key instead: w2agent login --api-key <key>"));
        done();
        return;
      }
      void failWith(json, {
        reason,
        message,
        next: [["w2agent", "login", "--api-key", "<api-key>"]],
      }).then(done);
    };

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

      if (settled) {
        res.writeHead(409, { "Content-Type": "text/plain" });
        res.end("Login already finished.");
        return;
      }
      settled = true;
      clearTimeout(timer);

      res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
      res.end(SUCCESS_HTML, () => finishServer());

      saveCredentials(token, email);
      spinner?.stop();
      if (json) {
        void json.emit({ ok: true, outcome: "authenticated" }).then(resolve);
        return;
      }
      const emailStr = email ? ` as ${chalk.white(email)}` : "";
      console.log(chalk.green(`✓ Logged in successfully${emailStr}.`));
      resolve();
    });

    server.on("error", (err) => {
      abort("unknown_failure", `Failed to start local server: ${err.message}`);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        abort("unknown_failure", "Could not determine server port.");
        return;
      }
      const authUrl = `${getApiUrl()}/cli/auth?port=${addr.port}&state=${state}`;

      spinner = json ? undefined : ora("Waiting for browser authentication...").start();
      console.log(chalk.gray(`\n  Opening: ${authUrl}`));
      open(authUrl);
    });

    timer = setTimeout(() => {
      abort("timeout", `Authentication timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }, timeoutMs);
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
