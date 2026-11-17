import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");
const SPY = join(here, "fixtures", "spy-fetch.mjs");

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  requests: string[];
  home: string;
}

function run(args: string[], apiUrl: string | undefined, savedConfig = false): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "w2agent-apiurl-"));
  const home = join(dir, "home");
  mkdirSync(home);
  if (savedConfig) {
    mkdirSync(join(home, ".w2agent"));
    writeFileSync(
      join(home, ".w2agent", "config.json"),
      JSON.stringify({ token: "w2a_savedtoken12345" }),
    );
  }
  const spyLog = join(dir, "spy.log");
  writeFileSync(spyLog, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SPY_LOG: spyLog,
    NODE_OPTIONS: `--import ${SPY}`,
  };
  for (const name of ["AI_AGENT", "CLAUDECODE", "CODEX_CI", "W2AGENT_WEBHOOK_TOKEN"]) {
    delete env[name];
  }
  if (apiUrl === undefined) delete env.W2AGENT_API_URL;
  else env.W2AGENT_API_URL = apiUrl;
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
    child.on("close", (code) => {
      const requests = readFileSync(spyLog, "utf-8").split("\n").filter(Boolean);
      resolve({ code, stdout, stderr, requests, home });
    });
  });
}

const REFUSED = [
  "http://api.evil.test",
  "http://127.0.0.1.evil.test",
  "http://127.0.0.1@evil.test",
  "ftp://127.0.0.1",
  "not a url",
];

const COMMANDS: { name: string; args: string[]; savedConfig?: boolean }[] = [
  { name: "login --api-key", args: ["login", "--api-key", "w2a_SECRETkey12345"] },
  { name: "login --api-key --json", args: ["login", "--api-key", "w2a_SECRETkey12345", "--json"] },
  { name: "agent update", args: ["agent", "update", "test-site", "--token", "tok_SECRET12345"] },
  { name: "agent status", args: ["agent", "status", "test-site"] },
  { name: "deploy", args: ["deploy", "http://127.0.0.1:1"], savedConfig: true },
  { name: "whoami", args: ["whoami"], savedConfig: true },
];

describe("W2AGENT_API_URL is restricted to https or loopback http", () => {
  for (const apiUrl of REFUSED) {
    for (const cmd of COMMANDS) {
      it(`${cmd.name} refuses ${apiUrl}`, async () => {
        const r = await run(cmd.args, apiUrl, cmd.savedConfig);
        expect(r.requests).toEqual([]);
        expect(r.code).toBe(2);
        const text = r.stdout + r.stderr;
        expect(text).toContain("W2AGENT_API_URL");
        expect(text).not.toContain("SECRET");
        if (!cmd.savedConfig)
          expect(existsSync(join(r.home, ".w2agent", "config.json"))).toBe(false);
        if (cmd.args.includes("--json")) {
          const doc = JSON.parse(r.stdout) as { ok: boolean; error: { reason: string } };
          expect(doc.ok).toBe(false);
          expect(doc.error.reason).toBe("invalid_argument");
        } else {
          expect(r.stdout).toBe("");
        }
      });
    }
  }

  it("a userinfo value is not echoed", async () => {
    const r = await run(["agent", "status", "test-site"], "http://user:hunter2secret@evil.test");
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain("hunter2secret");
    expect(r.requests).toEqual([]);
  });

  it("an https URL with a trailing slash reaches the API with one slash", async () => {
    const r = await run(["agent", "status", "test-site"], "https://ok.example.test/");
    expect(r.requests).toEqual(["GET https://ok.example.test/api/agent/test-site"]);
  });

  it("loopback http is accepted and normalised", async () => {
    const r = await run(["agent", "status", "test-site"], "http://127.1:8787");
    expect(r.requests).toEqual(["GET http://127.0.0.1:8787/api/agent/test-site"]);
  });

  it("unset uses the hosted default", async () => {
    const r = await run(["agent", "status", "test-site"], undefined);
    expect(r.requests).toEqual(["GET https://w2agent.dev/api/agent/test-site"]);
  });
});
