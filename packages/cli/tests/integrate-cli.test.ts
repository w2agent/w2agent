import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), "w2agent-integrate-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of ["AI_AGENT", "CLAUDECODE", "CODEX_CI"]) delete env[name];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      cwd,
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function tmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `w2agent-integrate-${label}-`));
}

function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        h.update(`dir:${p}\n`);
        walk(p);
      } else {
        h.update(`file:${p}\n`);
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function projectDir(): string {
  const dir = tmp("project");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "site", version: "1.0.0" }));
  mkdirSync(join(dir, "app"));
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "llms.txt"), "stale");
  return dir;
}

describe("built CLI: integrate agent mode", () => {
  let nextSite: Server;
  let plainSite: Server;
  let nextOrigin: string;
  let plainOrigin: string;
  let nextRequests = 0;

  beforeAll(async () => {
    nextSite = createServer((req, res) => {
      nextRequests++;
      res.setHeader("content-type", "text/html");
      if (req.url === "/robots.txt" || req.url?.startsWith("/.well-known")) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end(
        `<html><head><title>Acme</title><meta name="description" content="Acme widgets"></head><body>
<script id="__NEXT_DATA__" type="application/json">{}</script>
<script src="/_next/static/chunks/main.js"></script>
<h1>Acme widgets</h1><p>We sell widgets.</p><a href="/about">About</a></body></html>`,
      );
    });
    plainSite = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><head><title>Plain</title></head><body><h1>Plain page</h1></body></html>");
    });
    await Promise.all([
      new Promise<void>((r) => nextSite.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => plainSite.listen(0, "127.0.0.1", r)),
    ]);
    nextOrigin = `http://127.0.0.1:${(nextSite.address() as { port: number }).port}`;
    plainOrigin = `http://127.0.0.1:${(plainSite.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((r) => nextSite.close(() => r())),
      new Promise<void>((r) => plainSite.close(() => r())),
    ]);
  });

  it("--dry-run --json prints one planned document and writes nothing", async () => {
    const project = projectDir();
    const cwd = tmp("cwd");
    const before = treeHash(project);
    const r = await run(
      ["integrate", nextOrigin, "--dry-run", "--json", "--project-dir", project],
      cwd,
    );
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(true);
    expect(doc.outcome).toBe("planned");
    expect(doc.platform).toBe("nextjs");
    expect(doc.changes.length).toBeGreaterThan(0);
    for (const c of doc.changes) {
      expect(["create", "modify", "skip", "manual", "delete"]).toContain(c.action);
      expect(typeof c.reason).toBe("string");
      expect(c.path.startsWith("/")).toBe(false);
    }
    expect(doc.changes.some((c: { action: string }) => c.action === "create")).toBe(true);
    expect(doc.changes).toContainEqual(
      expect.objectContaining({ action: "delete", path: "public/llms.txt" }),
    );
    expect(doc.next).toHaveLength(1);
    expect(doc.next[0]).toContain("--install");
    expect(doc.next[0]).not.toContain("--dry-run");
    expect(doc.next[0]).toContain("--json");
    expect(treeHash(project)).toBe(before);
    expect(existsSync(join(cwd, "w2agent-output"))).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("--dry-run without --install writes nothing in human mode either", async () => {
    const project = projectDir();
    const cwd = tmp("cwd");
    const before = treeHash(project);
    const r = await run(["integrate", nextOrigin, "--dry-run", "--project-dir", project], cwd);
    expect(r.code).toBe(0);
    expect(treeHash(project)).toBe(before);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("--site-url: dry run plans content with the production origin only; install writes it", async () => {
    const project = projectDir();
    const cwd = tmp("cwd");
    const common = ["--site-url", "https://acme.example", "--json", "--project-dir", project];
    const dry = await run(["integrate", nextOrigin, "--dry-run", ...common], cwd);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout).outcome).toBe("planned");
    expect(readFileSync(join(project, "public", "llms.txt"), "utf-8")).toBe("stale");

    const r = await run(["integrate", nextOrigin, "--install", ...common], cwd);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.outcome).toBe("installed");
    expect(doc.next).toEqual([["w2agent", "audit", "https://acme.example", "--json"]]);
    const installed = files(project).filter((p) => !p.endsWith("package.json"));
    expect(installed.length).toBeGreaterThan(0);
    const host = nextOrigin.replace("http://", "");
    let mentionsSite = false;
    for (const p of installed) {
      const text = readFileSync(p, "utf-8");
      expect(text, p).not.toContain(host);
      if (text.includes("acme.example")) mentionsSite = true;
    }
    expect(mentionsSite).toBe(true);
    expect(doc.warnings).toEqual([]);
  });

  it("default output-dir mode with --json lists the files and respects --site-url", async () => {
    const cwd = tmp("cwd");
    const out = join(tmp("out"), "gen");
    const r = await run(
      ["integrate", nextOrigin, "--json", "--output", out, "--site-url", "https://acme.example"],
      cwd,
    );
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.outcome).toBe("generated");
    expect(doc.platform).toBe("nextjs");
    expect(doc.outputDir).toBe(out);
    expect(doc.files.length).toBeGreaterThan(0);
    for (const f of doc.files) {
      expect(existsSync(join(out, f))).toBe(true);
      expect(readFileSync(join(out, f), "utf-8")).not.toContain(nextOrigin.replace("http://", ""));
    }
    expect(doc.next[0]).toContain("--dry-run");
  });

  it("no platform detected under --json: envelope, exit 1, nothing written even with an output dir", async () => {
    const cwd = tmp("cwd");
    const out = join(tmp("out"), "gen");
    const r = await run(["integrate", plainOrigin, "--json", "--output", out], cwd);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error.reason).toBe("no_platform_detected");
    expect(doc.error.userActionRequired).toBe(true);
    expect(doc.error.next.map((n: string[]) => n.at(-1)).sort()).toEqual(
      ["astro", "docusaurus", "nextjs", "nuxt", "shopify", "wordpress"].sort(),
    );
    for (const n of doc.error.next) expect(n.slice(-2, -1)).toEqual(["--platform"]);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("no platform detected with --dry-run in human mode writes nothing", async () => {
    const cwd = tmp("cwd");
    const out = join(tmp("out"), "gen");
    const r = await run(["integrate", plainOrigin, "--dry-run", "--output", out], cwd);
    expect(r.code).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("unknown platform: exit 2 invalid_argument before any request", async () => {
    const before = nextRequests;
    const r = await run(["integrate", nextOrigin, "--platform", "bogus", "--json"], tmp("cwd"));
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.reason).toBe("invalid_argument");
    expect(nextRequests).toBe(before);
  });

  it.each([
    [["--max-pages", "0"], "invalid_argument"],
    [["--timeout", "abc"], "invalid_argument"],
    [["--site-url", "localhost:3000"], "invalid_url"],
    [["--site-url", "ftp://acme.example"], "invalid_url"],
  ])("usage error %j: exit 2 %s before any request", async (extra, reason) => {
    const before = nextRequests;
    const r = await run(["integrate", nextOrigin, "--json", ...extra], tmp("cwd"));
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.reason).toBe(reason);
    expect(nextRequests).toBe(before);
  });

  it("invalid URL: exit 2 in both modes", async () => {
    const j = await run(["integrate", "not-a-url", "--json"], tmp("cwd"));
    expect(j.code).toBe(2);
    expect(JSON.parse(j.stdout).error.reason).toBe("invalid_url");
    const h = await run(["integrate", "not-a-url"], tmp("cwd"));
    expect(h.code).toBe(2);
    expect(h.stdout).toBe("");
    expect(h.stderr).toContain("Invalid URL");
  });

  it("--install into a missing project dir: not_a_project exit 1 before any request", async () => {
    const before = nextRequests;
    const missing = join(tmp("gone"), "nope");
    const r = await run(
      ["integrate", nextOrigin, "--install", "--json", "--project-dir", missing],
      tmp("cwd"),
    );
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.reason).toBe("not_a_project");
    expect(existsSync(missing)).toBe(false);
    expect(nextRequests).toBe(before);
  });

  it("detected JS platform with no package.json: not_a_project exit 1, nothing written", async () => {
    const empty = tmp("empty");
    const r = await run(
      ["integrate", nextOrigin, "--dry-run", "--json", "--project-dir", empty],
      tmp("cwd"),
    );
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.reason).toBe("not_a_project");
    expect(readdirSync(empty)).toEqual([]);
    const forced = await run(
      [
        "integrate",
        nextOrigin,
        "--install",
        "--platform",
        "nextjs",
        "--json",
        "--project-dir",
        empty,
      ],
      tmp("cwd"),
    );
    expect(forced.code).toBe(1);
    expect(JSON.parse(forced.stdout).error.reason).toBe("not_a_project");
    expect(readdirSync(empty)).toEqual([]);
  });

  it.each([
    ["dead port", "dead", "unreachable"],
    ["HTTP 500 homepage", "status500", "unknown_failure"],
    ["401 with www-authenticate", "status401", "auth_gated"],
  ])("empty crawl (%s): classified failure, exit 1, nothing written, in both modes", async (_n, which, reason) => {
    let origin: string;
    let closer: Server | undefined;
    if (which === "dead") {
      const dead = createServer();
      await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
      const port = (dead.address() as { port: number }).port;
      await new Promise<void>((r) => dead.close(() => r()));
      origin = `http://127.0.0.1:${port}`;
    } else {
      closer = createServer((_req, res) => {
        res.statusCode = which === "status500" ? 500 : 401;
        if (which === "status401") res.setHeader("www-authenticate", 'Basic realm="x"');
        res.end("nope");
      });
      await new Promise<void>((r) => closer?.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(closer.address() as { port: number }).port}`;
    }
    try {
      for (const mode of [["--json"], []]) {
        const cwd = tmp("cwd");
        const project = projectDir();
        const before = treeHash(project);
        const r = await run(
          [
            "integrate",
            origin,
            "--install",
            "--platform",
            "nextjs",
            "--project-dir",
            project,
            "--timeout",
            "3000",
            ...mode,
          ],
          cwd,
        );
        expect(r.code).toBe(1);
        expect(readdirSync(cwd)).toEqual([]);
        expect(treeHash(project)).toBe(before);
        if (mode.length > 0) {
          const doc = JSON.parse(r.stdout);
          expect(doc.ok).toBe(false);
          expect(doc.error.reason).toBe(reason);
        } else {
          expect(r.stdout).toBe("");
          expect(r.stderr.length).toBeGreaterThan(0);
        }
      }
    } finally {
      if (closer) await new Promise<void>((r) => closer?.close(() => r()));
    }
  });

  it("an empty --platform value is a usage error before any request", async () => {
    const before = nextRequests;
    const r = await run(["integrate", nextOrigin, "--platform=", "--json"], tmp("cwd"));
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.reason).toBe("invalid_argument");
    expect(nextRequests).toBe(before);
  });

  it("--site-url with credentials is rejected without echoing them", async () => {
    const before = nextRequests;
    const r = await run(
      ["integrate", nextOrigin, "--site-url", "https://user:hunter2@acme.example", "--json"],
      tmp("cwd"),
    );
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.reason).toBe("invalid_url");
    expect(r.stdout).not.toContain("hunter2");
    expect(nextRequests).toBe(before);
  });

  it("a page with no title leaves no crawl hostname in installed files", async () => {
    const bare = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url !== "/") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end(
        '<html><body><script id="__NEXT_DATA__" type="application/json">{}</script><p>We sell widgets.</p></body></html>',
      );
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(bare.address() as { port: number }).port}`;
    try {
      const project = projectDir();
      const r = await run(
        [
          "integrate",
          origin,
          "--install",
          "--json",
          "--site-url",
          "https://acme.example",
          "--project-dir",
          project,
        ],
        tmp("cwd"),
      );
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.outcome).toBe("installed");
      expect(doc.warnings).toEqual([]);
      let sawHeading = false;
      for (const p of files(project).filter((f) => !f.endsWith("package.json"))) {
        const text = readFileSync(p, "utf-8");
        expect(text, p).not.toContain("127.0.0.1");
        if (/^# acme\.example$/m.test(text)) sawHeading = true;
      }
      expect(sawHeading).toBe(true);
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });

  it("the human tip keeps --site-url", async () => {
    const out = join(tmp("out"), "gen");
    const r = await run(
      ["integrate", nextOrigin, "--output", out, "--site-url", "https://acme.example"],
      tmp("cwd"),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--site-url https://acme.example --install");
  });
});
