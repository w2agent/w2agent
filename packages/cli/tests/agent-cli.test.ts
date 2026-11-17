import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")) as {
  version: string;
};

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  home?: string;
  pty?: boolean;
  timeout?: number;
}

function run(
  args: string[],
  env: Record<string, string | undefined> = {},
  options: RunOptions = {},
): Promise<Run> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "w2agent-cli-test-"));
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of ["AI_AGENT", "CLAUDECODE", "CODEX_CI"]) delete childEnv[name];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  let file = process.execPath;
  let argv = [CLI, ...args];
  if (options.pty) {
    // A pty makes the child's stdin a TTY. An empty PATH means a broken
    // fail-fast check cannot launch a real browser.
    childEnv.PATH = mkdtempSync(join(tmpdir(), "w2agent-cli-path-"));
    file = "/usr/bin/script";
    argv =
      process.platform === "darwin"
        ? ["-q", "/dev/null", process.execPath, ...argv]
        : ["-qec", [process.execPath, ...argv].map((a) => `'${a}'`).join(" "), "/dev/null"];
  }
  return spawnCapture(file, argv, childEnv, options.timeout ?? 100_000);
}

// stdin is /dev/null (not a pipe) because `script` needs a real file to wrap.
function spawnCapture(
  file: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(file, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseEnvelope(stdout: string) {
  return JSON.parse(stdout) as {
    ok: boolean;
    error: { reason: string; message: string; userActionRequired: boolean; next: string[][] };
  };
}

async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function normalise(text: string): unknown {
  const doc = JSON.parse(text) as Record<string, unknown>;
  delete doc.timestamp;
  delete doc.duration;
  const scrub = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(scrub);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [
          k,
          (k === "message" || k === "details") && typeof v === "string"
            ? v.replace(/(?<=: )\d+ms/g, "Nms")
            : scrub(v),
        ]),
      );
    }
    return node;
  };
  return scrub(doc);
}

function jsonFrom(output: string): unknown {
  return JSON.parse(output.slice(output.indexOf("{")));
}

describe("built CLI agent mode", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><head><title>T</title></head><body><h1>Hi</h1></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("invalid URL with --json: exit 2 and a parseable invalid_url envelope", async () => {
    const r = await run(["audit", "not-a-url", "--json"]);
    expect(r.code).toBe(2);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error.reason).toBe("invalid_url");
    expect(env.error.next).toEqual([]);
  });

  it("invalid URL without --json: exit 2, human message on stderr, empty stdout", async () => {
    const r = await run(["audit", "not-a-url"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Invalid URL");
  });

  it("unknown option with --json: exit 2 and an invalid_argument envelope", async () => {
    const r = await run(["audit", "example.com", "--bogus", "--json"]);
    expect(r.code).toBe(2);
    expect(parseEnvelope(r.stdout).error.reason).toBe("invalid_argument");
  });

  it("unknown option without --json: exit 2 and nothing on stdout", async () => {
    const r = await run(["audit", "example.com", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });

  it("missing argument with --json: exit 2 envelope", async () => {
    const r = await run(["audit", "--json"]);
    expect(r.code).toBe(2);
    expect(parseEnvelope(r.stdout).error.reason).toBe("invalid_argument");
  });

  it.each([
    ["--category", "nope"],
    ["--format", "xml"],
    ["--depth", "0"],
    ["--timeout", "abc"],
    ["--threshold", "-3"],
  ])("bad %s value exits 2 before any network call", async (flag, value) => {
    const r = await run(["audit", `http://127.0.0.1:${await closedPort()}`, flag, value, "--json"]);
    expect(r.code).toBe(2);
    expect(parseEnvelope(r.stdout).error.reason).toBe("invalid_argument");
  });

  it("--help and --version exit 0", async () => {
    const v = await run(["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toBe(pkg.version);
    const h = await run(["audit", "--help", "--json"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("Usage:");
  });

  it("unreachable host with --json: exit 1, audit-kind reason, stdout is one document", async () => {
    const port = await closedPort();
    const r = await run([
      "audit",
      `http://127.0.0.1:${port}`,
      "--json",
      "--timeout",
      "2000",
      "-d",
      "3",
    ]);
    expect(r.code).toBe(1);
    const env = parseEnvelope(r.stdout);
    expect(env.ok).toBe(false);
    expect([
      "unreachable",
      "blocked",
      "auth_gated",
      "rate_limited",
      "timeout",
      "unknown_failure",
    ]).toContain(env.error.reason);
  }, 120_000);

  it("success with --json prints the same document as -f json", async () => {
    const args = ["-d", "3", "--timeout", "5000"];
    const [j, f] = await Promise.all([
      run(["audit", origin, "--json", ...args]),
      run(["audit", origin, "-f", "json", ...args]),
    ]);
    expect(j.code).toBe(0);
    expect(f.code).toBe(0);
    const doc = JSON.parse(j.stdout) as { overallScore: number; url: string };
    expect(doc.url).toBe(origin);
    expect(typeof doc.overallScore).toBe("number");
    expect(normalise(j.stdout)).toEqual(normalise(f.stdout));
  }, 120_000);

  it("--json -f terminal still prints JSON; -o writes the file and notes it on stderr", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "w2agent-cli-out-")), "report.json");
    const r = await run(["audit", origin, "--json", "-f", "terminal", "-o", out, "-d", "3"]);
    expect(r.code).toBe(0);
    expect(normalise(r.stdout)).toEqual(normalise(readFileSync(out, "utf-8")));
    expect(r.stderr).toContain("Report written");
    expect(r.stdout).not.toContain("Report written");
  }, 120_000);

  it("--json --ci below threshold prints only the below_threshold envelope and exits 1", async () => {
    const r = await run(["audit", origin, "--json", "--ci", "--threshold", "100", "-d", "3"]);
    expect(r.code).toBe(1);
    const env = parseEnvelope(r.stdout);
    expect(env.error.reason).toBe("below_threshold");
    expect(env.error.message).toMatch(/\d+.*100/);
  }, 120_000);

  it("schema lists audit --json and the package version", async () => {
    const r = await run(["schema"]);
    expect(r.code).toBe(0);
    const schema = JSON.parse(r.stdout) as {
      name: string;
      version: string;
      commands: { name: string; options: { long: string; repeatable?: boolean }[] }[];
    };
    expect(schema.version).toBe(pkg.version);
    const audit = schema.commands.find((c) => c.name === "audit");
    expect(audit?.options.map((o) => o.long)).toContain("--json");
    expect(audit?.options.find((o) => o.long === "--allow-host")?.repeatable).toBe(true);
    expect(schema.commands.map((c) => c.name)).toContain("schema");
  });

  it("the pty harness gives the child a TTY stdin", async () => {
    const probe = "process.stdout.write(String(Boolean(process.stdin.isTTY)))";
    const argv =
      process.platform === "darwin"
        ? ["-q", "/dev/null", process.execPath, "-e", probe]
        : ["-qec", `'${process.execPath}' -e '${probe}'`, "/dev/null"];
    const { stdout: r } = await spawnCapture("/usr/bin/script", argv, process.env, 15_000);
    expect(r).toContain("true");
  });

  const failFast = (env2: unknown) => {
    const doc = env2 as {
      error: { reason: string; userActionRequired: boolean; next: string[][] };
    };
    expect(doc.error.reason).toBe("auth_required");
    expect(doc.error.userActionRequired).toBe(true);
    expect(doc.error.next).toEqual([["w2agent", "login", "--api-key", "<api-key>"]]);
  };

  it("login --json fails fast with auth_required on a non-TTY stdin", async () => {
    const started = Date.now();
    const r = await run(["login", "--json"]);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(r.code).toBe(1);
    failFast(JSON.parse(r.stdout));
    expect(r.stderr).not.toContain("Opening");
  });

  it.each([
    ["CLAUDECODE", { CLAUDECODE: "1" }],
    ["AI_AGENT", { AI_AGENT: "x" }],
    ["CODEX_CI", { CODEX_CI: "1" }],
  ])(
    "login --json fails fast under %s even with a TTY stdin",
    async (_label, env) => {
      const r = await run(["login", "--json"], env, { pty: true, timeout: 15_000 });
      expect(r.code).toBe(1);
      failFast(jsonFrom(r.stdout));
    },
    30_000,
  );

  it("existing credentials with --force under an agent env fails fast", async () => {
    const home = mkdtempSync(join(tmpdir(), "w2agent-cli-test-"));
    mkdirSync(join(home, ".w2agent"));
    writeFileSync(join(home, ".w2agent", "config.json"), JSON.stringify({ token: "w2a_existing" }));
    const r = await run(
      ["login", "--force", "--json"],
      { CLAUDECODE: "1" },
      {
        home,
        pty: true,
        timeout: 15_000,
      },
    );
    expect(r.code).toBe(1);
    failFast(jsonFrom(r.stdout));
  }, 30_000);

  it("login --api-key --json (key swallowed the flag) still prints an envelope", async () => {
    const r = await run(["login", "--api-key", "--json"]);
    expect(r.code).toBe(2);
    expect(parseEnvelope(r.stdout).error.reason).toBe("invalid_argument");
  });

  it("does not echo a secret from an unknown option into the envelope", async () => {
    const r = await run(["login", "--apikey=w2a_SECRET123", "--json"]);
    expect(r.code).toBe(2);
    expect(r.stdout).not.toContain("w2a_SECRET123");
    expect(parseEnvelope(r.stdout).error.reason).toBe("invalid_argument");
  });

  it("audit --threshold 0 is accepted", async () => {
    const r = await run(["audit", origin, "--json", "--ci", "--threshold", "0", "-d", "3"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { url: string }).url).toBe(origin);
  }, 120_000);

  it("schema recurses into subcommands and accepts --json", async () => {
    const r = await run(["schema", "--json"]);
    expect(r.code).toBe(0);
    const schema = JSON.parse(r.stdout) as {
      commands: { name: string; commands?: { name: string; options: unknown[] }[] }[];
    };
    const agent = schema.commands.find((c) => c.name === "agent");
    expect(agent?.commands?.map((c) => c.name).sort()).toEqual(["deploy", "status", "update"]);
  });

  it("login without --json fails fast with a human message on stderr", async () => {
    const r = await run(["login"], { CLAUDECODE: "1" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--api-key");
  });

  it("login --api-key stays on the key path even under an agent env", async () => {
    const r = await run(["login", "--api-key", "w2a_testkey", "--json"], { CLAUDECODE: "1" });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, outcome: "authenticated" });
  });
});
