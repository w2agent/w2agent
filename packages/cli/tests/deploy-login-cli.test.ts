import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openBrowser } from "../src/commands/login.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");
const skip = !existsSync(CLI);

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const dirs: string[] = [];

function run(args: string[], apiUrl: string, home?: string): Promise<Run> {
  const h = home ?? mkdtempSync(join(tmpdir(), "w2agent-dl-test-"));
  if (!home) dirs.push(h);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: h,
    USERPROFILE: h,
    W2AGENT_API_URL: apiUrl,
  };
  for (const name of ["AI_AGENT", "CLAUDECODE", "CODEX_CI"]) delete env[name];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

type Mode =
  | "normal"
  | "no-newline"
  | "no-space"
  | "crlf"
  | "object-error"
  | "no-tools"
  | "unauthorized"
  | "whoami-500"
  | "whoami-hang";

let mode: Mode = "normal";
let seen: Array<{ path: string; auth?: string }> = [];
let server: Server;
let apiUrl = "";
const hung: Array<() => void> = [];

const RESULT = {
  slug: "my-site",
  url: "https://my-site.example.com",
  agentEndpoint: "https://my-site.agent.example.com/mcp",
  tools: [{ name: "search-site", description: "d" }],
  pagesIndexed: 3,
  totalPagesFound: 3,
  webhookToken: "w2wh_secret",
  webhookUrl: "https://w2agent.example.com/api/agent/webhook/my-site",
  isRedeploy: false,
};

const ev = (e: unknown) => JSON.stringify(e);

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization;
    seen.push({ path: req.url ?? "", auth });
    if (req.url === "/api/cli/whoami") {
      if (mode === "whoami-hang") {
        hung.push(() => res.destroy());
        return;
      }
      if (mode === "whoami-500") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"boom"}');
        return;
      }
      if (auth === "Bearer w2a_good") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"email":"user@example.com","plan":"free"}');
        return;
      }
      const forbidden = auth === "Bearer w2a_forbidden";
      res.writeHead(forbidden ? 403 : 401, { "Content-Type": "application/json" });
      res.end('{"error":"Invalid API key"}');
      return;
    }
    if (req.url === "/api/agent/deploy") {
      if (mode === "unauthorized") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"Unauthorized"}');
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const progress = ev({ type: "progress", data: "Crawling" });
      const result = ev({ type: "result", data: RESULT });
      if (mode === "no-newline") res.end(`data: ${progress}\n\ndata: ${result}`);
      else if (mode === "no-space") res.end(`data:${progress}\n\ndata:${result}\n\n`);
      else if (mode === "crlf") res.end(`data: ${progress}\r\n\r\ndata: ${result}\r\n\r\n`);
      else if (mode === "object-error") {
        res.end(`data: ${ev({ type: "error", data: { message: "Crawl blocked" } })}\n\n`);
      } else if (mode === "no-tools") {
        const { tools: _t, ...rest } = RESULT;
        res.end(`data: ${ev({ type: "result", data: rest })}\n\n`);
      } else res.end(`data: ${progress}\n\ndata: ${result}\n\n`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const d of hung) d();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  mode = "normal";
  seen = [];
});

describe("deploy against a hosted-API mock (DEP-5)", () => {
  it.skipIf(skip).each(["normal", "no-newline", "no-space", "crlf"] as const)(
    "framing variant %s prints the real endpoint",
    async (m) => {
      mode = m;
      const r = await run(["deploy", "https://example.com", "--api-key", "w2a_good"], apiUrl);
      const out = r.stdout + r.stderr;
      expect(r.code).toBe(0);
      expect(out).toContain("https://my-site.agent.example.com/mcp");
      expect(out).not.toContain("undefined");
      expect(out).not.toContain("[object Object]");
    },
  );

  it.skipIf(skip)("a result without tools succeeds", async () => {
    mode = "no-tools";
    const r = await run(["deploy", "https://example.com", "--api-key", "w2a_good"], apiUrl);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toContain("https://my-site.agent.example.com/mcp");
  });

  it.skipIf(skip)("an object error prints its message", async () => {
    mode = "object-error";
    const r = await run(["deploy", "https://example.com", "--api-key", "w2a_good"], apiUrl);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("Crawl blocked");
    expect(r.stdout + r.stderr).not.toContain('"message"');
    expect(r.stdout + r.stderr).not.toContain("[object Object]");
  });

  it.skipIf(skip)("401 message depends on the auth source", async () => {
    mode = "unauthorized";
    const flag = await run(["deploy", "https://example.com", "--api-key", "w2a_bad"], apiUrl);
    expect(flag.code).toBe(1);
    expect(flag.stderr).toContain("--api-key was rejected");
    expect(flag.stderr).not.toContain("w2agent login");

    const home = mkdtempSync(join(tmpdir(), "w2agent-dl-test-"));
    dirs.push(home);
    await run(["login", "--api-key", "w2a_good"], apiUrl, home);
    const saved = await run(["deploy", "https://example.com"], apiUrl, home);
    expect(saved.code).toBe(1);
    expect(saved.stderr).toContain("login --force");

    const anon = await run(["deploy", "https://example.com"], apiUrl);
    expect(anon.stderr).toContain("Run `w2agent login` to authenticate");
  });
});

describe("login --api-key verifies the key (DEP-5)", () => {
  const configOf = (home: string) => join(home, ".w2agent", "config.json");
  const freshHome = () => {
    const h = mkdtempSync(join(tmpdir(), "w2agent-dl-test-"));
    dirs.push(h);
    return h;
  };

  it.skipIf(skip)("a rejected key: auth_required, exit 1, nothing saved", async () => {
    const home = freshHome();
    const r = await run(["login", "--api-key", "w2a_bad", "--json"], apiUrl, home);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error.reason).toBe("auth_required");
    expect(r.stdout).not.toContain("w2a_bad");
    expect(existsSync(configOf(home))).toBe(false);
    expect(seen).toEqual([{ path: "/api/cli/whoami", auth: "Bearer w2a_bad" }]);
  });

  it.skipIf(skip)("403 also rejects and saves nothing", async () => {
    const home = freshHome();
    const r = await run(["login", "--api-key", "w2a_forbidden", "--json"], apiUrl, home);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.reason).toBe("auth_required");
    expect(existsSync(configOf(home))).toBe(false);
  });

  it.skipIf(skip)("a rejected key leaves an existing config byte-identical", async () => {
    const home = freshHome();
    expect((await run(["login", "--api-key", "w2a_good"], apiUrl, home)).code).toBe(0);
    const before = readFileSync(configOf(home));
    const r = await run(["login", "--api-key", "w2a_bad"], apiUrl, home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rejected");
    expect(readFileSync(configOf(home)).equals(before)).toBe(true);
  });

  it.skipIf(skip)("a good key is saved with the returned email: one JSON document", async () => {
    const home = freshHome();
    const r = await run(["login", "--api-key", "w2a_good", "--json"], apiUrl, home);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, outcome: "authenticated" });
    expect(r.stderr).not.toContain("Warning");
    const saved = JSON.parse(readFileSync(configOf(home), "utf-8"));
    expect(saved.token).toBe("w2a_good");
    expect(saved.email).toBe("user@example.com");
  });

  it.skipIf(skip)("a server error: saved, warning on stderr, exit 0", async () => {
    mode = "whoami-500";
    const home = freshHome();
    const r = await run(["login", "--api-key", "w2a_whatever", "--json"], apiUrl, home);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, outcome: "authenticated" });
    expect(r.stderr).toContain("could not verify");
    expect(r.stderr).toContain("500");
    expect(JSON.parse(readFileSync(configOf(home), "utf-8")).token).toBe("w2a_whatever");
  });

  it.skipIf(skip)("an unreachable server: saved, warning, exit 0", async () => {
    const home = freshHome();
    const r = await run(["login", "--api-key", "w2a_offline"], "http://127.0.0.1:1", home);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("could not verify");
    expect(JSON.parse(readFileSync(configOf(home), "utf-8")).token).toBe("w2a_offline");
  });

  it.skipIf(skip)("a malformed key makes no request", async () => {
    const r = await run(["login", "--api-key", "sk_nope", "--json"], apiUrl);
    expect(r.code).toBe(2);
    expect(seen).toEqual([]);
  });

  it.skipIf(skip)(
    "a server that never answers cannot hang login past the timeout",
    async () => {
      mode = "whoami-hang";
      const home = freshHome();
      const started = Date.now();
      const r = await run(["login", "--api-key", "w2a_hang", "--json"], apiUrl, home);
      expect(r.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(45_000);
      expect(r.stderr).toContain("could not verify");
      expect(JSON.parse(r.stdout)).toEqual({ ok: true, outcome: "authenticated" });
    },
    60_000,
  );
});

describe("openBrowser", () => {
  const url = "https://example.com/cli/auth?port=1&state=abc";

  it("passes the URL to rundll32 on Windows so & is not parsed by cmd", () => {
    const exec = vi.fn();
    openBrowser(url, "win32", exec as never);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.slice(0, 2)).toEqual([
      "rundll32",
      ["url.dll,FileProtocolHandler", url],
    ]);
  });

  it("uses open on macOS and xdg-open elsewhere", () => {
    const exec = vi.fn();
    openBrowser(url, "darwin", exec as never);
    openBrowser(url, "linux", exec as never);
    expect(exec.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["open", [url]],
      ["xdg-open", [url]],
    ]);
  });
});

describe("credential hygiene (gate fix A, B)", () => {
  const SECRET = "w2a_secretpart";
  const freshHome = () => {
    const h = mkdtempSync(join(tmpdir(), "w2agent-dl-test-"));
    dirs.push(h);
    return h;
  };

  it.skipIf(skip)("login rejects a key with a control character before any request", async () => {
    const home = freshHome();
    const r = await run(
      ["login", "--api-key", `${SECRET}\ncopy`, "--json"],
      "http://127.0.0.1:1",
      home,
    );
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.reason).toBe("invalid_argument");
    expect(r.stdout + r.stderr).not.toContain("secretpart");
    expect(existsSync(join(home, ".w2agent", "config.json"))).toBe(false);
  });

  it.skipIf(skip)("login rejects a key with a space", async () => {
    const r = await run(["login", "--api-key", "w2a_two words"], "http://127.0.0.1:1", freshHome());
    expect(r.code).toBe(2);
  });

  it.skipIf(skip)("login with a bad key keeps a good saved config", async () => {
    const home = freshHome();
    await run(["login", "--api-key", "w2a_good"], apiUrl, home);
    const before = readFileSync(join(home, ".w2agent", "config.json"));
    const r = await run(["login", "--api-key", `${SECRET}\ncopy`], apiUrl, home);
    expect(r.code).toBe(2);
    expect(readFileSync(join(home, ".w2agent", "config.json")).equals(before)).toBe(true);
    expect(seen.filter((s) => s.auth?.includes("secretpart"))).toEqual([]);
  });

  it.skipIf(skip)(
    "deploy --api-key with a control character: exit 2, no echo, no request",
    async () => {
      const r = await run(
        ["deploy", "https://example.com", "--api-key", `${SECRET}\ncopy`],
        apiUrl,
      );
      expect(r.code).toBe(2);
      expect(r.stdout + r.stderr).not.toContain("secretpart");
      expect(seen).toEqual([]);
    },
  );

  it.skipIf(skip)("deploy with an unusable saved token says to log in again, no echo", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".w2agent"), { recursive: true });
    writeFileSync(
      join(home, ".w2agent", "config.json"),
      JSON.stringify({ token: `${SECRET}\ncopy`, created: "2026-01-01T00:00:00Z" }),
    );
    const r = await run(["deploy", "https://example.com"], "http://127.0.0.1:1", home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("login --force");
    expect(r.stdout + r.stderr).not.toContain("secretpart");
  });

  it.skipIf(skip)("a --token usage error never echoes the token (json and human)", async () => {
    for (const args of [
      ["agent", "--token=w2wh_topsecret", "update", "demo"],
      ["agent", "--token", "w2wh_topsecret", "update", "demo"],
    ]) {
      for (const extra of [["--json"], []]) {
        const r = await run([...args, ...extra], apiUrl);
        expect(r.code).toBe(2);
        expect(r.stdout + r.stderr).not.toContain("topsecret");
      }
    }
  });
});
