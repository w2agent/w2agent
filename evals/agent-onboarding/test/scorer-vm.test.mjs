import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { main } from "../score.mjs";
import { evalFiles, finalizeOutputs } from "../scorer-vm.mjs";

const TOKEN = "tok-abcdefghijklmnopqrstuvwxyz0123456789";
const LOGIN = { claudeAiOauth: { accessToken: TOKEN, refreshToken: "refresh-abcdefghijklmnop" } };
const RESULT = {
  mode: "run",
  scorer: { cli: "packages/cli/dist/index.js", cliRef: null, cliDirty: null },
  site: { ok: false, stage: "build", tail: `leaked ${TOKEN}` },
};

function rig({ guestExit = () => 0, files, agentUp = false, volumeUp = true } = {}) {
  const log = [];
  const spawned = [];
  const runDir = mkdtempSync(path.join(tmpdir(), "w2agent-score-vm-"));
  writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({
      harness: "claude",
      arm: "tool",
      fixture: "next-static",
      w2agentRef: "HEAD",
      workspace: "/work/workspace",
      sandbox: {
        image: "local/w2agent-eval:test",
        vm: "w2a-eval-abcd1234-agent",
        volume: "w2a-eval-abcd1234-work",
        mountPath: "/work",
      },
    }),
  );
  writeFileSync(path.join(runDir, "transcript.jsonl"), "{}\n");
  const outputs = files ?? {
    "result.json": Buffer.from(JSON.stringify(RESULT)),
    "summary.md": Buffer.from(`summary ${TOKEN}\n`),
    "audit.json": Buffer.from(`{"a":"${TOKEN}"}`),
  };
  const sandbox = {
    runId: () => "ffff0000",
    ensureImage: () => ({ tag: "local/w2agent-eval:test" }),
    listVms: () => (agentUp ? ["w2a-eval-abcd1234-agent"] : []),
    listVolumes: () => (volumeUp ? ["w2a-eval-abcd1234-work"] : []),
    createVolume: (n) => log.push(["createVolume", n]),
    startVm: (o) => log.push(["startVm", o.name, o.volume, o.mountPath]),
    execIn: (_n, argv, o) => {
      log.push(["execIn", argv[0], o?.user]);
      return { status: 0, stdout: "", stderr: "" };
    },
    execWithStdin: (_n, argv, input) => log.push(["execWithStdin", argv.join(" "), String(input)]),
    copyIn: async (_n, _d, guest, o) =>
      log.push(["copyIn", guest, o?.user, o?.producer?.cmd, o?.producer?.args]),
    readOut: async (_n, p) => {
      log.push(["readOut", p]);
      const name = path.basename(p);
      if (!(name in outputs)) throw new Error(`readOut ${p} exited 1`);
      return { data: outputs[name], truncated: false };
    },
    deleteVm: (n) => log.push(["deleteVm", n]),
    deleteVolume: (n) => log.push(["deleteVolume", n]),
  };
  const spawner = (cmd, argv) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    spawned.push({ cmd, argv });
    log.push(["guest", argv.at(-1)]);
    const code = guestExit(argv);
    setImmediate(() => {
      if (code !== 0) child.stderr.write("boom");
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", code, null);
    });
    return child;
  };
  const credentials = {
    readClaudeLogin: () => {
      log.push(["readLogin"]);
      return LOGIN;
    },
  };
  const deps = {
    sandbox,
    credentials,
    spawner,
    env: {},
    log: () => {},
    evalFiles: () => ["./score.mjs"],
    evalsProvenance: () => ({ evalsRef: "e".repeat(40), evalsDirty: false }),
  };
  return { log, spawned, runDir, sandbox, deps, outputs };
}

const names = (r) => r.log.map((l) => l[0]);

test("the scorer VM never receives credentials", async () => {
  const r = rig();
  await main(["--run", r.runDir], r.deps);
  assert.ok(!names(r).includes("execWithStdin"));
  assert.ok(!JSON.stringify(r.log).includes(TOKEN));
  assert.ok(!JSON.stringify(r.spawned).includes(TOKEN));
  const envKeys = [];
  for (const { argv } of r.spawned)
    for (let i = 0; i < argv.length; i++)
      if (argv[i] === "-e") envKeys.push(argv[i + 1].split("=")[0]);
  assert.ok(envKeys.length > 0);
  for (const k of envKeys)
    assert.ok(
      [
        "COREPACK_HOME",
        "HOME",
        "LANG",
        "NEXT_TELEMETRY_DISABLED",
        "PATH",
        "XDG_CACHE_HOME",
        "npm_config_cache",
        "npm_config_store_dir",
      ].includes(k),
      k,
    );
  const exec = r.spawned.find((s) => s.argv.includes("--in-sandbox"));
  assert.equal(exec.argv[exec.argv.indexOf("-u") + 1], "node");
  const start = r.log.find((l) => l[0] === "startVm");
  assert.deepEqual(start, [
    "startVm",
    "w2a-eval-abcd1234-score",
    "w2a-eval-abcd1234-work",
    "/work",
  ]);
  assert.ok(names(r).indexOf("readLogin") > names(r).indexOf("deleteVm"));
});

test("refuses to score while the agent VM still exists, and creates nothing", async () => {
  const r = rig({ agentUp: true });
  await assert.rejects(main(["--run", r.runDir], r.deps), /still exists/);
  assert.deepEqual(
    names(r).filter((n) => n !== "execIn"),
    [],
  );
});

test("refuses a run dir without a sandbox volume, and a volume that is gone", async () => {
  const r = rig();
  const j = JSON.parse(readFileSync(path.join(r.runDir, "run.json"), "utf8"));
  j.sandbox = undefined;
  writeFileSync(path.join(r.runDir, "run.json"), JSON.stringify(j));
  await assert.rejects(main(["--run", r.runDir], r.deps), /predates the sandbox/);
  const g = rig({ volumeUp: false });
  await assert.rejects(main(["--run", g.runDir], g.deps), /is gone/);
  assert.equal(names(g).includes("startVm"), false);
});

test("only result.json, summary.md and audit.json are copied out, redacted", async () => {
  const r = rig();
  await main(["--run", r.runDir], r.deps);
  assert.deepEqual(
    r.log.filter((l) => l[0] === "readOut").map((l) => l[1]),
    ["/home/node/out/result.json", "/home/node/out/summary.md", "/home/node/out/audit.json"],
  );
  assert.deepEqual(readdirSync(r.runDir).sort(), [
    "audit.json",
    "result.json",
    "run.json",
    "summary.md",
    "transcript.jsonl",
  ]);
  for (const f of ["result.json", "summary.md", "audit.json"])
    assert.ok(!readFileSync(path.join(r.runDir, f), "utf8").includes(TOKEN), f);
  const res = JSON.parse(readFileSync(path.join(r.runDir, "result.json"), "utf8"));
  assert.deepEqual(res.redaction, {
    patterns: true,
    exact: "1 staged values",
    redactions: { "result.json": 1, "summary.md": 1, "audit.json": 1 },
  });
  assert.equal(res.scorer.cliRef.length, 40);
  assert.equal(res.scorer.inVm, true);
  assert.match(readFileSync(path.join(r.runDir, "summary.md"), "utf8"), /\[REDACTED\]/);
});

test("unreadable host login: outputs are still written and the skip is recorded", async () => {
  const r = rig();
  r.deps.credentials.readClaudeLogin = () => {
    throw new Error("no login");
  };
  await main(["--run", r.runDir], r.deps);
  const res = JSON.parse(readFileSync(path.join(r.runDir, "result.json"), "utf8"));
  assert.equal(res.redaction.exact, "unavailable: no login");
});

test("a site that failed before the audit has no audit.json and still scores", async () => {
  const r = rig({
    files: {
      "result.json": Buffer.from(JSON.stringify(RESULT)),
      "summary.md": Buffer.from("s\n"),
    },
  });
  await main(["--run", r.runDir], r.deps);
  assert.ok(!existsSync(path.join(r.runDir, "audit.json")));
});

test("success deletes the scorer VM then the volume; --keep keeps the volume", async () => {
  const r = rig();
  await main(["--run", r.runDir], r.deps);
  const del = r.log.filter((l) => l[0].startsWith("delete")).map((l) => l[1]);
  assert.deepEqual(del, ["w2a-eval-abcd1234-score", "w2a-eval-abcd1234-work"]);
  const k = rig();
  await main(["--run", k.runDir, "--keep"], k.deps);
  assert.deepEqual(
    k.log.filter((l) => l[0].startsWith("delete")).map((l) => l[1]),
    ["w2a-eval-abcd1234-score"],
  );
});

test("a failed score deletes the scorer VM, keeps the run volume and writes nothing", async () => {
  const r = rig({ guestExit: (argv) => (argv.includes("--in-sandbox") ? 2 : 0) });
  await assert.rejects(main(["--run", r.runDir], r.deps), /scoring failed in the scorer VM/);
  assert.deepEqual(
    r.log.filter((l) => l[0].startsWith("delete")),
    [["deleteVm", "w2a-eval-abcd1234-score"]],
  );
  assert.ok(!existsSync(path.join(r.runDir, "result.json")));
});

test("a failed CLI build also deletes the scorer VM and never scores", async () => {
  const r = rig({ guestExit: (argv) => (argv.includes("timeout") ? 1 : 0) });
  await assert.rejects(main(["--run", r.runDir], r.deps), /CLI build failed/);
  assert.ok(names(r).includes("deleteVm"));
  assert.ok(!r.spawned.some((s) => s.argv.includes("--in-sandbox")));
});

test("a delete that fails is reported with the name", async () => {
  const r = rig();
  r.sandbox.deleteVm = () => {
    throw new Error("survived");
  };
  await assert.rejects(
    main(["--run", r.runDir], r.deps),
    /failed to delete: w2a-eval-abcd1234-score/,
  );
});

test("--baseline scores on a fresh volume, reads from it, and deletes both", async () => {
  const r = rig();
  const out = path.join(mkdtempSync(path.join(tmpdir(), "w2agent-score-base-")), "o");
  await main(["--baseline", "--fixture", "next-static", "--out", out], r.deps);
  assert.deepEqual(
    r.log.find((l) => l[0] === "createVolume"),
    ["createVolume", "w2a-eval-ffff0000-work"],
  );
  assert.ok(names(r).indexOf("createVolume") < names(r).indexOf("startVm"));
  const exec = r.spawned.find((s) => s.argv.includes("--in-sandbox"));
  assert.ok(exec.argv.includes("--baseline"));
  assert.ok(exec.argv.includes("/work/out"));
  assert.ok(r.log.some((l) => l[0] === "readOut" && l[1] === "/work/out/result.json"));
  assert.deepEqual(
    r.log.filter((l) => l[0].startsWith("delete")).map((l) => l[1]),
    ["w2a-eval-ffff0000-score", "w2a-eval-ffff0000-work"],
  );
  const res = JSON.parse(readFileSync(path.join(out, "result.json"), "utf8"));
  assert.match(res.redaction.exact, /not needed/);
  assert.ok(!names(r).includes("readLogin"));
});

test("--baseline deletes its fresh volume even when scoring fails", async () => {
  const r = rig({ guestExit: (argv) => (argv.includes("--in-sandbox") ? 2 : 0) });
  const out = path.join(mkdtempSync(path.join(tmpdir(), "w2agent-score-base-")), "o");
  await assert.rejects(main(["--baseline", "--out", out], r.deps));
  assert.ok(r.log.some((l) => l[0] === "deleteVolume" && l[1] === "w2a-eval-ffff0000-work"));
});

test("scorer code and the w2agent archive are copied as node into a dir outside the workspace", async () => {
  const r = rig();
  await main(["--run", r.runDir], r.deps);
  const copies = r.log.filter((l) => l[0] === "copyIn");
  assert.deepEqual(
    copies.map((c) => c[1]),
    ["/home/node/scorer", "/home/node/scorer/evals/agent-onboarding", "/work"],
  );
  assert.ok(copies.every((c) => c[2] === "node"));
  assert.equal(copies[0][3], "git");
  assert.ok(copies[0][4].includes(":(exclude)evals"));
  assert.ok(!copies[1][4].some((a) => String(a).startsWith("./test")));
  assert.deepEqual(copies[2][4].slice(-2), ["run.json", "transcript.jsonl"]);
});

test("host --cli is rejected; --in-sandbox accepts it", async () => {
  const { parseArgs } = await import("../score.mjs");
  assert.throws(() => parseArgs(["--run", "x", "--cli", "y"]), /--in-sandbox/);
  assert.equal(parseArgs(["--run", "x", "--cli", "y", "--in-sandbox"]).inSandbox, true);
});

test("finalizeOutputs redacts every file, counts, and rejects a non-JSON result", () => {
  const raw = {
    "result.json": Buffer.from(`{"x":"${TOKEN}${TOKEN}"}`),
    "summary.md": Buffer.from("clean"),
  };
  const { files, counts } = finalizeOutputs(raw, {
    secrets: [TOKEN],
    provenance: { cliRef: "a" },
  });
  assert.equal(counts["result.json"], 2);
  assert.ok(!files["result.json"].includes(TOKEN));
  assert.equal(files["audit.json"], undefined);
  assert.throws(
    () =>
      finalizeOutputs(
        { "result.json": Buffer.from("nope"), "summary.md": Buffer.from("") },
        {
          secrets: [TOKEN],
          provenance: {},
        },
      ),
    /not valid JSON/,
  );
});

const ROTATED = `sk-ant-oat01-${"Z".repeat(40)}`;
const JWT = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;

test("rotated Anthropic tokens and JWTs are redacted with no exact match, in outputs and errors", async () => {
  const r = rig({
    files: {
      "result.json": Buffer.from(JSON.stringify({ site: { tail: ROTATED } })),
      "summary.md": Buffer.from(`jwt ${JWT}\n`),
    },
  });
  r.deps.credentials.readClaudeLogin = () => {
    throw new Error("no login");
  };
  await main(["--run", r.runDir], r.deps);
  for (const f of ["result.json", "summary.md"]) {
    const t = readFileSync(path.join(r.runDir, f), "utf8");
    assert.ok(!t.includes(ROTATED) && !t.includes(JWT), f);
  }
  const res = JSON.parse(readFileSync(path.join(r.runDir, "result.json"), "utf8"));
  assert.equal(res.redaction.exact, "unavailable: no login");
  assert.equal(res.redaction.redactions["result.json"], 1);

  const e = rig({
    guestExit: (argv) => (argv.includes("--in-sandbox") ? 2 : 0),
  });
  const orig = e.deps.spawner;
  e.deps.spawner = (c, a) => {
    const ch = orig(c, a);
    ch.stderr.write(`leak ${ROTATED} ${JWT}`);
    return ch;
  };
  await assert.rejects(main(["--run", e.runDir], e.deps), (err) => {
    assert.ok(!err.message.includes(ROTATED) && !err.message.includes(JWT));
    assert.match(err.message, /REDACTED/);
    return true;
  });
});

test("VM lifetimes follow the timeouts: scorer sleep covers its deadline", async () => {
  const r = rig();
  const starts = [];
  r.sandbox.startVm = (o) => starts.push(o);
  await main(["--run", r.runDir, "--timeout", "180"], r.deps);
  const { vmSeconds } = await import("../sandbox.mjs");
  assert.equal(starts[0].seconds, vmSeconds(3 * 180 * 60_000 + 20 * 60_000));
  assert.ok(starts[0].seconds > (3 * 180 + 20) * 60);
});

test("agent VM sleep exceeds --timeout (dry-run plan)", async () => {
  const { spawnSync } = await import("node:child_process");
  const out = mkdtempSync(path.join(tmpdir(), "w2agent-life-"));
  const x = spawnSync(
    process.execPath,
    [
      new URL("../run.mjs", import.meta.url).pathname,
      "--harness",
      "claude",
      "--arm",
      "tool",
      "--timeout",
      "180",
      "--out",
      path.join(out, "o"),
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.equal(x.status, 0, x.stderr);
  const plan = JSON.parse(x.stdout.slice(0, x.stdout.lastIndexOf("}") + 1));
  assert.ok(Number(plan.vmArgv.at(-1)) >= 180 * 60 + 600);
});

test("scorer defaults to the scorer checkout HEAD, not the run's w2agentRef; --ref overrides", async () => {
  const r = rig();
  const j = JSON.parse(readFileSync(path.join(r.runDir, "run.json"), "utf8"));
  j.w2agentRef = "0".repeat(40);
  writeFileSync(path.join(r.runDir, "run.json"), JSON.stringify(j));
  await main(["--run", r.runDir], r.deps);
  const res = JSON.parse(readFileSync(path.join(r.runDir, "result.json"), "utf8"));
  assert.notEqual(res.scorer.cliRef, "0".repeat(40));
  assert.match(res.scorer.cliRef, /^[0-9a-f]{40}$/);
});

test("evalFiles copies tracked files only, never test/ or untracked files", async () => {
  const { execFileSync } = await import("node:child_process");
  const d = mkdtempSync(path.join(tmpdir(), "w2agent-evalfiles-"));
  const git = (...a) => execFileSync("git", a, { cwd: d, stdio: "pipe" });
  git("init", "-q");
  mkdirSync(path.join(d, "test"));
  writeFileSync(path.join(d, "score.mjs"), "x");
  writeFileSync(path.join(d, "test", "t.mjs"), "x");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "i");
  writeFileSync(path.join(d, "creds.json"), "secret");
  assert.deepEqual(evalFiles(d), ["./score.mjs"]);
});

test("an oversize audit.json fails the score instead of vanishing", async () => {
  const r = rig();
  const orig = r.sandbox.readOut;
  r.sandbox.readOut = async (n, p, o) =>
    p.endsWith("audit.json") ? { data: Buffer.alloc(1), truncated: true } : orig(n, p, o);
  await assert.rejects(main(["--run", r.runDir], r.deps), /audit.json exceeds/);
  assert.ok(!existsSync(path.join(r.runDir, "result.json")));
  assert.ok(!r.log.some((l) => l[0] === "deleteVolume"));
});

test("a non-object result.json is a clear error, not a TypeError", () => {
  for (const body of ["null", "[]", "5"])
    assert.throws(
      () =>
        finalizeOutputs(
          { "result.json": Buffer.from(body), "summary.md": Buffer.from("") },
          { secrets: null, provenance: {} },
        ),
      /not valid: expected a JSON object/,
    );
});

test("a run.json still in status starting is refused", async () => {
  const r = rig();
  const j = JSON.parse(readFileSync(path.join(r.runDir, "run.json"), "utf8"));
  j.status = "starting";
  writeFileSync(path.join(r.runDir, "run.json"), JSON.stringify(j));
  await assert.rejects(main(["--run", r.runDir], r.deps), /did not finish/);
  assert.ok(!names(r).includes("startVm"));
});

test("the agent-VM-still-up message names one VM, not --cleanup", async () => {
  const r = rig({ agentUp: true });
  await assert.rejects(main(["--run", r.runDir], r.deps), (e) => {
    assert.match(e.message, /container delete --force w2a-eval-abcd1234-agent/);
    assert.ok(!e.message.includes("--cleanup"));
    return true;
  });
});
