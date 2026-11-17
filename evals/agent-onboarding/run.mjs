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
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import * as credentialsMod from "./credentials.mjs";
import { redact } from "./credentials.mjs";
import * as sandboxMod from "./sandbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const MOUNT_PATH = "/work";
const GUEST_HOME = "/home/node";
const GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const VOLUME_BYTES = 8 * 1024 ** 3;
const OUTPUT_CAP = 50 * 1024 * 1024;
const MARGIN_MS = 30 * 60_000;

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
  --timeout <minutes>  stop the harness after this long (default 20)
  --claude-credentials <file>  Claude login JSON (default: Keychain or ~/.claude)
  --codex-auth <file>  Codex auth.json (default: $CODEX_HOME or ~/.codex)
  --dry-run            build the workspace and print the sandbox plan, start nothing
  --cleanup            delete every leftover w2a-eval-* VM and volume (no other flags)`;

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
    cleanup: false,
    claudeCredentials: undefined,
    codexAuth: undefined,
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
    "--claude-credentials": "claudeCredentials",
    "--codex-auth": "codexAuth",
  };
  if (argv.includes("--cleanup")) {
    if (argv.length !== 1) throw new Error("--cleanup takes no other flags");
    opts.cleanup = true;
    return opts;
  }
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

export function buildGuestEnv(cacheDir) {
  return {
    HOME: GUEST_HOME,
    PATH: GUEST_PATH,
    LANG: "C.UTF-8",
    npm_config_cache: `${cacheDir}/npm`,
    npm_config_store_dir: `${cacheDir}/pnpm-store`,
    XDG_CACHE_HOME: `${cacheDir}/xdg`,
    COREPACK_HOME: `${cacheDir}/corepack`,
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
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (model) args.push("-m", model);
  args.push(prompt);
  return { cmd: "codex", args };
}

export function exportArgs(ref) {
  return ["archive", "--format=tar", ref, "--", ".", ":(exclude)evals"];
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

export function redactingSink(file, secrets, maxBytes, onOverflow, onError) {
  const stream = createWriteStream(file, { mode: 0o600 });
  let failure;
  stream.on("error", (e) => {
    if (failure) return;
    failure = e;
    onError?.(e);
  });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let bytes = 0;
  let count = 0;
  let truncated = false;
  const emit = (text) => {
    const r = redact(text, secrets);
    count += r.count;
    if (!failure) stream.write(r.text);
  };
  return {
    write(chunk) {
      if (truncated || failure) return;
      let buf = chunk;
      if (bytes + buf.length > maxBytes) {
        buf = buf.subarray(0, maxBytes - bytes);
        truncated = true;
      }
      bytes += buf.length;
      pending += decoder.write(buf);
      const i = pending.lastIndexOf("\n");
      if (i >= 0) {
        emit(pending.slice(0, i + 1));
        pending = pending.slice(i + 1);
      }
      if (truncated) {
        pending = "";
        onOverflow();
      }
    },
    async end() {
      if (!truncated) {
        pending += decoder.end();
        if (pending) emit(pending);
      }
      await new Promise((r) => {
        if (failure) return r();
        stream.end(r);
      });
      return { count, truncated, error: failure };
    },
  };
}

const CREDENTIAL_TARGET = {
  claude: { dir: `${GUEST_HOME}/.claude`, file: ".credentials.json" },
  codex: { dir: `${GUEST_HOME}/.codex`, file: "auth.json" },
};

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) throw new Error(`Node >= 22 required (running ${process.version})`);

  const opts = parseArgs(argv);
  const sb = { ...sandboxMod, ...deps.sandbox };
  const cred = { ...credentialsMod, ...deps.credentials };
  const env = deps.env ?? process.env;
  const spawner = deps.spawner ?? spawn;

  if (opts.cleanup) {
    const { deleted, failed } = sb.sweep();
    console.log(JSON.stringify({ deleted, failed }, null, 2));
    if (failed.length) throw new Error(`failed to delete: ${failed.join(", ")}`);
    return undefined;
  }

  const fixtureSrc = path.join(HERE, "fixtures", opts.fixture);
  const promptFile = path.join(HERE, "prompts", `${opts.arm}.md`);
  const prompt = readFileSync(promptFile, "utf8").trim();
  const checkout = path.resolve(opts.w2agent);
  const sha = run("git", ["rev-parse", "--verify", `${opts.ref}^{commit}`], { cwd: checkout });

  const out = path.resolve(opts.out ?? mkdtempSync(path.join(tmpdir(), "w2agent-onboarding-")));
  assertFreshOut(out);
  const workspace = path.join(out, "workspace");
  mkdirSync(path.join(workspace, ".cache"), { recursive: true });
  copyFixture(fixtureSrc, path.join(workspace, "site"));
  await exportW2agent(checkout, sha, path.join(workspace, "w2agent"));

  const guestWs = `${MOUNT_PATH}/workspace`;
  const guestEnv = buildGuestEnv(`${guestWs}/.cache`);
  const { cmd, args } = buildHarnessArgv(opts.harness, prompt, opts.model);
  const execOpts = { user: "node", cwd: guestWs, env: guestEnv };

  if (opts.dryRun) {
    const names = {
      vm: sb.resourceName("<runid>", "agent"),
      volume: sb.resourceName("<runid>", "work"),
    };
    const image = sb.imageTag(readFileSync(sb.DOCKERFILE), {});
    const startArgs = sb.startArgv({
      name: names.vm,
      image,
      volume: names.volume,
      mountPath: MOUNT_PATH,
    });
    console.log(
      JSON.stringify(
        {
          image,
          ...names,
          mountPath: MOUNT_PATH,
          volumeCreate: sb.volumeCreateArgv(names.volume, VOLUME_BYTES),
          vmArgv: startArgs,
          guestEnv,
          harnessArgv: sb.execArgv(names.vm, [cmd, ...args], execOpts),
          credentials: `${opts.harness} login staged into the guest HOME at run time (not read in dry-run)`,
          w2agentRef: sha,
        },
        null,
        2,
      ),
    );
    console.log(out);
    return out;
  }

  const { tag } = sb.ensureImage({});
  const id = sb.runId();
  const vm = sb.resourceName(id, "agent");
  const volume = sb.resourceName(id, "work");
  const sandbox = { image: tag, vm, volume, mountPath: MOUNT_PATH };
  const base = {
    harness: opts.harness,
    model: opts.model ?? null,
    arm: opts.arm,
    fixture: opts.fixture,
    w2agentRef: sha,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    workspace: guestWs,
    sandbox,
  };
  const startedAt = new Date();
  const writeRun = (o) =>
    writeFileSync(path.join(out, "run.json"), `${JSON.stringify(o, null, 2)}\n`);
  writeRun({ ...base, startedAt: startedAt.toISOString(), status: "starting" });

  let vmUp = false;
  let volumeUp = false;
  let harnessStarted = false;
  let secrets = [];
  let child;
  let sinkError;
  let finalized = false;
  const leaked = [];
  const dropVm = () => {
    if (!vmUp) return;
    vmUp = false;
    try {
      sb.deleteVm(vm);
    } catch {
      leaked.push(vm);
    }
  };
  const dropVolume = () => {
    if (!volumeUp) return;
    volumeUp = false;
    try {
      sb.deleteVolume(volume);
    } catch {
      leaked.push(volume);
    }
  };
  const stop = () => {
    try {
      child?.kill("SIGKILL");
    } catch {}
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    dropVm();
  };
  const reportLeaks = () => {
    if (leaked.length)
      console.error(
        `FAILED TO DELETE sandbox resources, run \`run.mjs --cleanup\`: ${leaked.join(", ")}`,
      );
  };
  const exit = deps.exit ?? process.exit;
  let interrupted = null;
  const onSignal = (sig) => {
    if (interrupted) exit(1);
    interrupted = sig;
    stop();
    if (!harnessStarted) {
      dropVolume();
      finalized = true;
      writeRun({
        ...base,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        status: "interrupted",
        interrupted: sig,
        ...(leaked.length ? { leaked } : {}),
      });
      reportLeaks();
      exit(130);
    }
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let finalRun;
  let error;
  try {
    volumeUp = true;
    sb.createVolume(volume, VOLUME_BYTES);
    vmUp = true;
    sb.startVm({ name: vm, image: tag, volume, mountPath: MOUNT_PATH });
    const inVm = (user, argv2) => {
      const r = sb.execIn(vm, argv2, { user });
      if (r.status !== 0)
        throw new Error(
          `${argv2[0]} in the sandbox exited ${r.status}: ${String(r.stderr ?? "")
            .trim()
            .slice(0, 300)}`,
        );
    };
    inVm("root", ["chmod", "0777", MOUNT_PATH]);
    inVm("node", ["mkdir", "-p", guestWs]);
    await sb.copyIn(vm, workspace, guestWs, { user: "node" });

    const minValidMs = opts.timeout * 60_000 + MARGIN_MS;
    const staged =
      opts.harness === "claude"
        ? cred.stageClaude(cred.readClaudeLogin({ file: opts.claudeCredentials, env }), {
            minValidMs,
          })
        : cred.stageCodex(cred.readCodexAuth({ file: opts.codexAuth, env }), { minValidMs });
    secrets = cred.secretValues(staged);
    const target = CREDENTIAL_TARGET[opts.harness];
    sb.execWithStdin(
      vm,
      [
        "sh",
        "-c",
        `umask 077 && mkdir -p ${target.dir} && cat > ${target.dir}/${target.file} && chmod 600 ${target.dir}/${target.file}`,
      ],
      JSON.stringify(staged),
      { user: "node" },
    );

    const ver = sb.execIn(vm, [cmd, "--version"], { user: "node", env: guestEnv });
    const harnessVersion = ver.status === 0 ? String(ver.stdout ?? "").trim() || null : null;

    harnessStarted = true;
    let timedOut = false;
    const sinkFailed = (e) => {
      sinkError ??= e;
      stop();
    };
    const outSink = redactingSink(
      path.join(out, "transcript.jsonl"),
      secrets,
      OUTPUT_CAP,
      stop,
      sinkFailed,
    );
    const errSink = redactingSink(
      path.join(out, "stderr.log"),
      secrets,
      OUTPUT_CAP,
      stop,
      sinkFailed,
    );
    child = spawner(sb.RUNTIME, sb.execArgv(vm, [cmd, ...args], execOpts), {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", outSink.write);
    child.stderr.on("data", errSink.write);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeout * 60_000);
    const exited = await waitForExit(child);
    clearTimeout(timer);
    const [t, e] = await Promise.all([outSink.end(), errSink.end()]);
    dropVm();
    if (sinkError)
      throw new Error(`cannot write the run output: ${sinkError.code ?? "write error"}`);

    const endedAt = new Date();
    finalRun = {
      ...base,
      harnessVersion,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      wallMs: endedAt - startedAt,
      exitCode: exited.code,
      signal: exited.signal,
      timedOut,
      interrupted,
      truncated: t.truncated || e.truncated,
      redactions: { transcript: t.count, stderr: e.count },
      ...(exited.error ? { error: `spawn error: ${exited.error.message}` } : {}),
      status: "done",
    };
  } catch (e) {
    if (finalized) throw e;
    error = e;
    stop();
    if (!harnessStarted) dropVolume();
    finalRun = {
      ...base,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      status: "failed",
      error: redact(String(e.message), secrets).text,
    };
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  if (leaked.length) finalRun.leaked = leaked;
  writeRun(finalRun);
  reportLeaks();
  if (error) throw new Error(finalRun.error);
  if (leaked.length) throw new Error(`failed to delete: ${leaked.join(", ")}`);
  console.log(out);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  });
}
