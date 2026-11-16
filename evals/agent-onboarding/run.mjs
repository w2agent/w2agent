#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const SCRUB_EXACT = [
  "CLAUDECODE",
  "AI_AGENT",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_ENV_FILE",
  "CLAUDE_PLUGIN_DATA",
];
const SCRUB_PREFIXES = ["CLAUDE_CODE_SESSION_", "CLAUDE_CODE_MESSAGING_", "CODEX_COMPANION_"];

const USAGE = `Usage: node run.mjs --harness claude|codex --arm tool|docs-only [options]
  --fixture <name>     fixture under fixtures/ (default next-static)
  --w2agent <path>     w2agent checkout to export (default: this repo)
  --ref <rev>          revision to export (default HEAD)
  --out <dir>          output dir (default: fresh dir under the OS tmpdir)
  --model <id>         model id (omitted from argv when absent)
  --timeout <minutes>  kill the harness after this long (default 20)
  --dry-run            build the workspace and print argv/env, do not spawn`;

export function parseArgs(argv) {
  const opts = {
    harness: undefined,
    fixture: "next-static",
    arm: undefined,
    w2agent: REPO_ROOT,
    ref: "HEAD",
    out: undefined,
    model: undefined,
    timeout: 20,
    dryRun: false,
  };
  const valueFlags = {
    "--harness": "harness",
    "--fixture": "fixture",
    "--arm": "arm",
    "--w2agent": "w2agent",
    "--ref": "ref",
    "--out": "out",
    "--model": "model",
    "--timeout": "timeout",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a in valueFlags) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      opts[valueFlags[a]] = v;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!["claude", "codex"].includes(opts.harness))
    throw new Error("--harness must be claude or codex");
  if (!["tool", "docs-only"].includes(opts.arm)) throw new Error("--arm must be tool or docs-only");
  if (!/^[A-Za-z0-9._-]+$/.test(opts.fixture)) throw new Error("--fixture must be a plain name");
  const t = Number(opts.timeout);
  if (!Number.isFinite(t) || t <= 0)
    throw new Error("--timeout must be a positive number of minutes");
  opts.timeout = t;
  return opts;
}

export function scrubEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (SCRUB_EXACT.includes(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p))) delete out[k];
  }
  return out;
}

export function buildChildEnv(env, cacheDir) {
  return {
    ...scrubEnv(env),
    npm_config_cache: path.join(cacheDir, "npm"),
    npm_config_store_dir: path.join(cacheDir, "pnpm-store"),
    XDG_CACHE_HOME: path.join(cacheDir, "xdg"),
    COREPACK_HOME: path.join(cacheDir, "corepack"),
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

export function buildHarnessArgv(harness, prompt, model) {
  if (harness === "claude") {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
    ];
    if (model) args.push("--model", model);
    return { cmd: "claude", args };
  }
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "-s",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
  ];
  if (model) args.push("-m", model);
  args.push(prompt);
  return { cmd: "codex", args };
}

export function exportArgs(ref) {
  return ["archive", "--format=tar", ref, "--", ".", ":(exclude)evals"];
}

export function envDiff(base, child) {
  const added = {};
  const removed = [];
  for (const k of Object.keys(child)) if (base[k] !== child[k]) added[k] = child[k];
  for (const k of Object.keys(base)) if (!(k in child)) removed.push(k);
  return { added, removed };
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.error}`);
  return r.stdout.trim();
}

// Refuses an --out that already holds files, or sits inside any git work tree
// (agents load AGENTS.md/CLAUDE.md from parent repos and could read the scorer).
export function assertFreshOut(out) {
  if (existsSync(out) && readdirSync(out).length > 0)
    throw new Error(`--out ${out} exists and is not empty`);
  let probe = out;
  while (!existsSync(probe)) probe = path.dirname(probe);
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: probe,
    encoding: "utf8",
  });
  if (r.status === 0 && r.stdout.trim() === "true")
    throw new Error(`--out ${out} is inside a git work tree; use a directory outside any repo`);
}

// Resolves when the child exits, not when its pipes close: a grandchild in another
// process group can hold them open forever. Kills the group, gives the pipes a short
// grace to drain, then destroys them.
export async function waitForExit(child, graceMs = 2000) {
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  const ended = (st) =>
    new Promise((r) => {
      if (!st || st.destroyed || st.readableEnded) return r();
      st.once("end", r);
      st.once("close", r);
    });
  let timer;
  await Promise.race([
    Promise.all([ended(child.stdout), ended(child.stderr)]),
    new Promise((r) => {
      timer = setTimeout(r, graceMs);
    }),
  ]);
  clearTimeout(timer);
  child.stdout?.destroy();
  child.stderr?.destroy();
  return result;
}

function exportW2agent(checkout, ref, dest) {
  mkdirSync(dest, { recursive: true });
  const archive = spawn("git", exportArgs(ref), {
    cwd: checkout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tar = spawn("tar", ["-x", "-C", dest], { stdio: ["pipe", "inherit", "pipe"] });
  archive.stdout.pipe(tar.stdin);
  let err = "";
  archive.stderr.on("data", (d) => {
    err += d;
  });
  tar.stderr.on("data", (d) => {
    err += d;
  });
  return new Promise((resolve, reject) => {
    const codes = {};
    const done = (name) => (code) => {
      codes[name] = code;
      if ("archive" in codes && "tar" in codes) {
        if (codes.archive === 0 && codes.tar === 0) resolve();
        else reject(new Error(`export failed (git ${codes.archive}, tar ${codes.tar}): ${err}`));
      }
    };
    archive.on("close", done("archive"));
    tar.on("close", done("tar"));
    archive.on("error", reject);
    tar.on("error", reject);
  });
}

const FIXTURE_SKIP = new Set(["node_modules", ".next", "next-env.d.ts"]);
function copyFixture(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => !FIXTURE_SKIP.has(path.basename(p)),
  });
}

function versionOf(cmd) {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function main(argv = process.argv.slice(2)) {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) throw new Error(`Node >= 22 required (running ${process.version})`);

  const opts = parseArgs(argv);
  const fixtureSrc = path.join(HERE, "fixtures", opts.fixture);
  const promptFile = path.join(HERE, "prompts", `${opts.arm}.md`);
  const prompt = readFileSync(promptFile, "utf8").trim();
  const checkout = path.resolve(opts.w2agent);
  const sha = run("git", ["rev-parse", "--verify", `${opts.ref}^{commit}`], { cwd: checkout });

  const out = path.resolve(opts.out ?? mkdtempSync(path.join(tmpdir(), "w2agent-onboarding-")));
  assertFreshOut(out);
  const workspace = path.join(out, "workspace");
  const cache = path.join(workspace, ".cache");
  mkdirSync(cache, { recursive: true });
  copyFixture(fixtureSrc, path.join(workspace, "site"));
  await exportW2agent(checkout, sha, path.join(workspace, "w2agent"));

  const env = buildChildEnv(process.env, cache);
  const { cmd, args } = buildHarnessArgv(opts.harness, prompt, opts.model);

  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        { cwd: workspace, cmd, args, env: envDiff(process.env, env), w2agentRef: sha },
        null,
        2,
      ),
    );
    console.log(out);
    return out;
  }

  const startedAt = new Date();
  const transcript = createWriteStream(path.join(out, "transcript.jsonl"));
  const stderrLog = createWriteStream(path.join(out, "stderr.log"));
  const child = spawn(cmd, args, {
    cwd: workspace,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(transcript);
  child.stderr.pipe(stderrLog);

  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  let timedOut = false;
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), 10_000);
  }, opts.timeout * 60_000);
  const onSignal = (sig) => {
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
    process.once(sig, () => process.exit(1));
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  const exited = await waitForExit(child);
  if (exited.error) stderrLog.write(`spawn error: ${exited.error.message}\n`);
  const exitCode = exited.code;
  const signal = exited.signal;
  clearTimeout(timer);
  clearTimeout(killTimer);
  await Promise.all([new Promise((r) => transcript.end(r)), new Promise((r) => stderrLog.end(r))]);

  const endedAt = new Date();
  writeFileSync(
    path.join(out, "run.json"),
    `${JSON.stringify(
      {
        harness: opts.harness,
        harnessVersion: versionOf(opts.harness),
        model: opts.model ?? null,
        arm: opts.arm,
        fixture: opts.fixture,
        w2agentRef: sha,
        promptSha256: createHash("sha256").update(prompt).digest("hex"),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        wallMs: endedAt - startedAt,
        exitCode,
        signal,
        timedOut,
        workspace,
      },
      null,
      2,
    )}\n`,
  );
  console.log(out);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  });
}
