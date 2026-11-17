import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const skip = !existsSync(cliEntry);

interface Seen {
  method: string;
  path: string;
  auth?: string;
}

let server: Server;
let apiUrl = "";
let seen: Seen[] = [];
let respond: (
  path: string,
  method: string,
) => { status: number; body: unknown; headers?: Record<string, string> } = () => ({
  status: 404,
  body: { error: "Site not found" },
});
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "w2agent-hosted-"));
  dirs.push(d);
  return d;
}

function run(
  args: string[],
  env: Record<string, string | undefined> = {},
  url = apiUrl,
): Promise<{ code: number; out: string }> {
  const home = tmp();
  mkdirSync(join(home, ".w2agent"), { recursive: true });
  writeFileSync(
    join(home, ".w2agent", "config.json"),
    JSON.stringify({ token: "w2a_saved_login_key", created: "2026-01-01T00:00:00Z" }),
  );
  const base: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: "1",
    HOME: home,
    USERPROFILE: home,
    W2AGENT_API_URL: url,
    W2AGENT_WEBHOOK_TOKEN: undefined,
  };
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliEntry, ...args],
      { cwd: home, timeout: 60000, env: { ...base, ...env } as NodeJS.ProcessEnv },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "";
    seen.push({ method: req.method ?? "", path, auth: req.headers.authorization });
    const r = respond(path, req.method ?? "");
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
    res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  respond = () => ({ status: 202, body: { message: "ok", slug: "my-site" } });
});

describe("agent update (DEP-4)", () => {
  it.skipIf(skip)("sends the env token as a bearer header to the encoded slug path", async () => {
    const { code, out } = await run(["agent", "update", "my-site"], {
      W2AGENT_WEBHOOK_TOKEN: "whk_env",
    });
    expect(code).toBe(0);
    expect(out).toContain("Re-crawl triggered");
    expect(seen).toEqual([
      { method: "POST", path: "/api/agent/webhook/my-site", auth: "Bearer whk_env" },
    ]);
  });

  it.skipIf(skip)("--token wins over the env var", async () => {
    const { code } = await run(["agent", "update", "my-site", "--token", "whk_flag"], {
      W2AGENT_WEBHOOK_TOKEN: "whk_env",
    });
    expect(code).toBe(0);
    expect(seen.map((s) => s.auth)).toEqual(["Bearer whk_flag"]);
  });

  it.skipIf(skip)("never falls back to the saved login key", async () => {
    const { code, out } = await run(["agent", "update", "my-site"]);
    expect(code).toBe(1);
    expect(out).toContain("W2AGENT_WEBHOOK_TOKEN");
    expect(out).toContain("--token");
    expect(seen).toEqual([]);
  });

  it.skipIf(skip)("401 means the token was rejected", async () => {
    respond = () => ({ status: 401, body: { error: "Unauthorized" } });
    const { code, out } = await run(["agent", "update", "my-site"], {
      W2AGENT_WEBHOOK_TOKEN: "whk_bad",
    });
    expect(code).toBe(1);
    expect(out).toContain("token rejected");
  });

  it.skipIf(skip)("404 means unknown slug", async () => {
    respond = () => ({ status: 404, body: { error: "Site not found" } });
    const { code, out } = await run(["agent", "update", "my-site"], {
      W2AGENT_WEBHOOK_TOKEN: "whk",
    });
    expect(code).toBe(1);
    expect(out).toContain("No hosted deployment named my-site");
  });

  it.skipIf(skip)("429 exits 1 with the status", async () => {
    respond = () => ({ status: 429, body: {} });
    const { code, out } = await run(["agent", "update", "my-site"], {
      W2AGENT_WEBHOOK_TOKEN: "whk",
    });
    expect(code).toBe(1);
    expect(out).toContain("429");
  });

  it.skipIf(skip)("dead port exits 1", async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const dead = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    await new Promise<void>((r) => s.close(() => r()));
    const { code, out } = await run(
      ["agent", "update", "my-site"],
      { W2AGENT_WEBHOOK_TOKEN: "whk" },
      dead,
    );
    expect(code).toBe(1);
    expect(out).toContain("Could not");
  });
});

describe("agent update token and redirect guards (DEP-4)", () => {
  it.skipIf(skip)("a control-character token is rejected without echoing it", async () => {
    const { code, out } = await run(["agent", "update", "my-site"], {
      W2AGENT_WEBHOOK_TOKEN: "abcSECRET\ndef",
    });
    expect(code).toBe(1);
    expect(out).not.toContain("SECRET");
    expect(seen).toEqual([]);
  });

  it.skipIf(skip)("a whitespace-only token counts as no token", async () => {
    const { code, out } = await run(["agent", "update", "my-site"], {
      W2AGENT_WEBHOOK_TOKEN: "  \t ",
    });
    expect(code).toBe(1);
    expect(out).toContain("No webhook token");
    expect(seen).toEqual([]);
  });

  it.skipIf(skip)("a trailing CR/LF is trimmed from the token", async () => {
    const { code } = await run(["agent", "update", "my-site"], {
      W2AGENT_WEBHOOK_TOKEN: "whk_env\r\n",
    });
    expect(code).toBe(0);
    expect(seen.map((x) => x.auth)).toEqual(["Bearer whk_env"]);
  });

  it.skipIf(skip)("an empty --token falls through to the env var", async () => {
    const { code } = await run(["agent", "update", "my-site", "--token", " "], {
      W2AGENT_WEBHOOK_TOKEN: "whk_env",
    });
    expect(code).toBe(0);
    expect(seen.map((x) => x.auth)).toEqual(["Bearer whk_env"]);
  });

  it.skipIf(skip)("a redirect is a failure and is not followed", async () => {
    respond = (path) =>
      path.startsWith("/api/agent/webhook/")
        ? { status: 302, body: "", headers: { location: "/elsewhere" } }
        : { status: 200, body: {} };
    const { code, out } = await run(["agent", "update", "my-site"], {
      W2AGENT_WEBHOOK_TOKEN: "whk",
    });
    expect(code).toBe(1);
    expect(out).toContain("302");
    expect(out).toContain("/elsewhere");
    expect(out).not.toContain("Re-crawl triggered");
    expect(seen.map((x) => x.path)).toEqual(["/api/agent/webhook/my-site"]);
  });
});

describe("agent status (DEP-4)", () => {
  it.skipIf(skip)("a 200 with a non-JSON body is an error", async () => {
    respond = () => ({
      status: 200,
      body: "<html>hi</html>",
      headers: { "content-type": "text/html" },
    });
    const { code, out } = await run(["agent", "status", "my-site"]);
    expect(code).toBe(1);
    expect(out).toContain("Unexpected response");
    expect(out).not.toContain("live");
  });

  it.skipIf(skip)("a 200 with a non-object JSON body is an error", async () => {
    respond = () => ({ status: 200, body: [1, 2] });
    const { code, out } = await run(["agent", "status", "my-site"]);
    expect(code).toBe(1);
    expect(out).toContain("Unexpected response");
  });

  it.skipIf(skip)("a redirect is a failure and is not followed", async () => {
    respond = (path) =>
      path === "/api/agent/my-site"
        ? { status: 302, body: "", headers: { location: "/elsewhere" } }
        : { status: 200, body: {} };
    const { code, out } = await run(["agent", "status", "my-site"]);
    expect(code).toBe(1);
    expect(out).toContain("302");
    expect(seen.map((x) => x.path)).toEqual(["/api/agent/my-site"]);
  });

  it.skipIf(skip)("200 prints the live endpoint, pages and tools", async () => {
    respond = () => ({
      status: 200,
      body: {
        name: "My Site",
        agentEndpoint: "https://my-site.example.test/mcp",
        pagesIndexed: 12,
        tools: [{ name: "search-site" }, { name: "get-page" }],
        updatedAt: "2026-11-01T00:00:00Z",
      },
    });
    const { code, out } = await run(["agent", "status", "my-site"]);
    expect(code).toBe(0);
    expect(out).toContain("live");
    expect(out).toContain("https://my-site.example.test/mcp");
    expect(out).toContain("12");
    expect(out).toContain("search-site, get-page");
    expect(seen).toEqual([{ method: "GET", path: "/api/agent/my-site", auth: undefined }]);
  });

  it.skipIf(skip)("404 exits 1", async () => {
    respond = () => ({ status: 404, body: { error: "Site not found" } });
    const { code, out } = await run(["agent", "status", "my-site"]);
    expect(code).toBe(1);
    expect(out).toContain("No hosted deployment named my-site");
  });

  it.skipIf(skip)("500 exits 1", async () => {
    respond = () => ({ status: 500, body: {} });
    const { code, out } = await run(["agent", "status", "my-site"]);
    expect(code).toBe(1);
    expect(out).toContain("500");
  });

  it.skipIf(skip)("dead port exits 1", async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const dead = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    await new Promise<void>((r) => s.close(() => r()));
    const { code } = await run(["agent", "status", "my-site"], {}, dead);
    expect(code).toBe(1);
  });

  it.skipIf(skip)("no slug prints usage and exits 0", async () => {
    const { code, out } = await run(["agent", "status"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage: w2agent agent status <slug>");
    expect(seen).toEqual([]);
  });
});

describe("slug validation (DEP-4)", () => {
  const bad = ["evil.example/x#", "../cli/whoami#", "UPPER"];
  it.skipIf(skip).each(bad)("update rejects %s before any request", async (slug) => {
    const { code, out } = await run(["agent", "update", slug], { W2AGENT_WEBHOOK_TOKEN: "whk" });
    expect(code).toBe(2);
    expect(out).toContain("Invalid slug");
    expect(seen).toEqual([]);
  });

  it.skipIf(skip).each(bad)("status rejects %s before any request", async (slug) => {
    const { code, out } = await run(["agent", "status", slug]);
    expect(code).toBe(2);
    expect(out).toContain("Invalid slug");
    expect(seen).toEqual([]);
  });
});
