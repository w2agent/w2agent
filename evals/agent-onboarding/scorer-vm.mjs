import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as credentialsMod from "./credentials.mjs";
import { redact } from "./credentials.mjs";
import { buildGuestEnv, exportArgs, waitForExit } from "./run.mjs";
import * as sandboxMod from "./sandbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const DEFAULT_MOUNT = "/work";
const GUEST_HOME = "/home/node";
const SCORER_DIR = `${GUEST_HOME}/scorer`;
const SCORER_CLI = `${SCORER_DIR}/packages/cli/dist/index.js`;
const SCORER_SCRIPT = `${SCORER_DIR}/evals/agent-onboarding/score.mjs`;
const GUEST_CACHE = `${GUEST_HOME}/cache`;
const RUN_OUT = `${GUEST_HOME}/out`;
const VOLUME_BYTES = 8 * 1024 ** 3;
const OUT_CAP = 20 * 1024 * 1024;
const BUILD_SECONDS = 600;
const DEADLINE_EXTRA_MS = 20 * 60_000;
const TAIL_CHARS = 1500;
const OUT_FILES = [
  { name: "result.json", required: true },
  { name: "summary.md", required: true },
  { name: "audit.json", required: false },
];

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

export function evalFiles(dir = HERE) {
  const r = git(dir, "ls-files", "-co", "--exclude-standard", "-z");
  if (r.status !== 0) throw new Error(`git ls-files failed in ${dir}: ${(r.stderr || "").trim()}`);
  return r.stdout
    .split("\0")
    .filter((f) => f && !f.startsWith("test/") && existsSync(path.join(dir, f)))
    .map((f) => `./${f}`);
}

export function evalsProvenance(dir = HERE) {
  const head = git(dir, "rev-parse", "HEAD");
  if (head.status !== 0) return { evalsRef: null, evalsDirty: null };
  const status = git(dir, "status", "--porcelain", "--", ".");
  return {
    evalsRef: head.stdout.trim(),
    evalsDirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

function resolveRef(checkout, ref) {
  const r = git(checkout, "rev-parse", "--verify", `${ref}^{commit}`);
  if (r.status !== 0) throw new Error(`cannot resolve --ref ${ref} in ${checkout}`);
  return r.stdout.trim();
}

// Redacts every staged secret from the three copied-out files and stamps the result.
export function finalizeOutputs(raw, { secrets, skipReason, provenance }) {
  const counts = {};
  const files = {};
  const text = (name) => {
    const body = raw[name];
    if (body === undefined) return undefined;
    const t = body.toString("utf8");
    if (!secrets) return t;
    const r = redact(t, secrets);
    counts[name] = r.count;
    return r.text;
  };
  const resultText = text("result.json");
  const summary = text("summary.md");
  const audit = text("audit.json");
  let result;
  try {
    result = JSON.parse(resultText);
  } catch {
    throw new Error("result.json from the scorer VM is not valid JSON");
  }
  result.scorer = { ...result.scorer, ...provenance, inVm: true };
  result.redaction = secrets
    ? { redactions: counts, secrets: secrets.length }
    : (skipReason ?? "not needed: no agent run");
  files["result.json"] = `${JSON.stringify(result, null, 2)}\n`;
  files["summary.md"] = summary;
  if (audit !== undefined) files["audit.json"] = audit;
  return { files, counts };
}

const clip = (s) => (s.length > TAIL_CHARS ? s.slice(-TAIL_CHARS) : s).trim();

export async function scoreInSandbox(opts, deps = {}) {
  const sb = { ...sandboxMod, ...deps.sandbox };
  const cred = { ...credentialsMod, ...deps.credentials };
  const spawner = deps.spawner ?? spawn;
  const env = deps.env ?? process.env;
  const exit = deps.exit ?? process.exit;
  const log = deps.log ?? ((m) => console.error(`[score] ${m}`));
  const checkout = deps.checkout ?? REPO_ROOT;
  const timeoutMs = opts.timeout * 60_000;

  let run = null;
  let runDir = null;
  let out;
  let volume;
  let mountPath = DEFAULT_MOUNT;
  let fixture = opts.fixture;
  let id;
  let ownsVolume = false;
  if (opts.baseline) {
    out = path.resolve(opts.out);
    id = sb.runId();
    volume = sb.resourceName(id, "work");
    ownsVolume = true;
  } else {
    runDir = path.resolve(opts.run);
    const runJson = path.join(runDir, "run.json");
    if (!existsSync(runJson)) throw new Error(`run.json not found in ${runDir}`);
    run = JSON.parse(readFileSync(runJson, "utf8"));
    const s = run.sandbox;
    if (!s?.volume)
      throw new Error(
        "run.json has no sandbox.volume: this run predates the sandbox and cannot be scored; rerun it with run.mjs",
      );
    const m = /^w2a-eval-([A-Za-z0-9]+)-work$/.exec(s.volume);
    if (!m || !/^w2a-eval-[A-Za-z0-9]+-agent$/.test(s.vm ?? ""))
      throw new Error("run.json sandbox names are not w2a-eval-<id>-work / -agent");
    id = m[1];
    volume = s.volume;
    mountPath = s.mountPath ?? DEFAULT_MOUNT;
    if (run.workspace !== `${mountPath}/workspace`)
      throw new Error(`run.json workspace ${run.workspace} is not ${mountPath}/workspace`);
    fixture = run.fixture ?? "next-static";
    out = path.resolve(opts.out ?? runDir);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(fixture)) throw new Error("fixture must be a plain name");
  const vm = sb.resourceName(id, "score");
  const sha = resolveRef(checkout, opts.ref ?? run?.w2agentRef ?? "HEAD");

  const vms = sb.listVms();
  if (run && vms.includes(run.sandbox.vm))
    throw new Error(
      `agent VM ${run.sandbox.vm} still exists; the volume attaches to one VM at a time. Wait for the run to finish or run \`run.mjs --cleanup\``,
    );
  if (vms.includes(vm))
    throw new Error(`scorer VM ${vm} already exists; run \`run.mjs --cleanup\``);
  const volumes = sb.listVolumes();
  if (run && !volumes.includes(volume))
    throw new Error(`volume ${volume} is gone (already scored, or cleaned up); nothing to score`);
  if (!run && volumes.includes(volume)) throw new Error(`volume ${volume} already exists`);

  const { tag } = sb.ensureImage({});
  const guestRunDir = mountPath;
  const guestOut = run ? RUN_OUT : `${mountPath}/out`;
  const guestEnv = buildGuestEnv(GUEST_CACHE);

  let vmUp = false;
  let volumeUp = false;
  let active = null;
  let deadlineHit = false;
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
  const killActive = () => {
    try {
      active?.kill("SIGKILL");
    } catch {}
    try {
      process.kill(-active.pid, "SIGKILL");
    } catch {}
  };
  const reportLeaks = () => {
    if (leaked.length)
      console.error(
        `FAILED TO DELETE sandbox resources, run \`run.mjs --cleanup\`: ${leaked.join(", ")}`,
      );
  };
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) exit(1);
    interrupted = true;
    killActive();
    dropVm();
    if (ownsVolume) dropVolume();
    reportLeaks();
    exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const deadline = setTimeout(
    () => {
      deadlineHit = true;
      killActive();
      dropVm();
    },
    3 * timeoutMs + DEADLINE_EXTRA_MS,
  );

  const inVm = (user, argv) => {
    const r = sb.execIn(vm, argv, { user });
    if (r.status !== 0)
      throw new Error(
        `${argv[0]} in the scorer VM exited ${r.status}: ${String(r.stderr ?? "")
          .trim()
          .slice(0, 300)}`,
      );
  };
  const guest = (argv, { cwd } = {}) =>
    new Promise((resolve) => {
      const child = spawner(
        sb.RUNTIME,
        sb.execArgv(vm, argv, { user: "node", cwd, env: guestEnv }),
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      active = child;
      let buf = "";
      const onData = (d) => {
        buf = (buf + d).slice(-TAIL_CHARS * 4);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      waitForExit(child).then((r) => {
        active = null;
        resolve({ ...r, tail: clip(buf) });
      });
    });
  const mustGuest = async (what, argv, o) => {
    const r = await guest(argv, o);
    if (deadlineHit) throw new Error(`scorer VM deadline exceeded during ${what}`);
    if (r.error || r.code !== 0)
      throw new Error(
        `${what} failed in the scorer VM (exit ${r.code ?? r.signal ?? r.error?.message}): ${r.tail}`,
      );
  };

  let result;
  let succeeded = false;
  try {
    if (ownsVolume) {
      volumeUp = true;
      sb.createVolume(volume, VOLUME_BYTES);
    } else {
      volumeUp = true;
    }
    vmUp = true;
    sb.startVm({ name: vm, image: tag, volume, mountPath });
    log(`scorer VM ${vm} started (volume ${volume})`);
    inVm("root", ["chmod", "0777", mountPath]);
    const fixtureDir = `${SCORER_DIR}/evals/agent-onboarding/fixtures/${fixture}`;
    inVm("node", [
      "sh",
      "-c",
      `rm -f ${mountPath}/run.json ${mountPath}/transcript.jsonl && mkdir -p ${SCORER_DIR}/evals/agent-onboarding ${guestOut} ${GUEST_CACHE}`,
    ]);
    await sb.copyIn(vm, null, SCORER_DIR, {
      user: "node",
      spawner,
      producer: { cmd: "git", args: exportArgs(sha), cwd: checkout },
    });
    const files = (deps.evalFiles ?? evalFiles)();
    await sb.copyIn(vm, null, `${SCORER_DIR}/evals/agent-onboarding`, {
      user: "node",
      spawner,
      producer: { cmd: "tar", args: ["-c", "-C", HERE, "--", ...files] },
    });
    if (run) {
      const names = ["run.json", "transcript.jsonl"].filter((n) =>
        existsSync(path.join(runDir, n)),
      );
      await sb.copyIn(vm, null, guestRunDir, {
        user: "node",
        spawner,
        producer: { cmd: "tar", args: ["-c", "-C", runDir, "--", ...names] },
      });
    }
    inVm("node", ["sh", "-c", `cd ${fixtureDir} && git init -q && git add -f .`]);
    log(`building the w2agent CLI at ${sha.slice(0, 12)} inside the VM`);
    await mustGuest(
      "CLI build",
      [
        "timeout",
        String(BUILD_SECONDS),
        "sh",
        "-c",
        `cd ${SCORER_DIR} && pnpm install --frozen-lockfile --filter 'w2agent...' && pnpm --filter 'w2agent...' run build`,
      ],
      { cwd: SCORER_DIR },
    );
    log("scoring inside the VM");
    const scoreArgs = [
      "node",
      SCORER_SCRIPT,
      "--in-sandbox",
      ...(run ? ["--run", guestRunDir] : ["--baseline", "--fixture", fixture]),
      "--cli",
      SCORER_CLI,
      "--out",
      guestOut,
      "--timeout",
      String(opts.timeout),
    ];
    await mustGuest("scoring", scoreArgs, { cwd: SCORER_DIR });

    const raw = {};
    for (const f of OUT_FILES) {
      try {
        const r = await sb.readOut(vm, `${guestOut}/${f.name}`, {
          maxBytes: OUT_CAP,
          user: "node",
          spawner,
        });
        if (r.truncated) throw new Error(`${f.name} exceeds ${OUT_CAP} bytes`);
        raw[f.name] = r.data;
      } catch (e) {
        if (f.required) throw e;
      }
    }
    dropVm();
    if (deadlineHit) throw new Error("scorer VM deadline exceeded");

    let secrets = null;
    let skipReason;
    if (run) {
      try {
        const harness = run.harness;
        const login =
          harness === "claude"
            ? cred.readClaudeLogin({ file: opts.claudeCredentials, env })
            : cred.readCodexAuth({ file: opts.codexAuth, env });
        secrets = cred.secretValues(login);
      } catch (e) {
        skipReason = `skipped: ${e.message}`;
        console.error(`WARNING: output redaction skipped (${e.message})`);
      }
    }
    const provenance = {
      cliRef: sha,
      cliDirty: false,
      ...(deps.evalsProvenance ?? evalsProvenance)(),
    };
    const fin = finalizeOutputs(raw, { secrets, skipReason, provenance });
    mkdirSync(out, { recursive: true });
    for (const [name, body] of Object.entries(fin.files))
      writeFileSync(path.join(out, name), body, { mode: 0o600 });
    result = JSON.parse(fin.files["result.json"]);
    succeeded = true;
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    killActive();
    dropVm();
    if (volumeUp && (succeeded ? !opts.keep : ownsVolume)) dropVolume();
    else if (volumeUp && !succeeded)
      console.error(
        `volume ${volume} kept (workspace intact); rescore, or run \`run.mjs --cleanup\``,
      );
    reportLeaks();
  }
  if (leaked.length) throw new Error(`failed to delete: ${leaked.join(", ")}`);
  if (!succeeded) throw new Error("scoring did not complete");
  if (!opts.keep) log(`volume ${volume} deleted`);
  console.log(out);
  return result;
}
