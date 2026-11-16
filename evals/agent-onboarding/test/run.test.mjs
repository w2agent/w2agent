import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildChildEnv, buildHarnessArgv, exportArgs, parseArgs, scrubEnv } from "../run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("scrubEnv drops agent-session vars and keeps config dirs", () => {
  const env = scrubEnv({
    CLAUDECODE: "1",
    AI_AGENT: "x",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SESSION_ID: "s",
    CLAUDE_CODE_MESSAGING_SOCKET: "m",
    CODEX_COMPANION_STATE: "c",
    CLAUDE_CONFIG_DIR: "/cfg",
    CODEX_HOME: "/codex",
    PATH: "/bin",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PATH"]);
});

test("buildChildEnv points caches under the cache dir", () => {
  const env = buildChildEnv({ CLAUDECODE: "1", PATH: "/bin" }, "/ws/.cache");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.npm_config_cache, "/ws/.cache/npm");
  assert.equal(env.npm_config_store_dir, "/ws/.cache/pnpm-store");
  assert.equal(env.XDG_CACHE_HOME, "/ws/.cache/xdg");
  assert.equal(env.COREPACK_HOME, "/ws/.cache/corepack");
  assert.equal(env.NEXT_TELEMETRY_DISABLED, "1");
});

test("buildHarnessArgv omits the model flag when no model is given", () => {
  for (const h of ["claude", "codex"]) {
    const { args } = buildHarnessArgv(h, "P", undefined);
    assert.ok(!args.includes("--model") && !args.includes("-m"), h);
  }
  assert.deepEqual(buildHarnessArgv("claude", "P", "M").args.slice(-2), ["--model", "M"]);
  const codex = buildHarnessArgv("codex", "P", "M").args;
  assert.deepEqual(codex.slice(-3), ["-m", "M", "P"]);
});

test("buildHarnessArgv shapes", () => {
  const c = buildHarnessArgv("claude", "P");
  assert.equal(c.cmd, "claude");
  assert.deepEqual(c.args.slice(0, 2), ["-p", "P"]);
  assert.ok(c.args.includes("bypassPermissions") && c.args.includes("--no-session-persistence"));
  const x = buildHarnessArgv("codex", "P");
  assert.equal(x.cmd, "codex");
  assert.equal(x.args.at(-1), "P");
  assert.ok(x.args.includes("sandbox_workspace_write.network_access=true"));
});

test("exportArgs excludes evals", () => {
  const a = exportArgs("abc");
  assert.equal(a[0], "archive");
  assert.ok(a.includes("abc"));
  assert.ok(a.includes(":(exclude)evals"));
});

test("parseArgs defaults, requirements, errors", () => {
  const o = parseArgs(["--harness", "claude", "--arm", "tool"]);
  assert.equal(o.fixture, "next-static");
  assert.equal(o.ref, "HEAD");
  assert.equal(o.timeout, 20);
  assert.equal(o.model, undefined);
  assert.throws(() => parseArgs(["--arm", "tool"]));
  assert.throws(() => parseArgs(["--harness", "claude"]));
  assert.throws(() => parseArgs(["--harness", "claude", "--arm", "tool", "--bogus"]));
  assert.throws(() => parseArgs(["--harness", "claude", "--arm", "tool", "--timeout", "0"]));
});

test("dry-run builds a workspace without evals/ and with the fixture site", () => {
  const out = mkdtempSync(path.join(tmpdir(), "w2agent-eval-test-"));
  const r = spawnSync(
    process.execPath,
    [
      path.join(HERE, "..", "run.mjs"),
      "--harness",
      "codex",
      "--arm",
      "docs-only",
      "--ref",
      "HEAD",
      "--out",
      out,
      "--dry-run",
    ],
    { encoding: "utf8", env: { ...process.env, CLAUDECODE: "1" } },
  );
  assert.equal(r.status, 0, r.stderr);
  const ws = path.join(out, "workspace");
  assert.ok(existsSync(path.join(ws, "w2agent", "package.json")));
  assert.ok(!existsSync(path.join(ws, "w2agent", "evals")));
  assert.ok(existsSync(path.join(ws, "site", "app", "page.tsx")));
  assert.ok(!existsSync(path.join(out, "baseline")));
  assert.equal(
    readFileSync(path.join(ws, "site", "package.json"), "utf8"),
    readFileSync(path.join(HERE, "..", "fixtures", "next-static", "package.json"), "utf8"),
  );
  assert.ok(!r.stdout.includes('"CLAUDE_CONFIG_DIR": null'));
  assert.ok(r.stdout.includes("CLAUDECODE"), "env diff lists the removed var");
});

test("export from a checkout that tracks evals/ leaves evals/ out and ignores untracked files", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "w2agent-eval-repo-"));
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  mkdirSync(path.join(repo, "evals", "x"), { recursive: true });
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "evals", "x", "secret.txt"), "a");
  writeFileSync(path.join(repo, "src", "a.txt"), "a");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  writeFileSync(path.join(repo, "src", "untracked.txt"), "u");
  const out = mkdtempSync(path.join(tmpdir(), "w2agent-eval-test-"));
  const r = spawnSync(
    process.execPath,
    [
      path.join(HERE, "..", "run.mjs"),
      "--harness",
      "claude",
      "--arm",
      "tool",
      "--w2agent",
      repo,
      "--out",
      out,
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const exp = path.join(out, "workspace", "w2agent");
  assert.ok(existsSync(path.join(exp, "src", "a.txt")));
  assert.ok(!existsSync(path.join(exp, "evals")));
  assert.ok(!existsSync(path.join(exp, "src", "untracked.txt")));
});

const dry = (out, extra = []) =>
  spawnSync(
    process.execPath,
    [
      path.join(HERE, "..", "run.mjs"),
      "--harness",
      "claude",
      "--arm",
      "tool",
      "--out",
      out,
      "--dry-run",
      ...extra,
    ],
    { encoding: "utf8" },
  );

test("run refuses an --out that is non-empty", () => {
  const out = mkdtempSync(path.join(tmpdir(), "w2agent-eval-test-"));
  writeFileSync(path.join(out, "old.txt"), "x");
  const r = dry(out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not empty/);
});

test("run refuses an --out inside a git work tree, even one that does not exist yet", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "w2agent-eval-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const r = dry(path.join(repo, "a", "b"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /git work tree/);
  assert.ok(!existsSync(path.join(repo, "a")));
});

test("waitForExit resolves on exit when a grandchild in another group holds the pipe", {
  timeout: 20000,
}, async () => {
  const { waitForExit } = await import("../run.mjs");
  const gc =
    'const {spawn}=require("node:child_process");const g=spawn("sleep",["30"],{detached:true,stdio:["ignore","inherit","inherit"]});console.log(g.pid);g.unref();';
  const child = spawn(process.execPath, ["-e", gc], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
  });
  const t0 = Date.now();
  try {
    const r = await waitForExit(child, 500);
    assert.equal(r.code, 0);
    assert.ok(Date.now() - t0 < 8000);
  } finally {
    const gpid = Number(out.trim());
    if (gpid > 0) {
      try {
        process.kill(gpid, "SIGKILL");
      } catch {}
    }
  }
});
