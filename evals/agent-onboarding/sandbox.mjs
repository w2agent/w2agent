import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME = "container";
export const NAME_PREFIX = "w2a-eval-";
export const SANDBOX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "sandbox");
export const DOCKERFILE = path.join(SANDBOX_DIR, "Dockerfile");
export const IMAGE_REPO = "local/w2agent-eval";

const argKeys = (buildArgs) =>
  Object.keys(buildArgs)
    .filter((k) => buildArgs[k] !== undefined)
    .sort();

export function imageTag(dockerfileBytes, buildArgs = {}) {
  const h = createHash("sha256");
  h.update(dockerfileBytes);
  for (const k of argKeys(buildArgs)) h.update(`\0${k}=${buildArgs[k]}`);
  return `${IMAGE_REPO}:${h.digest("hex").slice(0, 12)}`;
}

export function runId() {
  return randomBytes(4).toString("hex");
}

export function resourceName(id, role) {
  return `${NAME_PREFIX}${id}-${role}`;
}

export function buildArgv({ tag, dockerfile = DOCKERFILE, context = SANDBOX_DIR, buildArgs = {} }) {
  const argv = ["build", "-t", tag, "-f", dockerfile];
  for (const k of argKeys(buildArgs)) argv.push("--build-arg", `${k}=${buildArgs[k]}`);
  argv.push(context);
  return argv;
}

export function volumeCreateArgv(name, sizeBytes) {
  return ["volume", "create", "-s", String(sizeBytes), name];
}

export function startArgv({
  name,
  image,
  volume,
  mountPath,
  cpus = 4,
  memory = "8G",
  seconds = 7200,
}) {
  return [
    "run",
    "-d",
    "--name",
    name,
    "--cap-drop",
    "ALL",
    "--cpus",
    String(cpus),
    "--memory",
    String(memory),
    "--tmpfs",
    "/tmp",
    "-v",
    `${volume}:${mountPath}`,
    image,
    "sleep",
    String(seconds),
  ];
}

export function execArgv(name, argv, { user, cwd, env, stdin = false } = {}) {
  const out = ["exec"];
  if (stdin) out.push("-i");
  if (user) out.push("-u", user);
  if (cwd) out.push("-w", cwd);
  for (const [k, v] of Object.entries(env ?? {})) out.push("-e", `${k}=${v}`);
  out.push(name, ...argv);
  return out;
}

function run(argv, opts = {}) {
  const r = spawnSync(RUNTIME, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${RUNTIME} ${argv[0]} failed to start: ${r.error.message}`);
  return r;
}

function must(argv, opts) {
  const r = run(argv, opts);
  if (r.status !== 0) {
    throw new Error(
      `${RUNTIME} ${argv.slice(0, 2).join(" ")} exited ${r.status}: ${(r.stderr ?? "").trim()}`,
    );
  }
  return r;
}

export function imageExists(tag, runner = run) {
  return runner(["image", "inspect", tag]).status === 0;
}

export function ensureImage({
  dockerfile = DOCKERFILE,
  context = SANDBOX_DIR,
  buildArgs = {},
  runner = run,
}) {
  const tag = imageTag(readFileSync(dockerfile), buildArgs);
  if (imageExists(tag, runner)) return { tag, built: false };
  const r = runner(buildArgv({ tag, dockerfile, context, buildArgs }), {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) throw new Error(`image build failed for ${tag} (exit ${r.status})`);
  return { tag, built: true };
}

export function createVolume(name, sizeBytes) {
  must(volumeCreateArgv(name, sizeBytes));
}

export function startVm(opts) {
  must(startArgv(opts));
}

export function execIn(name, argv, { runner = run, ...opts } = {}) {
  const hasInput = opts.input !== undefined;
  return runner(
    execArgv(name, argv, { ...opts, stdin: hasInput || opts.stdin }),
    hasInput ? { input: opts.input } : {},
  );
}

export function execWithStdin(name, argv, input, { runner = run, ...opts } = {}) {
  const r = runner(execArgv(name, argv, { ...opts, stdin: true }), { input, encoding: "buffer" });
  if (r.status !== 0) throw new Error(`exec in ${name} exited ${r.status}`);
}

export function copyIn(name, hostDir, guestDir, { user, spawner = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const tar = spawner("tar", ["-c", "-C", hostDir, "."], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const ex = spawner(
      RUNTIME,
      execArgv(name, ["tar", "-x", "-C", guestDir], { user, stdin: true }),
      {
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let err = "";
    tar.stderr.on("data", (d) => {
      err += d;
    });
    ex.stderr.on("data", (d) => {
      err += d;
    });
    const fail = (e) => {
      err += ` ${e.message}`;
    };
    tar.stdout.on("error", fail);
    ex.stdin.on("error", fail);
    tar.stdout.pipe(ex.stdin);
    const codes = {};
    const done = (who, code) => {
      codes[who] = code;
      if (code !== 0) {
        tar.kill("SIGKILL");
        ex.kill("SIGKILL");
      }
      if (codes.tar === undefined || codes.ex === undefined) return;
      if (codes.tar === 0 && codes.ex === 0) resolve();
      else
        reject(
          new Error(
            `copyIn failed (tar ${codes.tar}, exec ${codes.ex}): ${err.trim().slice(0, 500)}`,
          ),
        );
    };
    tar.on("error", (e) => {
      fail(e);
      done("tar", -1);
    });
    ex.on("error", (e) => {
      fail(e);
      done("ex", -1);
    });
    tar.on("close", (c) => done("tar", c ?? -1));
    ex.on("close", (c) => done("ex", c ?? -1));
  });
}

export function readOut(
  name,
  guestPath,
  { maxBytes = 50 * 1024 * 1024, user, spawner = spawn } = {},
) {
  return new Promise((resolve, reject) => {
    const ex = spawner(RUNTIME, execArgv(name, ["cat", guestPath], { user }), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0;
    let truncated = false;
    let err = "";
    ex.stderr.on("data", (d) => {
      err += d;
    });
    ex.stdout.on("error", () => {});
    ex.stderr.on("error", () => {});
    ex.stdout.on("data", (d) => {
      if (truncated) return;
      const room = maxBytes - size;
      if (d.length > room) {
        chunks.push(d.subarray(0, Math.max(room, 0)));
        size = maxBytes;
        truncated = true;
        ex.kill("SIGKILL");
      } else {
        chunks.push(d);
        size += d.length;
      }
    });
    ex.on("error", reject);
    ex.on("close", (code) => {
      if (code !== 0 && !truncated)
        return reject(
          new Error(`readOut ${guestPath} exited ${code}: ${err.trim().slice(0, 300)}`),
        );
      resolve({ data: Buffer.concat(chunks), truncated });
    });
  });
}

function listNames(argv, runner) {
  const r = runner(argv);
  if (r.status !== 0) throw new Error(`${RUNTIME} ${argv.join(" ")} exited ${r.status}`);
  return JSON.parse(r.stdout || "[]").map(
    (x) => x.id ?? x.configuration?.name ?? x.configuration?.id,
  );
}

export const listVms = (runner = run) => listNames(["list", "--all", "--format", "json"], runner);
export const listVolumes = (runner = run) =>
  listNames(["volume", "list", "--format", "json"], runner);

function removeAndVerify(kind, name, runner) {
  const del = kind === "vm" ? ["delete", "--force", name] : ["volume", "delete", name];
  const list = kind === "vm" ? listVms : listVolumes;
  runner(del);
  let present = list(runner).includes(name);
  if (present) {
    runner(del);
    present = list(runner).includes(name);
  }
  if (present) throw new Error(`${kind === "vm" ? "container" : "volume"} ${name} survived delete`);
}

export const deleteVm = (name, runner = run) => removeAndVerify("vm", name, runner);
export const deleteVolume = (name, runner = run) => removeAndVerify("volume", name, runner);

export function sweep(runner = run) {
  const deleted = [];
  const failed = [];
  for (const [kind, names] of [
    ["vm", listVms(runner)],
    ["volume", listVolumes(runner)],
  ]) {
    for (const name of names) {
      if (!name?.startsWith(NAME_PREFIX)) continue;
      try {
        removeAndVerify(kind, name, runner);
        deleted.push(name);
      } catch {
        failed.push(name);
      }
    }
  }
  return { deleted, failed };
}
