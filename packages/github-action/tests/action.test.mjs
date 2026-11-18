import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = fileURLToPath(new URL(".", import.meta.url));
const actionPath = process.env.W2AGENT_ACTION_YML || join(here, "..", "action.yml");
const cliPkgPath = join(here, "..", "..", "cli", "package.json");
const AUDIT_JSON = "/tmp/w2agent-audit.json";

const raw = readFileSync(actionPath, "utf8");
const action = parse(raw);
const steps = action.runs.steps;
const step = (name) => {
  const s = steps.find((x) => x.name === name);
  assert.ok(s, `step "${name}" exists`);
  return s;
};

const tmp = mkdtempSync(join(tmpdir(), "w2agent-action-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function runBash(body, env) {
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", body], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function runValidate(threshold) {
  const s = step("Validate inputs");
  return runBash(s.run, { ...s.env, THRESHOLD: threshold });
}

let n = 0;
function runCheck(threshold, auditContent) {
  const s = step("Check threshold");
  const file = join(tmp, `audit-${n++}.json`);
  if (auditContent !== undefined) writeFileSync(file, auditContent);
  assert.ok(s.run.includes(AUDIT_JSON), "Check threshold reads the documented audit path");
  return runBash(s.run.replaceAll(AUDIT_JSON, file), { THRESHOLD: threshold });
}

describe("Validate inputs (GHA-1)", () => {
  it("is the first step", () => {
    assert.equal(steps[0].name, "Validate inputs");
  });

  for (const ok of ["0", "1", "9", "10", "80", "99", "100"]) {
    it(`accepts threshold ${JSON.stringify(ok)}`, () => {
      assert.equal(runValidate(ok).code, 0);
    });
  }

  const bad = [
    "80%",
    "80.5",
    "B",
    "",
    "101",
    "-1",
    "+80",
    " 80",
    "80 ",
    "80\n",
    "080",
    "00",
    "99999999999999999999",
    "8e1",
    "0x50",
    "80; echo pwned",
  ];
  for (const b of bad) {
    it(`rejects threshold ${JSON.stringify(b)}`, () => {
      const r = runValidate(b);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /::error::/);
    });
  }
});

describe("Check threshold (GHA-1)", () => {
  const audit = (score) => JSON.stringify({ overallScore: score });

  it("fails when the score is below the threshold", () => {
    const r = runCheck("80", audit(10));
    assert.equal(r.code, 1);
    assert.match(r.out, /below threshold/);
  });
  it("passes when the score equals the threshold", () => {
    const r = runCheck("80", audit(80));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Audit passed/);
  });
  it("passes when the score is above the threshold", () => {
    assert.equal(runCheck("80", audit(95)).code, 0);
  });
  it("passes threshold 0 with score 0", () => {
    assert.equal(runCheck("0", audit(0)).code, 0);
  });

  for (const [label, content] of [
    ["missing file", undefined],
    ["malformed json", "{nope"],
    ["missing overallScore", "{}"],
    ["null score", '{"overallScore":null}'],
    ["string score", '{"overallScore":"90"}'],
    ["fractional score", '{"overallScore":90.5}'],
    ["negative score", '{"overallScore":-5}'],
    ["array score", '{"overallScore":[90]}'],
  ]) {
    it(`fails closed on ${label}`, () => {
      const r = runCheck("80", content);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /::error::/);
      assert.doesNotMatch(r.out, /Audit passed/);
    });
  }

  it("fails closed on a non-integer threshold even if validation was skipped", () => {
    for (const t of ["80%", "80.5", "B", ""]) {
      const r = runCheck(t, audit(10));
      assert.notEqual(r.code, 0, `threshold ${JSON.stringify(t)}`);
      assert.doesNotMatch(r.out, /Audit passed/);
    }
  });
});

describe("Expression injection (GHA-2)", () => {
  const exprRe = /\$\{\{\s*inputs\.[\w-]+\s*\}\}/g;
  const HOSTILE = "https://evil.example/'+(globalThis.__w2agentPwned='code ran')+'";

  it("no run or script body interpolates an inputs expression", () => {
    for (const s of steps) {
      const bodies = [s.run, s.with?.script].filter((b) => typeof b === "string");
      for (const b of bodies) {
        assert.doesNotMatch(b, /\$\{\{/, `step "${s.name}" interpolates an expression in code`);
      }
    }
  });

  it("hostile url input does not run as JavaScript in the github-script step", async () => {
    const s = step("Post PR comment");
    const substitute = (text) =>
      text.replace(exprRe, (m) => (/inputs\.url/.test(m) ? HOSTILE : "x"));
    const script = substitute(s.with.script);

    const created = [];
    const fsMock = {
      readFileSync: () => JSON.stringify({ grade: "A", overallScore: 90, timestamp: 0 }),
    };
    const github = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async (a) => created.push(a),
          updateComment: async () => assert.fail("unexpected update"),
        },
      },
    };
    const context = { repo: { owner: "o", repo: "r" }, issue: { number: 1 } };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const fn = new AsyncFunction("require", "github", "context", "process", script);
    delete globalThis.__w2agentPwned;
    try {
      await fn(
        (m) => (m === "fs" ? fsMock : assert.fail(`unexpected require ${m}`)),
        github,
        context,
        {
          env: { W2AGENT_URL: HOSTILE },
        },
      );
      assert.equal(globalThis.__w2agentPwned, undefined, "injected code ran");
      assert.equal(created.length, 1);
      assert.match(created[0].body, /w2agent-audit/);
      assert.equal(s.env?.W2AGENT_URL, ["${{", "inputs.url", "}}"].join(" "));
    } finally {
      delete globalThis.__w2agentPwned;
    }
  });
});

describe("README action ref (GHA-3)", () => {
  const version = JSON.parse(readFileSync(cliPkgPath, "utf8")).version;
  const readme = readFileSync(join(here, "..", "README.md"), "utf8");
  const expected = `w2agent/w2agent/packages/github-action@v${version}`;
  const refs = [...readme.matchAll(/uses:\s*(\S*github-action\S*)/g)].map((m) => m[1]);

  it("has action examples", () => {
    assert.ok(refs.length >= 5);
  });

  it("pins every uses: ref to the CLI version", () => {
    for (const ref of refs) assert.equal(ref, expected);
  });

  it("has no generate-action ref left", () => {
    assert.doesNotMatch(readme, /generate-action/);
  });

  it("has no uses: ref to w2agent other than the action", () => {
    for (const m of readme.matchAll(/uses:\s*(\S*w2agent\S*)/g)) assert.equal(m[1], expected);
  });
});

describe("CLI pin", () => {
  const version = JSON.parse(readFileSync(cliPkgPath, "utf8")).version;

  it("installs exactly w2agent@<cli package version>", () => {
    const run = step("Install w2agent").run;
    const v = version.replaceAll(".", "\\.");
    assert.match(run, new RegExp(`\\n\\s*else\\n\\s*npm install -g w2agent@${v}\\n\\s*fi\\s*$`));
  });

  it("skips the registry install only for an exact pinned-version match", () => {
    const run = step("Install w2agent").run;
    assert.match(
      run,
      new RegExp(
        `V=\\$\\(w2agent --version[^)]*\\) && \\[\\[ "\\$V" == "${version.replaceAll(".", "\\.")}" \\]\\]`,
      ),
    );
  });

  it("has no unpinned w2agent install anywhere", () => {
    assert.doesNotMatch(raw, /npm install -g w2agent(?!@)/);
    for (const m of raw.matchAll(/npm install -g w2agent@(\d+\.\d+\.\d+\S*?)\)?[\s."]/g)) {
      assert.equal(m[1], version);
    }
  });
});

describe("Install w2agent skips the registry when the pinned CLI is already on PATH", () => {
  const version = JSON.parse(readFileSync(cliPkgPath, "utf8")).version;
  const run = step("Install w2agent").run;
  const install = (w2agentBody) => {
    const d = mkdtempSync(join(stubDir, "inst-"));
    const log = join(d, "npm.log");
    writeFileSync(join(d, "npm"), `#!/bin/bash\necho "$*" >> "${log}"\n`, { mode: 0o755 });
    if (w2agentBody !== null)
      writeFileSync(join(d, "w2agent"), `#!/bin/bash\n${w2agentBody}\n`, { mode: 0o755 });
    const r = runLive({ run }, {}, { path: `${d}:/usr/bin:/bin` });
    let calls = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n");
    } catch {}
    return { ...r, calls };
  };

  it("skips npm when w2agent --version prints the pinned version", () => {
    const r = install(`echo ${version}`);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, []);
    assert.match(r.out, /already on PATH/);
  });

  it("installs the pin when w2agent prints another version", () => {
    const r = install("echo 9.9.9");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, [`install -g w2agent@${version}`]);
  });

  it("does not accept a version that merely contains the pin", () => {
    const r = install(`echo ${version}-beta.1`);
    assert.deepEqual(r.calls, [`install -g w2agent@${version}`]);
  });

  it("installs the pin when w2agent is not on PATH", () => {
    const r = install(null);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, [`install -g w2agent@${version}`]);
  });

  it("installs the pin when w2agent --version fails", () => {
    const r = install(`echo ${version}; exit 1`);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, [`install -g w2agent@${version}`]);
  });
});

describe("Action test workflow runs the checked-out CLI", () => {
  const wf = parse(
    readFileSync(join(here, "..", "..", "..", ".github", "workflows", "github-action.yml"), "utf8"),
  );
  const version = JSON.parse(readFileSync(cliPkgPath, "utf8")).version;
  const paths = wf.on.pull_request.paths;

  it("triggers on CLI, core and lockfile changes", () => {
    for (const p of [
      "packages/cli/**",
      "packages/core/**",
      "pnpm-lock.yaml",
      "tsconfig.base.json",
    ]) {
      assert.ok(paths.includes(p), p);
    }
  });

  for (const [name, job] of Object.entries(wf.jobs)) {
    describe(`job ${name}`, () => {
      const idx = job.steps.findIndex((x) => x.uses === "./packages/github-action");
      const before = job.steps.slice(0, idx);
      const find = (re) => before.find((x) => re.test(x.run ?? ""));

      it("uses the local action", () => {
        assert.ok(idx > 0);
      });

      it("builds and installs the checked-out CLI before the action", () => {
        assert.ok(before.some((x) => /^pnpm\/action-setup@/.test(x.uses ?? "")));
        assert.ok(find(/pnpm install --frozen-lockfile/));
        assert.ok(find(/pnpm .*build/));
        const inst = find(/npm install --prefix/);
        assert.ok(inst, "non-global npm install of the packed tarballs");
        assert.match(inst.run, /pnpm --dir packages\/core pack/);
        assert.match(inst.run, /pnpm --dir packages\/cli pack/);
        assert.match(inst.run, /\$RUNNER_TEMP/);
        assert.match(inst.run, /node_modules\/\.bin" >> "\$GITHUB_PATH"/);
        assert.doesNotMatch(inst.run, /npm install -g|\$\{\{/);
        assert.ok(before.indexOf(inst) > before.indexOf(find(/pnpm .*build/)));
      });

      it("asserts the CLI on PATH reports the package version", () => {
        const chk = find(/w2agent --version/);
        assert.ok(chk);
        assert.ok(before.indexOf(chk) > before.indexOf(find(/npm install --prefix/)));
        assert.match(chk.run, /packages\/cli\/package\.json/);
      });

      it("has no npm published gate and no step depends on one", () => {
        assert.doesNotMatch(JSON.stringify(job), /npm view|steps\.published|published=/);
      });
    });
  }

  describe("a pull request reaches the action from exactly one job", () => {
    const admits = (expr, ev) => {
      const model = {
        "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository":
          (e) => e.name !== "pull_request" || e.headRepo === e.repo,
        "github.event_name != 'pull_request'": (e) => e.name !== "pull_request",
      };
      assert.ok(model[expr], `unmodelled job if: ${expr}`);
      return model[expr](ev);
    };
    const reaches = (ev) =>
      Object.entries(wf.jobs)
        .filter(([, job]) => job.steps.some((x) => x.uses === "./packages/github-action"))
        .filter(([, job]) => admits(job.if, ev))
        .map(([name]) => name);

    it("runs one job on a same-repo pull_request", () => {
      assert.equal(reaches({ name: "pull_request", headRepo: "o/r", repo: "o/r" }).length, 1);
    });

    it("runs no job on a fork pull_request", () => {
      assert.deepEqual(reaches({ name: "pull_request", headRepo: "f/r", repo: "o/r" }), []);
    });

    it("runs both jobs on workflow_dispatch", () => {
      assert.deepEqual(reaches({ name: "workflow_dispatch", repo: "o/r" }).sort(), [
        "audit-only",
        "full",
      ]);
    });
  });

  it("keeps the pin equal to the CLI version the workflow asserts", () => {
    assert.match(step("Install w2agent").run, new RegExp(`"${version.replaceAll(".", "\\.")}"`));
  });
});

function parseRunner(out) {
  const commands = [];
  const stopped = [];
  let token = null;
  for (const line of out.split(/\r?\n/)) {
    if (token !== null) {
      if (line.startsWith(`::${token}::`)) token = null;
      else if (line.startsWith("::")) stopped.push(line);
      continue;
    }
    if (!line.startsWith("::")) {
      if (line.includes("##[")) commands.push(line);
      continue;
    }
    const m = /^::stop-commands::(.*)$/.exec(line);
    if (m) {
      token = m[1];
      commands.push("stop-commands");
      continue;
    }
    commands.push(line);
  }
  return { commands, stopped, live: token === null };
}

function parseStreams(stdout, stderr) {
  const r = parseRunner(stdout);
  const late = stderr.split(/\r?\n/).filter((l) => l.startsWith("::") || l.includes("##["));
  return { ...r, commands: [...r.commands, ...late], stderrCommands: late, out: stdout + stderr };
}

function runLive(s, env, { path, files } = {}) {
  let body = s.run;
  for (const [from, to] of files ?? []) body = body.replaceAll(from, to);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", body], {
    env: { PATH: path ?? process.env.PATH, ...s.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status, ...parseStreams(r.stdout, r.stderr) };
}

const HOSTILE = [
  "\n::warning::INJ",
  "\r\n::add-mask::x",
  "%0A::warning::INJ",
  "x\n::stop-commands::abc\n::error::INJ",
  "80%0D%0A::warning::INJ",
];

const stubDir = mkdtempSync(join(tmp, "stub-"));
const stubAt = (name, body) => {
  const d = mkdtempSync(join(stubDir, `${name}-`));
  writeFileSync(join(d, "w2agent"), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return `${d}:${process.env.PATH}`;
};
const echoStub = (exit, trailingNewline = true) =>
  stubAt(
    `echo${exit}${trailingNewline}`,
    `for a in "$@"; do printf 'bad option "%s"' "$a" >&2; ${trailingNewline ? "echo >&2;" : ""} done\nprintf '%s' 'tail ::warning::NOEOL'\nexit ${exit}`,
  );
const cliDist = join(here, "..", "..", "cli", "dist", "index.js");
const realCliPath = () => {
  const d = mkdtempSync(join(stubDir, "real-"));
  writeFileSync(join(d, "w2agent"), `#!/bin/bash\nexec "${process.execPath}" "${cliDist}" "$@"\n`, {
    mode: 0o755,
  });
  return `${d}:${process.env.PATH}`;
};
const auditEnv = (over) => ({ URL: "http://127.0.0.1:1/", MAX_PAGES: "20", ...over });

describe("Workflow-command injection", () => {
  it("harness: a command is live outside stop-commands, inert inside", () => {
    const r = parseRunner("::warning::a\n::stop-commands::T\n::warning::b\n::T::\n::error::c\n");
    assert.deepEqual(r.commands, ["::warning::a", "stop-commands", "::error::c"]);
    assert.deepEqual(r.stopped, ["::warning::b"]);
  });

  it("harness: a legacy ## [ command is live outside the window on a non-:: line, inert inside", () => {
    const legacy = "##[warning]X";
    const r = parseRunner(
      `Attempting to download 20${legacy}\n::stop-commands::T\nv${legacy}\n::T::\nplain\n`,
    );
    assert.deepEqual(r.commands, [`Attempting to download 20${legacy}`, "stop-commands"]);
    assert.deepEqual(parseRunner("a#b x[1] #[x]\n").commands, []);
    const s = parseStreams("ok\n", `err ${legacy}\n`);
    assert.deepEqual(s.stderrCommands, [`err ${legacy}`]);
    assert.deepEqual(s.commands, [`err ${legacy}`]);
  });

  for (const h of HOSTILE) {
    it(`Validate inputs escapes threshold ${JSON.stringify(h)}`, () => {
      const r = runLive(step("Validate inputs"), { THRESHOLD: h });
      assert.equal(r.code, 1);
      assert.equal(r.commands.length, 1, r.out);
      assert.match(r.commands[0], /^::error::Input 'threshold' must be/);
      assert.ok(
        r.commands[0].includes(
          h.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A"),
        ),
      );
    });

    it(`Check threshold escapes threshold ${JSON.stringify(h)} when validation is skipped`, () => {
      const s = step("Check threshold");
      const file = join(tmp, `inj-${n++}.json`);
      writeFileSync(file, '{"overallScore":10}');
      const r = runLive(s, { THRESHOLD: h }, { files: [[AUDIT_JSON, file]] });
      assert.equal(r.code, 1);
      assert.equal(r.commands.length, 1, r.out);
      assert.match(
        r.commands[0],
        /^::error::Input .threshold. must be an integer from 0 to 100; got/,
      );
    });

    it(`Check threshold, invariant (passes on base; jq renders the newline as \\n): hostile score ${JSON.stringify(h)}`, () => {
      const s = step("Check threshold");
      const file = join(tmp, `inj-${n++}.json`);
      writeFileSync(file, JSON.stringify({ overallScore: `9${h}` }));
      const r = runLive(s, { THRESHOLD: "80" }, { files: [[AUDIT_JSON, file]] });
      assert.equal(r.code, 1);
      assert.equal(r.commands.length, 1, r.out);
    });

    for (const [label, exit] of [
      ["CLI failure", 3],
      ["CLI success", 0],
    ]) {
      it(`Run audit, ${label}: url ${JSON.stringify(h)} yields only the action's own commands`, () => {
        const r = runLive(step("Run audit"), auditEnv({ URL: h }), { path: echoStub(exit) });
        assert.equal(r.code, exit === 0 ? 0 : 1, r.out);
        assert.equal(r.live, true, "commands resumed");
        const expected = exit === 0 ? ["stop-commands"] : ["stop-commands", "error"];
        assert.deepEqual(
          r.commands.map((c) => (c.startsWith("::error::w2agent audit failed for ") ? "error" : c)),
          expected,
          r.out,
        );
      });

      it(`Run audit, ${label}: max-pages ${JSON.stringify(h)} cannot inject through CLI output`, () => {
        const r = runLive(step("Run audit"), auditEnv({ MAX_PAGES: h }), {
          path: echoStub(exit, false),
        });
        assert.equal(r.live, true);
        assert.deepEqual(
          r.commands.filter(
            (c) => c !== "stop-commands" && !c.startsWith("::error::w2agent audit failed"),
          ),
          [],
          r.out,
        );
      });

      it(`Generate, ${label}: formats ${JSON.stringify(h)} cannot inject`, () => {
        const r = runLive(
          step("Generate agent assets"),
          { URL: "http://127.0.0.1:1/", OUTPUT_DIR: "o", FORMATS: h, MAX_PAGES: "5" },
          { path: echoStub(exit, false) },
        );
        assert.equal(r.code, exit);
        assert.equal(r.live, true);
        assert.deepEqual(r.commands, ["stop-commands"], r.out);
      });
    }
  }

  it("CLI stderr cannot escape the stop window (runner reads stdout and stderr on separate pipes)", () => {
    for (const nl of [true, false]) {
      for (const exit of [0, 3]) {
        const p = stubAt(
          `err${nl}${exit}`,
          `printf '::warning::STDERR-INJ${nl ? "\\n" : ""}' >&2\nprintf 'x::warning::OUT\\n::warning::OUT2\\n'\nexit ${exit}`,
        );
        const r = runLive(step("Run audit"), auditEnv(), { path: p });
        assert.equal(r.stderrCommands.length, 0, r.out);
        assert.equal(r.live, true);
        assert.ok(!r.commands.some((c) => /INJ|OUT/.test(c) && !c.startsWith("::error::")), r.out);
        const g = runLive(
          step("Generate agent assets"),
          { URL: "http://127.0.0.1:1/", OUTPUT_DIR: "o", FORMATS: "all", MAX_PAGES: "5" },
          { path: p },
        );
        assert.equal(g.stderrCommands.length, 0, g.out);
        assert.deepEqual(g.commands, ["stop-commands"], g.out);
      }
    }
  });

  describe("Validate inputs rejects line breaks in every input that reaches a third-party step", () => {
    const base = {
      URL: "https://example.com/",
      THRESHOLD: "80",
      MAX_PAGES: "20",
      FORMATS: "all",
      OUTPUT_DIR: ".w2agent/",
      NODE_VERSION: "20",
    };
    const names = {
      URL: "url",
      THRESHOLD: "threshold",
      MAX_PAGES: "max-pages",
      FORMATS: "formats",
      OUTPUT_DIR: "output-dir",
      NODE_VERSION: "node-version",
    };
    it("accepts clean values for all six", () => {
      assert.equal(runLive(step("Validate inputs"), base).code, 0);
    });
    it("takes all six from env, not from an expression", () => {
      const s = step("Validate inputs");
      for (const k of Object.keys(base)) assert.match(s.env[k], /^\$\{\{ inputs\.[\w-]+ \}\}$/);
    });
    for (const [k, name] of Object.entries(names)) {
      for (const h of [...HOSTILE, "x\r::warning::INJ"]) {
        const expectAccept = !/[\r\n]/.test(h) && k !== "THRESHOLD";
        it(`${expectAccept ? "accepts" : "rejects"} ${name} ${JSON.stringify(h)}`, () => {
          const r = runLive(step("Validate inputs"), { ...base, [k]: h });
          if (expectAccept) {
            assert.equal(r.code, 0, "a literal %0A is not a line break");
            return;
          }
          assert.equal(r.code, 1, r.out);
          assert.equal(r.commands.length, 1, r.out);
          assert.match(r.commands[0], /^::error::Input '[\w-]+' must/);
          assert.equal(r.stderrCommands.length, 0);
        });
      }
    }
  });

  describe("Validate inputs rejects the legacy ## [ workflow command in every input", () => {
    const base = {
      URL: "https://example.com/",
      THRESHOLD: "80",
      MAX_PAGES: "20",
      FORMATS: "all",
      OUTPUT_DIR: ".w2agent/",
      NODE_VERSION: "20",
    };
    const names = {
      URL: "url",
      THRESHOLD: "threshold",
      MAX_PAGES: "max-pages",
      FORMATS: "formats",
      OUTPUT_DIR: "output-dir",
      NODE_VERSION: "node-version",
    };
    const LEGACY = "##[warning]INJECTED";
    const runSteps = (env) => {
      const ran = [];
      for (const s of steps) {
        ran.push(s.name);
        if (typeof s.run !== "string") continue;
        const r = runLive(s, env);
        if (r.code !== 0) return { ran, r };
        break;
      }
      return { ran, r: undefined };
    };
    for (const [k, name] of Object.entries(names)) {
      it(`rejects ${name} with a constant error and runs nothing after`, () => {
        for (const v of [`20${LEGACY}`, LEGACY, `${LEGACY}\n`.slice(0, -1), "x##[", "##[##["]) {
          const { ran, r } = runSteps({ ...base, [k]: v });
          assert.deepEqual(ran, ["Validate inputs"]);
          assert.equal(r.code, 1, r.out);
          assert.equal(r.commands.length, 1, r.out);
          assert.match(r.commands[0], new RegExp(`^::error::Input '${name}' must not contain`));
          assert.ok(!r.out.includes("##["), `no ## [ in the step log: ${r.out}`);
          assert.doesNotMatch(r.out, /INJECTED/);
          assert.equal(r.live, true);
        }
      });
      it(`accepts ${name} with a lone # or [`, () => {
        for (const v of ["a#b", "x[1]", "#[x]", "a##b", "[##]", "#"]) {
          if (k === "THRESHOLD") continue;
          const r = runLive(step("Validate inputs"), { ...base, [k]: v });
          assert.equal(r.code, 0, `${name} ${v}: ${r.out}`);
        }
      });
    }
    it("a line break value that also holds ## [ gets the same constant error", () => {
      const r = runLive(step("Validate inputs"), { ...base, NODE_VERSION: `20\n${LEGACY}` });
      assert.equal(r.code, 1);
      assert.equal(r.commands.length, 1, r.out);
      assert.ok(!r.out.includes("##["));
    });
    it("no earlier Validate line echoes a raw value", () => {
      const lines = step("Validate inputs").run.split("\n");
      const first = lines.findIndex((l) => l.includes("nohash url"));
      assert.ok(first > 0);
      for (const l of lines.slice(0, first)) {
        assert.doesNotMatch(
          l,
          /\$\{?(THRESHOLD|URL|MAX_PAGES|FORMATS|OUTPUT_DIR|NODE_VERSION)\b/,
          l,
        );
      }
    });
  });

  it("the stop token is random per run and long", () => {
    const tokens = new Set();
    for (let i = 0; i < 4; i++) {
      const r = runLive(step("Run audit"), auditEnv(), { path: echoStub(0) });
      tokens.add(/::stop-commands::(\S+)/.exec(r.out)[1]);
    }
    assert.equal(tokens.size, 4);
    for (const t of tokens) assert.match(t, /^[0-9a-f]{64}$/);
  });

  it("a CLI that guesses/echoes stop and resume lines cannot resume early", () => {
    const p = stubAt(
      "guess",
      "echo '::warning::early'; echo '::abc::'; echo '::warning::after-guess'; exit 1",
    );
    const r = runLive(step("Run audit"), auditEnv(), { path: p });
    assert.deepEqual(
      r.commands.map((c) => c.slice(0, 31)),
      ["stop-commands", "::error::w2agent audit failed for"].map((c) =>
        c === "stop-commands" ? c : c.slice(0, 31),
      ),
    );
  });

  it("Parse audit results escapes score and grade in the notice and rejects multi-line values", () => {
    const s = step("Parse audit results");
    const out = join(tmp, `gh-output-${n}`);
    const run = (auditObj) => {
      const file = join(tmp, `parse-${n++}.json`);
      writeFileSync(file, JSON.stringify(auditObj));
      writeFileSync(out, "");
      return runLive(
        s,
        { URL: "https://www.example.com:8443/x", GITHUB_OUTPUT: out },
        { files: [[AUDIT_JSON, file]] },
      );
    };
    const ok = run({ overallScore: 90, grade: "A" });
    assert.equal(ok.code, 0, ok.out);
    assert.deepEqual(ok.commands, ["::notice::w2agent audit complete — score: 90/100, grade: A"]);
    assert.equal(
      readFileSync(out, "utf8"),
      "score=90\ngrade=A\nbadge-url=https://w2agent.dev/api/sites/example-com/badge.svg\n",
    );
    for (const h of HOSTILE) {
      const r = run({ overallScore: 90, grade: `A${h}` });
      const multiline = /[\r\n]/.test(h);
      assert.equal(r.code, multiline ? 1 : 0, r.out);
      assert.equal(r.commands.length, 1, r.out);
      assert.match(r.commands[0], multiline ? /^::error::/ : /^::notice::/);
      assert.doesNotMatch(readFileSync(out, "utf8"), /\n(?!grade=|badge-url=)[^\n]*(INJ|add-mask)/);
    }
  });

  it("escapes % first so a literal %0A stays literal", () => {
    const r = runLive(step("Validate inputs"), { THRESHOLD: "%0A::warning::X" });
    assert.match(r.out, /got '%250A::warning::X'/);
  });

  it("no input-derived value is echoed raw in a workflow command", () => {
    for (const s of steps.filter((x) => typeof x.run === "string")) {
      for (const line of s.run
        .split("\n")
        .filter((l) => l.includes("::error::") || l.includes("::notice::"))) {
        assert.doesNotMatch(
          line.replaceAll(/\$\(esc "[^"]*"\)/g, ""),
          /\$(\{)?(THRESHOLD|URL|MAX_PAGES|FORMATS|OUTPUT_DIR)\b/,
          line,
        );
      }
    }
  });

  describe("with the real built CLI", () => {
    const built = (() => {
      try {
        readFileSync(cliDist);
        return true;
      } catch {
        return false;
      }
    })();

    for (const [label, mk] of [
      ["audit --depth", (h) => [step("Run audit"), auditEnv({ MAX_PAGES: h })]],
      [
        "generate --format",
        (h) => [
          step("Generate agent assets"),
          {
            URL: "http://127.0.0.1:1/",
            OUTPUT_DIR: join(tmp, "gen-out"),
            FORMATS: h,
            MAX_PAGES: "5",
          },
        ],
      ],
    ]) {
      for (const h of [
        "1\n::warning::INJECTED-B",
        "llms-txt\r\n::add-mask::x",
        "1%0A::warning::INJ",
      ]) {
        it(`${label} ${JSON.stringify(h)}: CLI echoes raw, action neutralises it and resumes${/[\r\n]/.test(h) ? "" : " (invariant: a literal %0A is not a newline; passes on base)"}`, {
          skip: !built && "CLI not built",
        }, () => {
          const [s, env] = mk(h);
          const r = runLive(s, env, { path: realCliPath() });
          assert.notEqual(r.code, 0, r.out);
          assert.equal(r.live, true);
          if (/[\r\n]/.test(h)) {
            assert.ok(
              r.stopped.length > 0,
              `the CLI's injected line sits inside the window\n${r.out}`,
            );
            assert.equal(r.stderrCommands.length, 0, `no stderr line escapes the window\n${r.out}`);
          }
          assert.ok(
            r.commands.every(
              (c) => c === "stop-commands" || c.startsWith("::error::w2agent audit failed"),
            ),
            r.out,
          );
          assert.match(r.out, /INJ|add-mask/, "the CLI did echo the hostile text (premise)");
        });
      }
    }

    it("real CLI success: generate against a loopback site, then commands are live again", {
      skip: !built && "CLI not built",
    }, async () => {
      const SERVER = `const s=require("http").createServer((q,r)=>{r.setHeader("content-type","text/html");r.end("<html><head><title>T</title></head><body><h1>Hi</h1><p>x</p></body></html>")});s.listen(0,"127.0.0.1",()=>console.log(s.address().port))`;
      const TIMEOUT_MS = 30000;
      const srv = spawn(process.execPath, ["-e", SERVER], { stdio: ["ignore", "pipe", "pipe"] });
      let child;
      const timers = [];
      const guard = (ms, what, kill) =>
        new Promise((_, rej) => {
          const t = setTimeout(() => {
            kill?.();
            rej(new Error(`timed out after ${ms}ms waiting for ${what}`));
          }, ms);
          timers.push(t);
        });
      let srvErr = "";
      srv.stderr.on("data", (d) => {
        srvErr += d;
      });
      try {
        const port = await Promise.race([
          new Promise((res, rej) => {
            srv.stdout.once("data", (d) => res(String(d).trim()));
            srv.once("error", (e) =>
              rej(new Error(`loopback server failed to start: ${e.message}`)),
            );
            srv.once("exit", (c, sig) =>
              rej(new Error(`loopback server exited (${c ?? sig}) before listening: ${srvErr}`)),
            );
          }),
          guard(TIMEOUT_MS, "the loopback server port"),
        ]);
        const s = step("Generate agent assets");
        const env = {
          ...s.env,
          URL: `http://127.0.0.1:${port}/`,
          OUTPUT_DIR: join(tmp, "gen-ok"),
          FORMATS: "llms-txt",
          MAX_PAGES: "2",
        };
        child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", s.run], {
          env: { PATH: realCliPath(), ...env },
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => {
          out += d;
        });
        child.stderr.on("data", (d) => {
          err += d;
        });
        const code = await Promise.race([
          new Promise((res, rej) => {
            child.once("error", (e) => rej(new Error(`step failed to run: ${e.message}`)));
            child.once("close", res);
          }),
          guard(TIMEOUT_MS, `the step to finish\n${out}${err}`, () => child.kill("SIGKILL")),
        ]);
        assert.equal(code, 0, out + err);
        const r = parseStreams(out, err);
        assert.deepEqual(r.commands, ["stop-commands"], out);
        assert.equal(r.live, true);
        assert.match(out, /llms\.txt/);
      } finally {
        for (const t of timers) clearTimeout(t);
        if (child && child.exitCode === null) child.kill("SIGKILL");
        if (srv.exitCode === null) srv.kill("SIGKILL");
      }
    });

    it("real CLI against an unreachable loopback URL: the action's ::error:: is live afterwards", {
      skip: !built && "CLI not built",
    }, () => {
      const r = runLive(
        step("Run audit"),
        auditEnv({ URL: "http://127.0.0.1:1/\n::warning::INJ" }),
        {
          path: realCliPath(),
        },
      );
      assert.equal(r.code, 1, r.out);
      assert.equal(r.live, true);
      assert.equal(r.commands.length, 2, r.out);
      assert.match(
        r.commands[1],
        /^::error::w2agent audit failed for http:\/\/127\.0\.0\.1:1\/%0A::warning::INJ\./,
      );
    });
  });
});
