import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, home: string): Promise<Run> {
  return runWith(args, cwd, home, {});
}

function runWith(
  args: string[],
  cwd: string,
  home: string,
  extraEnv: Record<string, string>,
): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
  for (const name of ["AI_AGENT", "CLAUDECODE", "CODEX_CI"]) delete env[name];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

interface SchemaOption {
  long: string | null;
  takesValue: boolean;
}
interface SchemaCommand {
  name: string;
  arguments?: { name: string }[];
  options?: SchemaOption[];
  commands?: SchemaCommand[];
}

interface Leaf {
  path: string[];
  positionals: string[];
  valueOptions: string[];
  hasJson: boolean;
}

function leaves(cmd: SchemaCommand, path: string[], out: Leaf[]): void {
  if (cmd.commands && cmd.commands.length > 0) {
    for (const sub of cmd.commands) leaves(sub, [...path, sub.name], out);
    return;
  }
  const options = cmd.options ?? [];
  out.push({
    path,
    positionals: (cmd.arguments ?? []).map((a) => (a.name === "url" ? "http://127.0.0.1:1" : "x")),
    valueOptions: options
      .filter((o) => o.takesValue && o.long && o.long !== "--api-key" && o.long !== "--token")
      .map((o) => o.long as string),
    hasJson: options.some((o) => o.long === "--json"),
  });
}

const CANARY = "CANARY7f3a91c2";
const SECRET_FLAGS = ["--api-key", "--token"];

function secretForms(): string[][] {
  const forms: string[][] = [];
  for (const flag of SECRET_FLAGS) {
    forms.push([`${flag}=${CANARY}`]);
    forms.push([flag, CANARY]);
  }
  return forms;
}

describe("secret values never reach stdout or stderr", () => {
  let allLeaves: Leaf[] = [];
  let cwd = "";
  let home = "";

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "w2agent-redact-cwd-"));
    home = mkdtempSync(join(tmpdir(), "w2agent-redact-home-"));
    const schema = await run(["schema", "--json"], cwd, home);
    const root = JSON.parse(schema.stdout) as { commands: SchemaCommand[] };
    for (const c of root.commands) leaves(c, [c.name], allLeaves);
    allLeaves = allLeaves.filter((l) => l.path[0] !== "schema");
  });

  it("covers every command in the schema", () => {
    expect(allLeaves.length).toBeGreaterThanOrEqual(9);
    expect(allLeaves.some((l) => l.path.join(" ") === "agent deploy")).toBe(true);
    expect(allLeaves.some((l) => l.valueOptions.length > 0)).toBe(true);
  });

  it("sweeps every value-taking option with both secret flags in both spellings", async () => {
    const cases: { label: string; args: string[] }[] = [];
    for (const leaf of allLeaves) {
      const base = [...leaf.path, ...leaf.positionals];
      for (const secret of secretForms()) {
        cases.push({ label: [...base, ...secret].join(" "), args: [...base, ...secret] });
        for (const opt of leaf.valueOptions) {
          // The option swallows the secret flag as its value, or sits before a valid value.
          cases.push({
            label: [...base, opt, ...secret].join(" "),
            args: [...base, opt, ...secret],
          });
          cases.push({
            label: [...base, ...secret, opt].join(" "),
            args: [...base, ...secret, opt],
          });
          cases.push({
            label: [...base, opt, "bogus", ...secret].join(" "),
            args: [...base, opt, "bogus", ...secret],
          });
          if (leaf.hasJson) {
            cases.push({
              label: [...base, "--json", opt, ...secret].join(" "),
              args: [...base, "--json", opt, ...secret],
            });
          }
        }
        if (leaf.hasJson) {
          cases.push({
            label: [...base, "--json", ...secret].join(" "),
            args: [...base, "--json", ...secret],
          });
        }
      }
    }
    expect(cases.length).toBeGreaterThan(150);

    const leaked: string[] = [];
    const queue = [...cases];
    const worker = async () => {
      for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
        const r = await run(c.args, cwd, home);
        if (r.stdout.includes(CANARY) || r.stderr.includes(CANARY)) leaked.push(c.label);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    expect(leaked).toEqual([]);
  }, 600_000);

  it("redacts the reported repro cases", async () => {
    const a = await run(
      ["generate", "http://127.0.0.1:1", "--format", `--api-key=${CANARY}`],
      cwd,
      home,
    );
    expect(a.stderr).toContain("took a secret flag");
    expect(a.stderr).not.toContain(CANARY);
    const b = await run(
      ["agent", "deploy", "http://127.0.0.1:1", "--self-host", `--token=${CANARY}`],
      cwd,
      home,
    );
    expect(b.stderr).toContain("took a secret flag");
    expect(b.stderr).not.toContain(CANARY);
  });

  it("leaves help and schema output untouched", async () => {
    const schemaPlain = await run(["schema", "--json"], cwd, home);
    const schemaShort = await run(["schema"], cwd, home);
    expect(schemaPlain.stdout).toBe(schemaShort.stdout);
    expect(schemaPlain.stdout).toContain('"--token <token>"');
    expect(schemaPlain.stdout).toContain('"--api-key <key>"');
    expect(schemaPlain.stdout).not.toContain("<api-key>");

    const probes = [["login"], ["agent", "update"], ["deploy"], ["audit"]];
    for (const p of probes) {
      const plain = await run([...p, "--help"], cwd, home);
      const withSecret = await run([...p, "--help", `--token=${CANARY}`], cwd, home);
      expect(plain.code).toBe(0);
      expect(withSecret.stdout).toBe(plain.stdout);
      expect(withSecret.stderr).toBe(plain.stderr);
    }
    const login = await run(["login", "--help"], cwd, home);
    expect(login.stdout).toContain("--api-key <key>");
  });

  it("keeps the --json document valid when a secret value is a word in it", async () => {
    for (const word of ["false", "error", "message", "ok", "reason"]) {
      for (const args of [
        ["login", "--json", `--api-key=${word}`],
        ["integrate", "http://127.0.0.1:1", "--json", `--token=${word}`],
        ["audit", "http://127.0.0.1:1", "--json", "--token", word],
      ]) {
        const r = await run(args, cwd, home);
        const doc = JSON.parse(r.stdout) as { ok: boolean };
        expect(doc.ok, args.join(" ")).toBe(false);
      }
    }
  });

  it("never rewrites help text, even when a secret value is a word in it", async () => {
    const tokenHelp = await run(["agent", "update", "--help"], cwd, home);
    const withToken = await run(["agent", "update", "--help", "--token", "<token>"], cwd, home);
    expect(withToken.stdout).toBe(tokenHelp.stdout);
    expect(withToken.stdout).toContain("--token <token>");
    const loginHelp = await run(["login", "--help"], cwd, home);
    const withWord = await run(["login", "--help", "--api-key=Authenticate"], cwd, home);
    expect(withWord.stdout).toBe(loginHelp.stdout);
    expect(withWord.stdout).toContain("Authenticate");
  });

  it("scrubs a case-changed copy of the secret", async () => {
    const r = await run(["audit", "--output", "--api-key", "SECRETabc.Test"], cwd, home);
    expect((r.stdout + r.stderr).toLowerCase()).not.toContain("secretabc");
  });

  describe("a secret flag taken as an option value", () => {
    const cases: { label: string; args: string[]; canary: string }[] = [
      {
        label: "integrate --output --token=",
        args: [
          "integrate",
          "http://127.0.0.1:1",
          "--platform",
          "nextjs",
          "--output",
          "--token=CANARYxyz123",
        ],
        canary: "CANARYxyz123",
      },
      {
        label: "generate --output --token=",
        args: ["generate", "http://127.0.0.1:1", "--output", "--token=CANARYxyz123"],
        canary: "CANARYxyz123",
      },
      {
        label: "generate --output --api-key (space form)",
        args: ["generate", "http://127.0.0.1:1", "--output", "--api-key", "CANARYxyz123"],
        canary: "CANARYxyz123",
      },
      {
        label: "generate --format with a comma-split secret",
        args: ["generate", "http://127.0.0.1:1", "--format", "--api-key=w2a_CANARY123,XYZ"],
        canary: "CANARY123",
      },
      {
        label: "generate --format with a short secret",
        args: ["generate", "http://127.0.0.1:1", "--format", "--api-key=abcd"],
        canary: "abcd",
      },
    ];
    for (const c of cases) {
      for (const json of [false, true]) {
        it(`${c.label}${json ? " --json" : ""} exits 2 with no side effects`, async () => {
          const dir = mkdtempSync(join(tmpdir(), "w2agent-redact-fresh-"));
          const r = await run(json ? [...c.args, "--json"] : c.args, dir, home);
          expect(r.code).toBe(2);
          expect(readdirSync(dir)).toEqual([]);
          expect(r.stdout + r.stderr).not.toContain(c.canary);
          if (json) {
            const doc = JSON.parse(r.stdout) as { ok: boolean; error: { reason: string } };
            expect(doc.ok).toBe(false);
            expect(doc.error.reason).toBe("invalid_argument");
          } else {
            expect(r.stderr).toMatch(/took a secret flag|too many arguments/);
            if (r.stderr.includes("took a secret flag")) {
              expect(r.stderr).toContain(
                "took a secret flag (--api-key/--token) as its value. Give",
              );
            }
          }
        });
      }
    }
  });

  it("prints the exact refusal text in human and JSON mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w2agent-redact-fresh-"));
    const args = [
      "integrate",
      "http://127.0.0.1:1",
      "--platform",
      "nextjs",
      "--output",
      "--token=CANARYxyz123",
    ];
    const human = await run(args, dir, home);
    expect(human.stderr.trim()).toBe(
      "error: --output took a secret flag (--api-key/--token) as its value. Give --output a value.",
    );
    const json = await run([...args, "--json"], dir, home);
    const doc = JSON.parse(json.stdout) as { error: { message: string } };
    expect(doc.error.message).toBe(
      "--output took a secret flag (--api-key/--token) as its value. Give --output a value.",
    );
  });

  it("redacts a secret that audit --json reports as the URL", async () => {
    const loader = join(tmpdir(), "w2agent-redact-fetch-stub.mjs");
    writeFileSync(
      loader,
      'globalThis.fetch = async () => new Response("<h1>x</h1>", { headers: { "content-type": "text/html" } });\n',
    );
    const dir = mkdtempSync(join(tmpdir(), "w2agent-redact-fresh-"));
    const r = await runWith(
      [
        "audit",
        "http://127.0.0.1/CANARY123",
        "--depth",
        "1",
        "-o",
        "--api-key=CANARY123",
        "-o",
        "",
        "--json",
      ],
      dir,
      home,
      { NODE_OPTIONS: `--import ${loader}` },
    );
    expect(r.stdout).not.toContain("CANARY123");
    expect((JSON.parse(r.stdout) as { url: string }).url).toBe("http://127.0.0.1/<api-key>");
  });
});
