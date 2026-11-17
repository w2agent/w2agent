import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

describe("CLI pin", () => {
  const version = JSON.parse(readFileSync(cliPkgPath, "utf8")).version;

  it("installs exactly w2agent@<cli package version>", () => {
    const run = step("Install w2agent").run;
    assert.match(run, new RegExp(`npm install -g w2agent@${version.replaceAll(".", "\\.")}\\s*$`));
  });

  it("has no unpinned w2agent install anywhere", () => {
    assert.doesNotMatch(raw, /npm install -g w2agent(?!@)/);
    for (const m of raw.matchAll(/npm install -g w2agent@(\d+\.\d+\.\d+\S*?)\)?[\s."]/g)) {
      assert.equal(m[1], version);
    }
  });
});
