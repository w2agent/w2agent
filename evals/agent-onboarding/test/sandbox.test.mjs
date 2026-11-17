import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildArgv,
  copyIn,
  deleteVm,
  ensureImage,
  execArgv,
  execIn,
  execWithStdin,
  imageTag,
  NAME_PREFIX,
  RUNTIME,
  readOut,
  resourceName,
  runId,
  startArgv,
  sweep,
  volumeCreateArgv,
} from "../sandbox.mjs";

const SECRET = "sk-ant-oat-ACCESSTOKEN-0123456789";

test("imageTag changes with a Dockerfile byte or any build arg, and is stable otherwise", () => {
  const base = imageTag(Buffer.from("FROM x\n"), { A: "1", B: "2" });
  assert.match(base, /^local\/w2agent-eval:[0-9a-f]{12}$/);
  assert.equal(imageTag(Buffer.from("FROM x\n"), { B: "2", A: "1" }), base);
  assert.notEqual(imageTag(Buffer.from("FROM y\n"), { A: "1", B: "2" }), base);
  assert.notEqual(imageTag(Buffer.from("FROM x\n"), { A: "1", B: "3" }), base);
  assert.notEqual(imageTag(Buffer.from("FROM x\n"), { A: "1" }), base);
});

test("names carry the prefix and run id", () => {
  const id = runId();
  assert.match(id, /^[0-9a-f]{8}$/);
  for (const role of ["agent", "score", "vol"])
    assert.equal(resourceName(id, role), `${NAME_PREFIX}${id}-${role}`);
  assert.ok(NAME_PREFIX.startsWith("w2a-eval-"));
});

test("startArgv is locked down: cap-drop, tmpfs, volume, no host mount", () => {
  const argv = startArgv({
    name: "w2a-eval-1-agent",
    image: "img:1",
    volume: "w2a-eval-1-vol",
    mountPath: "/work",
  });
  const at = (f) => argv[argv.indexOf(f) + 1];
  assert.equal(at("--cap-drop"), "ALL");
  assert.equal(at("--tmpfs"), "/tmp");
  assert.equal(at("-v"), "w2a-eval-1-vol:/work");
  assert.equal(at("--name"), "w2a-eval-1-agent");
  assert.ok(argv.includes("--cpus") && argv.includes("--memory"));
  assert.ok(!argv.includes("--mount") && !argv.includes("--publish") && !argv.includes("-p"));
  assert.equal(argv.filter((a) => a === "-v").length, 1);
  assert.ok(!argv.some((a) => a.startsWith("/") && a !== "/tmp" && !a.includes(":")));
  assert.deepEqual(argv.slice(-3), ["img:1", "sleep", "7200"]);
});

test("volumeCreateArgv sets a size cap", () => {
  assert.deepEqual(volumeCreateArgv("v", 8589934592), [
    "volume",
    "create",
    "-s",
    "8589934592",
    "v",
  ]);
});

test("buildArgv uses absolute-path inputs, sorted build args, context last", () => {
  const argv = buildArgv({
    tag: "t:1",
    dockerfile: "/a/Dockerfile",
    context: "/a",
    buildArgs: { B: "2", A: "1" },
  });
  assert.deepEqual(argv, [
    "build",
    "-t",
    "t:1",
    "-f",
    "/a/Dockerfile",
    "--build-arg",
    "A=1",
    "--build-arg",
    "B=2",
    "/a",
  ]);
});

test("execArgv: stdin flag, user, cwd, non-secret env", () => {
  const argv = execArgv("n", ["sh", "-c", "cat > /p && chmod 600 /p"], {
    user: "node",
    cwd: "/work",
    env: { HOME: "/home/node" },
    stdin: true,
  });
  assert.deepEqual(argv, [
    "exec",
    "-i",
    "-u",
    "node",
    "-w",
    "/work",
    "-e",
    "HOME=/home/node",
    "n",
    "sh",
    "-c",
    "cat > /p && chmod 600 /p",
  ]);
  assert.deepEqual(execArgv("n", ["ls"]), ["exec", "n", "ls"]);
});

test("execWithStdin sends the secret on stdin and never on argv", () => {
  const calls = [];
  const runner = (argv, opts) => {
    calls.push({ argv, opts });
    return { status: 0 };
  };
  execWithStdin("n", ["sh", "-c", "cat > /p && chmod 600 /p"], Buffer.from(SECRET), {
    user: "node",
    runner,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.input.toString(), SECRET);
  assert.ok(calls[0].argv.includes("-i"));
  assert.ok(!calls[0].argv.join(" ").includes(SECRET));
  assert.throws(
    () => execWithStdin("n", ["x"], Buffer.from(SECRET), { runner: () => ({ status: 3 }) }),
    (e) => {
      assert.ok(!e.message.includes(SECRET));
      return /exited 3/.test(e.message);
    },
  );
});

test("execIn with input adds -i so stdin is not dropped", () => {
  assert.deepEqual(execArgv("n", ["cat"], { stdin: true }).slice(0, 2), ["exec", "-i"]);
  const calls = [];
  const runner = (argv, opts) => {
    calls.push({ argv, opts });
    return { status: 0 };
  };
  execIn("n", ["cat"], { input: "x", runner });
  assert.equal(calls[0].argv[1], "-i");
  assert.equal(calls[0].opts.input, "x");
  execIn("n", ["cat"], { runner });
  assert.ok(!calls[1].argv.includes("-i"));
});

test("undefined build args are dropped from argv and hash", () => {
  const b = Buffer.from("FROM x\n");
  assert.equal(imageTag(b, { A: "1", B: undefined }), imageTag(b, { A: "1" }));
  assert.notEqual(imageTag(b, { A: "1", B: "undefined" }), imageTag(b, { A: "1" }));
  const argv = buildArgv({
    tag: "t",
    dockerfile: "/d",
    context: "/c",
    buildArgs: { A: "1", B: undefined },
  });
  assert.ok(!argv.join(" ").includes("undefined"));
});

test("ensureImage hashes the Dockerfile it builds", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "img-"));
  const df = path.join(dir, "Dockerfile");
  writeFileSync(df, "FROM a\n");
  const seen = [];
  const runner = (argv) => {
    seen.push(argv);
    return { status: argv[0] === "image" ? 1 : 0 };
  };
  const one = ensureImage({ dockerfile: df, context: dir, runner });
  writeFileSync(df, "FROM b\n");
  const two = ensureImage({ dockerfile: df, context: dir, runner });
  assert.notEqual(one.tag, two.tag);
  assert.equal(one.tag, imageTag(Buffer.from("FROM a\n")));
  assert.ok(seen.some((a) => a[0] === "build" && a.includes(df)));
});

const failingRuntime =
  (code, script = "") =>
  (cmd, args, opts) =>
    cmd === RUNTIME
      ? spawn(process.execPath, ["-e", `${script}process.exit(${code})`], opts)
      : spawn(cmd, args, opts);

test("copyIn rejects, never crashes, when the guest exits early", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "big-"));
  writeFileSync(path.join(dir, "f"), Buffer.alloc(16 * 1024 * 1024, 1));
  await assert.rejects(copyIn("n", dir, "/x", { spawner: failingRuntime(3) }), /copyIn failed/);
});

test("copyIn rejects when the runtime binary cannot start", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "small-"));
  writeFileSync(path.join(dir, "f"), "x");
  const spawner = (cmd, args, opts) =>
    spawn(cmd === RUNTIME ? "w2a-eval-no-such-binary" : cmd, cmd === RUNTIME ? [] : args, opts);
  await assert.rejects(copyIn("n", dir, "/x", { spawner }), /copyIn failed/);
});

test("copyIn resolves when both sides succeed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ok-"));
  writeFileSync(path.join(dir, "f"), "x");
  const spawner = (cmd, args, opts) =>
    cmd === RUNTIME
      ? spawn(
          process.execPath,
          ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],
          opts,
        )
      : spawn(cmd, args, opts);
  await copyIn("n", dir, "/x", { spawner });
});

test("readOut rejects on a failing exec and caps output", async () => {
  await assert.rejects(readOut("n", "/p", { spawner: failingRuntime(2) }), /exited 2/);
  const spawner = (_cmd, _args, opts) =>
    spawn(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.alloc(100000, 97), () => process.exit(0))"],
      opts,
    );
  const capped = await readOut("n", "/p", { maxBytes: 10, spawner });
  assert.equal(capped.truncated, true);
  assert.equal(capped.data.length, 10);
  const full = await readOut("n", "/p", { spawner });
  assert.equal(full.truncated, false);
  assert.equal(full.data.length, 100000);
});

const drop = (arr, n) => {
  if (arr.includes(n)) arr.splice(arr.indexOf(n), 1);
};

function fakeRuntime(vms, volumes) {
  const calls = [];
  const runner = (argv) => {
    calls.push(argv);
    const [a, b] = argv;
    if (a === "list") return { status: 0, stdout: JSON.stringify(vms.map((id) => ({ id }))) };
    if (a === "volume" && b === "list")
      return { status: 0, stdout: JSON.stringify(volumes.map((id) => ({ id }))) };
    if (a === "delete") for (const n of argv.slice(1)) drop(vms, n);
    if (a === "volume" && b === "delete") for (const n of argv.slice(2)) drop(volumes, n);
    return { status: 0, stdout: "" };
  };
  return { runner, calls };
}

test("sweep deletes only prefixed containers and volumes", () => {
  const vms = ["buildkit", "w2a-eval-a1-agent", "other-w2a-eval-x"];
  const volumes = ["wm-gkd", "w2a-eval-a1-vol", "w2a-eval-b2-vol"];
  const { runner, calls } = fakeRuntime(vms, volumes);
  const { deleted, failed } = sweep(runner);
  assert.deepEqual(deleted.sort(), ["w2a-eval-a1-agent", "w2a-eval-a1-vol", "w2a-eval-b2-vol"]);
  assert.deepEqual(failed, []);
  assert.deepEqual(vms, ["buildkit", "other-w2a-eval-x"]);
  assert.deepEqual(volumes, ["wm-gkd"]);
  for (const c of calls) assert.ok(!c.includes("buildkit") && !c.includes("wm-gkd"));
});

test("delete retries once, then names what survived", () => {
  const calls = [];
  const runner = (argv) => {
    calls.push(argv);
    if (argv[0] === "list")
      return { status: 0, stdout: JSON.stringify([{ id: "w2a-eval-z-agent" }]) };
    return { status: 0, stdout: "" };
  };
  assert.throws(() => deleteVm("w2a-eval-z-agent", runner), /w2a-eval-z-agent survived/);
  assert.equal(calls.filter((c) => c[0] === "delete").length, 2);
  const s = sweep((argv) =>
    argv[0] === "list"
      ? { status: 0, stdout: JSON.stringify([{ id: "w2a-eval-z-agent" }]) }
      : argv[1] === "list"
        ? { status: 0, stdout: "[]" }
        : { status: 0, stdout: "" },
  );
  assert.deepEqual(s, { deleted: [], failed: ["w2a-eval-z-agent"] });
});
