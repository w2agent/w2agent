import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildChildEnv, buildHarnessArgv, exportArgs, main, parseArgs, scrubEnv } from "../run.mjs";
import { deleteVm, deleteVolume } from "../sandbox.mjs";

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
  assert.ok(x.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!x.args.includes("-s"));
  assert.ok(!x.args.some((a) => a.includes("sandbox_workspace_write")));
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
  const plan = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf("}") + 1));
  assert.match(plan.image, /^local\/w2agent-eval:[0-9a-f]{12}$/);
  assert.match(plan.vm, /^w2a-eval-/);
  assert.ok(plan.harnessArgv.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(plan.guestEnv.HOME, "/home/node");
  assert.ok(!r.stdout.includes("CLAUDECODE"));
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

const FAKE_TOKEN = "tok-abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE_LOGIN = {
  claudeAiOauth: {
    accessToken: FAKE_TOKEN,
    refreshToken: "refresh-abcdefghijklmnopqrstuvwxyz",
    expiresAt: Date.now() + 10 * 3600_000,
  },
};

function harnessRig({ script, hang = false, exitOnKill = true } = {}) {
  const log = [];
  const out = path.join(mkdtempSync(path.join(tmpdir(), "w2agent-eval-run-")), "o");
  const sandbox = {
    ensureImage: () => ({ tag: "local/w2agent-eval:test" }),
    runId: () => "abcd1234",
    createVolume: (n, size) => log.push(["createVolume", n, size]),
    startVm: (o) => log.push(["startVm", o.name]),
    execIn: (_n, argv, o) => {
      log.push(["execIn", argv[0], o?.user]);
      return { status: 0, stdout: "1.0.0\n", stderr: "" };
    },
    execWithStdin: (_n, _argv, input, o) => log.push(["execWithStdin", o?.user, String(input)]),
    copyIn: async (_n, _dir, guest, o) => log.push(["copyIn", guest, o?.user]),
    deleteVm: (n) => log.push(["deleteVm", n]),
    deleteVolume: (n) => log.push(["deleteVolume", n]),
    sweep: () => ({ deleted: [], failed: [] }),
  };
  const spawned = [];
  const rig = { log, out, sandbox, spawned };
  const spawner = (cmd, argv) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.die = () => {
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", null, "SIGKILL");
    };
    child.kill = () => {
      if (exitOnKill) child.die();
    };
    rig.child = child;
    spawned.push({ cmd, argv });
    if (!hang)
      setImmediate(() => {
        script?.(child);
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0, null);
      });
    return child;
  };
  rig.spawner = spawner;
  return rig;
}

const runArgs = (rig, extra = []) => [
  "--harness",
  "claude",
  "--arm",
  "tool",
  "--out",
  rig.out,
  ...extra,
];

test("sandboxed run: names in run.json before staging, env allowlist, redaction, VM deleted", async () => {
  const rig = harnessRig({
    script: (c) => {
      c.stdout.write(`{"a":"${FAKE_TOKEN}"}\n{"b":1}\n`);
      c.stderr.write(`oops ${FAKE_TOKEN}`);
    },
  });
  let seenAtStaging;
  const hostEnv = { ANTHROPIC_API_KEY: "sk-host-secret", AWS_SECRET: "aws-host-secret" };
  await main(runArgs(rig), {
    sandbox: rig.sandbox,
    credentials: {
      readClaudeLogin: () => {
        seenAtStaging = JSON.parse(readFileSync(path.join(rig.out, "run.json"), "utf8"));
        return FAKE_LOGIN;
      },
    },
    spawner: rig.spawner,
    env: hostEnv,
  });
  assert.equal(seenAtStaging.status, "starting");
  assert.equal(seenAtStaging.sandbox.vm, "w2a-eval-abcd1234-agent");
  assert.equal(seenAtStaging.sandbox.volume, "w2a-eval-abcd1234-work");

  const names = rig.log.map((l) => l[0]);
  assert.deepEqual(names.slice(0, 2), ["createVolume", "startVm"]);
  assert.ok(names.indexOf("copyIn") < names.indexOf("execWithStdin"));
  const chmod = rig.log.findIndex((l) => l[0] === "execIn" && l[1] === "chmod");
  assert.ok(chmod >= 0 && chmod < names.indexOf("copyIn"));
  assert.equal(rig.log[chmod][2], "root");
  assert.deepEqual(
    rig.log.find((l) => l[0] === "copyIn"),
    ["copyIn", "/work/workspace", "node"],
  );
  const staged = rig.log.find((l) => l[0] === "execWithStdin");
  assert.equal(staged[1], "node");
  assert.ok(staged[2].includes(FAKE_TOKEN));
  assert.ok(!staged[2].includes("refresh-abcdef"));

  const argvText = JSON.stringify(rig.spawned);
  assert.ok(!argvText.includes("sk-host-secret") && !argvText.includes("aws-host-secret"));
  assert.ok(!argvText.includes(FAKE_TOKEN));
  const envKeys = [];
  const a = rig.spawned[0].argv;
  for (let i = 0; i < a.length; i++) if (a[i] === "-e") envKeys.push(a[i + 1].split("=")[0]);
  assert.deepEqual(envKeys.sort(), [
    "COREPACK_HOME",
    "HOME",
    "LANG",
    "NEXT_TELEMETRY_DISABLED",
    "PATH",
    "XDG_CACHE_HOME",
    "npm_config_cache",
    "npm_config_store_dir",
  ]);
  assert.ok(a.includes("-u") && a[a.indexOf("-u") + 1] === "node");

  const transcript = readFileSync(path.join(rig.out, "transcript.jsonl"), "utf8");
  assert.ok(!transcript.includes(FAKE_TOKEN));
  assert.match(transcript, /\[REDACTED\]/);
  assert.ok(!readFileSync(path.join(rig.out, "stderr.log"), "utf8").includes(FAKE_TOKEN));
  const run = JSON.parse(readFileSync(path.join(rig.out, "run.json"), "utf8"));
  assert.deepEqual(run.redactions, { transcript: 1, stderr: 1 });
  assert.equal(run.status, "done");
  assert.equal(run.exitCode, 0);
  assert.equal(run.harnessVersion, "1.0.0");
  assert.equal(run.workspace, "/work/workspace");
  assert.ok(!JSON.stringify(run).includes(FAKE_TOKEN));
  assert.ok(rig.log.some((l) => l[0] === "deleteVm"));
  assert.ok(!rig.log.some((l) => l[0] === "deleteVolume"));
});

test("a token split across stream chunks is still redacted", async () => {
  const rig = harnessRig({
    script: (c) => {
      c.stdout.write(`{"a":"${FAKE_TOKEN.slice(0, 20)}`);
      c.stdout.write(`${FAKE_TOKEN.slice(20)}"}\n`);
    },
  });
  await main(runArgs(rig), {
    sandbox: rig.sandbox,
    credentials: { readClaudeLogin: () => FAKE_LOGIN },
    spawner: rig.spawner,
    env: {},
  });
  const t = readFileSync(path.join(rig.out, "transcript.jsonl"), "utf8");
  assert.ok(!t.includes(FAKE_TOKEN.slice(0, 20)));
  assert.equal(
    JSON.parse(readFileSync(path.join(rig.out, "run.json"), "utf8")).redactions.transcript,
    1,
  );
});

test("timeout deletes the agent VM (killing the exec alone does not stop it) and keeps the volume", {
  timeout: 15000,
}, async () => {
  const rig = harnessRig({ hang: true, exitOnKill: false });
  rig.sandbox.deleteVm = (n) => {
    rig.log.push(["deleteVm", n]);
    rig.child.die();
  };
  await main(runArgs(rig, ["--timeout", "0.001"]), {
    sandbox: rig.sandbox,
    credentials: { readClaudeLogin: () => FAKE_LOGIN },
    spawner: rig.spawner,
    env: {},
  });
  const run = JSON.parse(readFileSync(path.join(rig.out, "run.json"), "utf8"));
  assert.equal(run.timedOut, true);
  assert.equal(run.status, "done");
  assert.deepEqual(
    rig.log.filter((l) => l[0] === "deleteVm"),
    [["deleteVm", "w2a-eval-abcd1234-agent"]],
  );
  assert.ok(!rig.log.some((l) => l[0] === "deleteVolume"));
});

test("output over the cap stops writing, drops the partial line and fires the overflow hook", async () => {
  const { redactingSink } = await import("../run.mjs");
  let overflowed = 0;
  const f = path.join(mkdtempSync(path.join(tmpdir(), "w2agent-eval-sink-")), "t");
  const sink = redactingSink(f, [FAKE_TOKEN], 10, () => overflowed++);
  sink.write(Buffer.from("ab\ncdefghijklmnop"));
  sink.write(Buffer.from("zzz"));
  const r = await sink.end();
  assert.equal(overflowed, 1);
  assert.equal(r.truncated, true);
  assert.equal(readFileSync(f, "utf8"), "ab\n");
});

test("credential failure before the harness deletes VM and volume, keeps run.json failed", async () => {
  const rig = harnessRig();
  rig.sandbox.execWithStdin = () => {
    throw new Error(`no login ${FAKE_TOKEN}`);
  };
  await assert.rejects(
    main(runArgs(rig), {
      sandbox: rig.sandbox,
      credentials: {
        readClaudeLogin: () => FAKE_LOGIN,
      },
      spawner: rig.spawner,
      env: {},
    }),
    /no login/,
  );
  const run = JSON.parse(readFileSync(path.join(rig.out, "run.json"), "utf8"));
  assert.equal(run.status, "failed");
  assert.ok(!JSON.stringify(run).includes(FAKE_TOKEN));
  assert.equal(rig.spawned.length, 0);
  const names = rig.log.map((l) => l[0]);
  assert.ok(names.includes("deleteVm") && names.includes("deleteVolume"));
});

test("a VM that cannot be deleted is reported by name", async () => {
  const rig = harnessRig();
  rig.sandbox.deleteVm = () => {
    throw new Error("survived");
  };
  await assert.rejects(
    main(runArgs(rig), {
      sandbox: rig.sandbox,
      credentials: { readClaudeLogin: () => FAKE_LOGIN },
      spawner: rig.spawner,
      env: {},
    }),
    /w2a-eval-abcd1234-agent/,
  );
  assert.deepEqual(JSON.parse(readFileSync(path.join(rig.out, "run.json"), "utf8")).leaked, [
    "w2a-eval-abcd1234-agent",
  ]);
});

test("codex run stages the codex auth file and uses the bypass flag", async () => {
  const rig = harnessRig();
  const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url")}.s`;
  await main(["--harness", "codex", "--arm", "tool", "--out", rig.out], {
    sandbox: rig.sandbox,
    credentials: {
      readCodexAuth: () => ({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt, refresh_token: "r", id_token: "i", account_id: "a" },
      }),
    },
    spawner: rig.spawner,
    env: {},
  });
  const staged = rig.log.find((l) => l[0] === "execWithStdin");
  assert.equal(JSON.parse(staged[2]).tokens.refresh_token, "");
  assert.ok(rig.spawned[0].argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!rig.spawned[0].argv.includes("-s"));
});

test("--cleanup stands alone and prints the sweep result", async () => {
  assert.equal(parseArgs(["--cleanup"]).cleanup, true);
  assert.throws(() => parseArgs(["--cleanup", "--arm", "tool"]), /no other flags/);
  assert.throws(() => parseArgs(["--harness", "claude", "--arm", "tool", "--cleanup"]));
  const calls = [];
  await main(["--cleanup"], {
    sandbox: {
      sweep: () => {
        calls.push("sweep");
        return { deleted: ["w2a-eval-x"], failed: [] };
      },
    },
  });
  assert.deepEqual(calls, ["sweep"]);
  await assert.rejects(
    main(["--cleanup"], { sandbox: { sweep: () => ({ deleted: [], failed: ["w2a-eval-y"] }) } }),
    /w2a-eval-y/,
  );
});

test("credential override flags parse", () => {
  const o = parseArgs([
    "--harness",
    "codex",
    "--arm",
    "tool",
    "--claude-credentials",
    "/a",
    "--codex-auth",
    "/b",
  ]);
  assert.equal(o.claudeCredentials, "/a");
  assert.equal(o.codexAuth, "/b");
});

test("a signal before the harness starts finalizes run.json and names resources that failed to delete", async () => {
  const rig = harnessRig();
  rig.sandbox.deleteVm = () => {
    throw new Error("survived");
  };
  rig.sandbox.deleteVolume = () => {
    throw new Error("survived");
  };
  rig.sandbox.copyIn = async () => {
    process.emit("SIGINT");
  };
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  const exits = [];
  try {
    await assert.rejects(
      main(runArgs(rig), {
        sandbox: rig.sandbox,
        credentials: { readClaudeLogin: () => FAKE_LOGIN },
        spawner: rig.spawner,
        env: {},
        exit: (c) => {
          exits.push(c);
          throw new Error("exit");
        },
      }),
      /exit/,
    );
  } finally {
    console.error = orig;
  }
  assert.deepEqual(exits, [130]);
  const run = JSON.parse(readFileSync(path.join(rig.out, "run.json"), "utf8"));
  assert.equal(run.status, "interrupted");
  assert.deepEqual(run.leaked, ["w2a-eval-abcd1234-agent", "w2a-eval-abcd1234-work"]);
  const msg = errs.join("\n");
  assert.match(msg, /FAILED TO DELETE/);
  assert.ok(msg.includes("w2a-eval-abcd1234-agent") && msg.includes("w2a-eval-abcd1234-work"));
});

test("a VM whose start fails is still deleted by name, and a missing one is no leak", async () => {
  const rig = harnessRig();
  rig.sandbox.startVm = () => {
    throw new Error("start failed");
  };
  await assert.rejects(
    main(runArgs(rig), {
      sandbox: rig.sandbox,
      credentials: { readClaudeLogin: () => FAKE_LOGIN },
      spawner: rig.spawner,
      env: {},
    }),
    /start failed/,
  );
  assert.ok(rig.log.some((l) => l[0] === "deleteVm" && l[1] === "w2a-eval-abcd1234-agent"));
  assert.ok(rig.log.some((l) => l[0] === "deleteVolume"));
  assert.equal(JSON.parse(readFileSync(path.join(rig.out, "run.json"), "utf8")).leaked, undefined);
});

test("deleting a VM that never existed is success", () => {
  const runner = (argv) => ({ status: argv[0] === "list" ? 0 : 1, stdout: "[]" });
  deleteVm("w2a-eval-none-agent", runner);
  deleteVolume("w2a-eval-none-work", (argv) => ({ status: 0, stdout: "[]", argv }));
});

test("an unwritable output file does not crash the process and fails the run", async () => {
  const { redactingSink } = await import("../run.mjs");
  const errors = [];
  const s = redactingSink(
    "/nonexistent-dir/t",
    [],
    1e6,
    () => {},
    (e) => errors.push(e),
  );
  s.write(Buffer.from("x\n"));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(errors.length, 1);
  assert.ok((await s.end()).error);

  const rig = harnessRig({
    script: (c) => c.stdout.write("hello\n"),
    hang: true,
    exitOnKill: false,
  });
  rig.sandbox.copyIn = async () => mkdirSync(path.join(rig.out, "transcript.jsonl"));
  rig.sandbox.deleteVm = (n) => {
    rig.log.push(["deleteVm", n]);
    rig.child.die();
  };
  await assert.rejects(
    main(runArgs(rig), {
      sandbox: rig.sandbox,
      credentials: { readClaudeLogin: () => FAKE_LOGIN },
      spawner: rig.spawner,
      env: {},
    }),
    /cannot write the run output/,
  );
  assert.equal(JSON.parse(readFileSync(path.join(rig.out, "run.json"), "utf8")).status, "failed");
  assert.ok(rig.log.some((l) => l[0] === "deleteVm"));
});

test("streaming redaction also catches rotated token shapes with no exact match", async () => {
  const { redactingSink } = await import("../run.mjs");
  const f = path.join(mkdtempSync(path.join(tmpdir(), "w2agent-eval-pat-")), "t");
  const sink = redactingSink(f, [], 1000, () => {});
  sink.write(
    Buffer.from(
      `a sk-ant-oat01-${"Q".repeat(30)} b eyJ${"x".repeat(10)}.${"y".repeat(10)}.${"z".repeat(10)}\n`,
    ),
  );
  const r = await sink.end();
  assert.equal(r.count, 2);
  assert.ok(!readFileSync(f, "utf8").includes("sk-ant"));
});
