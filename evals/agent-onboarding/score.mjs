#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildEnv } from "./run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_CLI = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");

const USAGE = `Usage: node score.mjs --run <out-dir> [options]
       node score.mjs --baseline --fixture <name> --out <dir> [options]
  --run <dir>          run directory produced by run.mjs
  --cli <path>         CLI entry to audit with (default: this checkout's packages/cli/dist/index.js)
  --out <dir>          where to write result.json, summary.md, audit.json (default: the run dir)
  --timeout <minutes>  limit for each of install, build and server start (default 10)
  --baseline           score the pristine fixture with no transcript
  --fixture <name>     fixture for --baseline (default next-static)`;

const REPLACED_THRESHOLD = 0.2;
const PKG_RE = /^(?:w2agent|w2agent-core|@w2agent\/[A-Za-z0-9._-]+)(?:@[A-Za-z0-9._^~<>=*-]+)?$/;
const E404_RE = /E404|404 Not Found|ERR_PNPM_FETCH_404/i;
const DEV_NULLS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function parseArgs(argv) {
  const opts = {
    run: undefined,
    cli: DEFAULT_CLI,
    out: undefined,
    timeout: 10,
    baseline: false,
    fixture: "next-static",
  };
  const valueFlags = {
    "--run": "run",
    "--cli": "cli",
    "--out": "out",
    "--timeout": "timeout",
    "--fixture": "fixture",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--baseline") {
      opts.baseline = true;
    } else if (a in valueFlags) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      opts[valueFlags[a]] = v;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (opts.baseline) {
    if (!opts.out) throw new Error("--baseline needs --out");
    if (opts.run) throw new Error("--baseline and --run are exclusive");
  } else if (!opts.run) {
    throw new Error("--run <out-dir> is required");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(opts.fixture)) throw new Error("--fixture must be a plain name");
  const t = Number(opts.timeout);
  if (!Number.isFinite(t) || t <= 0)
    throw new Error("--timeout must be a positive number of minutes");
  opts.timeout = t;
  return opts;
}

// ---------- transcript parsing ----------

function toText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("\n");
  }
  return "";
}

function parseLines(text) {
  const events = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { events, bad };
}

// Returns { calls, cost, tokens, turns, badLines }.
// A call is { name, command?, filePath?, paths?, output, isError }.
export function parseTranscript(text, harness) {
  const { events, bad } = parseLines(text);
  const calls = [];
  let cost = null;
  let turns = null;
  let tokens = null;

  if (harness === "claude") {
    const byId = new Map();
    for (const e of events) {
      if (e.type === "assistant" && Array.isArray(e.message?.content)) {
        for (const b of e.message.content) {
          if (b?.type !== "tool_use" || byId.has(b.id)) continue;
          const input = b.input ?? {};
          const call = {
            name: b.name,
            command: typeof input.command === "string" ? input.command : undefined,
            filePath:
              typeof input.file_path === "string"
                ? input.file_path
                : typeof input.notebook_path === "string"
                  ? input.notebook_path
                  : undefined,
            output: "",
            isError: false,
          };
          byId.set(b.id, call);
          calls.push(call);
        }
      } else if (e.type === "user" && Array.isArray(e.message?.content)) {
        for (const b of e.message.content) {
          if (b?.type !== "tool_result") continue;
          const call = byId.get(b.tool_use_id);
          if (!call) continue;
          call.output = toText(b.content);
          call.isError = b.is_error === true;
        }
      } else if (e.type === "result") {
        if (typeof e.total_cost_usd === "number") cost = e.total_cost_usd;
        if (typeof e.num_turns === "number") turns = e.num_turns;
      }
    }
    return { calls, cost, tokens, turns, badLines: bad };
  }

  const seen = new Set();
  for (const e of events) {
    if (e.type === "item.completed" && e.item) {
      const it = e.item;
      if (it.id && seen.has(it.id)) continue;
      if (it.id) seen.add(it.id);
      if (it.type === "command_execution") {
        calls.push({
          name: "command_execution",
          command: it.command,
          output: it.aggregated_output ?? "",
          isError: typeof it.exit_code === "number" && it.exit_code !== 0,
        });
      } else if (it.type === "file_change") {
        calls.push({
          name: "file_change",
          paths: (it.changes ?? []).map((c) => c.path).filter(Boolean),
          output: "",
          isError: false,
        });
      } else if (it.type === "mcp_tool_call") {
        calls.push({ name: "mcp_tool_call", output: "", isError: it.status === "failed" });
      } else if (it.type === "web_search") {
        calls.push({ name: "web_search", output: "", isError: false });
      }
    } else if (e.type === "turn.completed" && e.usage) {
      tokens ??= { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
      tokens.input += e.usage.input_tokens ?? 0;
      tokens.cachedInput += e.usage.cached_input_tokens ?? 0;
      tokens.output += e.usage.output_tokens ?? 0;
      tokens.reasoning += e.usage.reasoning_output_tokens ?? 0;
    }
  }
  return { calls, cost, tokens, turns, badLines: bad };
}

export function countToolCalls(calls) {
  const byTool = {};
  for (const c of calls) byTool[c.name] = (byTool[c.name] ?? 0) + 1;
  return { total: calls.length, byTool };
}

// ---------- command analysis ----------

function unwrapShell(command) {
  const m = command.trim().match(/^\S*(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return m ? m[2] : command;
}

function segmentsOf(command) {
  return unwrapShell(command)
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokensOf(segment) {
  return segment
    .split(/\s+/)
    .map((t) => t.replace(/^['"(]+|['"()]+$/g, ""))
    .filter(Boolean);
}

const INSTALL_VERBS = new Map([
  ["npx", null],
  ["pnpm", new Set(["dlx", "add", "i", "install"])],
  ["yarn", new Set(["dlx", "add"])],
  ["npm", new Set(["i", "install", "add", "exec"])],
]);

function installTargets(segment) {
  const tokens = tokensOf(segment);
  const i = tokens.findIndex((t) => INSTALL_VERBS.has(t));
  if (i < 0) return [];
  const verbs = INSTALL_VERBS.get(tokens[i]);
  let rest = tokens.slice(i + 1);
  if (verbs) {
    const j = rest.findIndex((t) => verbs.has(t));
    if (j < 0) return [];
    rest = rest.slice(j + 1);
  }
  return rest.filter((t) => PKG_RE.test(t));
}

export function isInstallOfW2agentPackage(command) {
  return segmentsOf(command).some((s) => installTargets(s).length > 0);
}

// Install/exec commands naming a w2agent package whose output shows an npm 404.
export function findUnpublishedAttempts(calls) {
  const hits = [];
  for (const c of calls) {
    if (!c.command) continue;
    if (!isInstallOfW2agentPackage(c.command)) continue;
    if (E404_RE.test(c.output ?? "")) hits.push(c.command);
  }
  return hits;
}

// ---------- baseline comparison ----------

export const isReplaced = (ratio) => ratio < REPLACED_THRESHOLD;

export function replacedRatio(original, current) {
  const lines = (t) =>
    t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const orig = lines(original);
  if (orig.length === 0) return 1;
  const pool = new Map();
  for (const l of lines(current)) pool.set(l, (pool.get(l) ?? 0) + 1);
  let kept = 0;
  for (const l of orig) {
    const n = pool.get(l) ?? 0;
    if (n > 0) {
      kept++;
      pool.set(l, n - 1);
    }
  }
  return kept / orig.length;
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

export function compareToBaseline(baselineDir, siteDir) {
  const deleted = [];
  const replaced = [];
  for (const rel of walk(baselineDir)) {
    const now = path.join(siteDir, rel);
    if (!existsSync(now)) {
      deleted.push(rel);
      continue;
    }
    const ratio = replacedRatio(
      readFileSync(path.join(baselineDir, rel), "utf8"),
      readFileSync(now, "utf8"),
    );
    if (isReplaced(ratio)) replaced.push({ file: rel, kept: Number(ratio.toFixed(3)) });
  }
  return {
    deleted: deleted.sort(),
    replaced: replaced.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

// ---------- package.json scripts ----------

function readScripts(text) {
  if (text == null) return { error: "package.json missing" };
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    return { error: `package.json unparseable: ${e.message}` };
  }
  const s = pkg?.scripts;
  if (s == null) return { scripts: {} };
  if (typeof s !== "object" || Array.isArray(s))
    return { error: "package.json scripts is not an object" };
  return { scripts: s };
}

// Pure. Inputs are package.json file contents (null when the file is missing).
export function scriptsChanged(baselineText, siteText) {
  const out = { flagged: false, added: {}, removed: [], changed: [], error: null };
  const b = readScripts(baselineText);
  const s = readScripts(siteText);
  const error = s.error ?? (b.error ? `baseline ${b.error}` : null);
  if (error) return { ...out, flagged: true, error };
  for (const [name, cmd] of Object.entries(s.scripts)) {
    if (!(name in b.scripts)) out.added[name] = cmd;
    else if (b.scripts[name] !== cmd) out.changed.push({ name, from: b.scripts[name], to: cmd });
  }
  out.removed = Object.keys(b.scripts).filter((n) => !(n in s.scripts));
  out.flagged =
    Object.keys(out.added).length > 0 || out.changed.length > 0 || out.removed.length > 0;
  return out;
}

const readIfExists = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

// ---------- containment ----------

function normAlias(p) {
  return p.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, "");
}

export function isInside(p, workspace) {
  const ws = normAlias(path.posix.resolve(workspace));
  const target = normAlias(path.posix.resolve(ws, p));
  return target === ws || target.startsWith(`${ws}/`);
}

function isOutsideTarget(target, workspace) {
  if (!target) return false;
  if (DEV_NULLS.has(target)) return false;
  if (/^(?:~|\$\{?HOME\b)/.test(target)) return true;
  if (!target.startsWith("/")) return false;
  return !isInside(target, workspace);
}

// Claude only: write-tool paths and shell redirects / cd outside the workspace.
export function containmentFlags(calls, workspace) {
  const flags = [];
  for (const c of calls) {
    if (WRITE_TOOLS.has(c.name) && c.filePath) {
      if (c.filePath.startsWith("/") && !isInside(c.filePath, workspace)) {
        flags.push({ kind: "write-tool", tool: c.name, target: c.filePath });
      }
    }
    if (c.name === "Bash" && c.command) {
      for (const m of c.command.matchAll(/(?<![<>&\d])\d?>>?\s*(["']?)([^\s;&|)"']+)\1/g)) {
        if (isOutsideTarget(m[2], workspace))
          flags.push({ kind: "redirect", command: c.command, target: m[2] });
      }
      for (const seg of segmentsOf(c.command)) {
        const t = tokensOf(seg);
        if (t[0] === "cd" && t[1] && isOutsideTarget(t[1], workspace))
          flags.push({ kind: "cd", command: c.command, target: t[1] });
      }
    }
  }
  return flags;
}

// ---------- docs-only contamination ----------

const W2_COMPONENT = /(?:^|\/)w2agent(?:\/|$)/;
const BUILD_SUBCOMMANDS = new Set(["install", "i", "ci", "build", "add", "dlx", "exec"]);

function resolveCwd(cwd, target, workspace) {
  if (!target || target === "~") return null;
  if (target.startsWith("~")) return null;
  return path.posix.resolve(cwd ?? workspace, target);
}

function insideW2(cwd, workspace) {
  if (!cwd) return false;
  const w2 = `${normAlias(path.posix.resolve(workspace))}/w2agent`;
  const c = normAlias(cwd);
  return c === w2 || c.startsWith(`${w2}/`);
}

// Commands that install, build or run w2agent. Claude's shell keeps its cwd
// between calls (persistCwd); each codex command starts in the workspace.
export function docsOnlyViolations(calls, workspace, { persistCwd = true } = {}) {
  const hits = [];
  let cwd = workspace;
  for (const c of calls) {
    if (!c.command) continue;
    if (!persistCwd) cwd = workspace;
    let flagged = false;
    for (const seg of segmentsOf(c.command)) {
      const t = tokensOf(seg);
      if (t[0] === "cd") {
        cwd = resolveCwd(cwd, t[1], workspace);
        continue;
      }
      if (installTargets(seg).length > 0) {
        flagged = true;
        continue;
      }
      if (t[0] === "w2agent") {
        flagged = true;
        continue;
      }
      const inW2 = insideW2(cwd, workspace);
      const pathArg = t.slice(1).some((x) => W2_COMPONENT.test(x));
      if (["pnpm", "npm", "yarn", "turbo"].includes(t[0])) {
        const sub = t.slice(1).find((x) => !x.startsWith("-"));
        const runBuild = sub === "run" && t.includes("build");
        const isBuild = t[0] === "turbo" || BUILD_SUBCOMMANDS.has(sub) || runBuild;
        if (isBuild && (inW2 || pathArg)) flagged = true;
      } else if (t[0] === "node") {
        const script = t.slice(1).find((x) => !x.startsWith("-"));
        if (script && (/(?:^|\/)w2agent\/.*dist\//.test(script) || (inW2 && /dist\//.test(script))))
          flagged = true;
      }
    }
    if (flagged) hits.push(c.command);
  }
  return hits;
}

// ---------- site build, serve, audit ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const TAIL_CHARS = 2000;
const tail = (s) => (s.length > TAIL_CHARS ? s.slice(-TAIL_CHARS) : s).trim();

function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {}
}

function runStage(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const onData = (d) => {
      buf += d;
      if (buf.length > TAIL_CHARS * 4) buf = buf.slice(-TAIL_CHARS * 2);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, tail: `spawn error: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      killGroup(child.pid, "SIGKILL");
      const ok = code === 0 && !timedOut;
      resolve({ ok, tail: tail(timedOut ? `${buf}\n[timed out]` : buf) });
    });
  });
}

async function waitForServer(port, child, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (child.exited) return false;
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function scoreSite({ siteDir, cacheDir, cli, outDir, timeoutMs }) {
  mkdirSync(cacheDir, { recursive: true });
  const env = buildChildEnv(process.env, cacheDir);
  const fail = (stage, r) => ({ ok: false, stage, tail: r.tail, overallScore: null, grade: null });

  const install = await runStage(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: siteDir,
      env,
      timeoutMs,
    },
  );
  if (!install.ok) return fail("install", install);
  const build = await runStage("npm", ["run", "build"], { cwd: siteDir, env, timeoutMs });
  if (!build.ok) return fail("build", build);

  const port = await freePort();
  const server = spawn("npm", ["run", "start", "--", "-p", String(port)], {
    cwd: siteDir,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  const onData = (d) => {
    serverLog = (serverLog + d).slice(-TAIL_CHARS * 2);
  };
  server.stdout.on("data", onData);
  server.stderr.on("data", onData);
  server.on("exit", () => {
    server.exited = true;
  });
  server.on("error", (e) => {
    serverLog += `spawn error: ${e.message}`;
    server.exited = true;
  });
  const stop = () => killGroup(server.pid, "SIGKILL");
  const onSignal = () => {
    stop();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const up = await waitForServer(port, server, Math.min(timeoutMs, 60_000));
    if (!up) return fail("start", { tail: tail(serverLog) });

    const auditPath = path.join(outDir, "audit.json");
    const audit = await runStage(
      process.execPath,
      [cli, "audit", `http://localhost:${port}`, "-f", "json", "-o", auditPath],
      { cwd: siteDir, env, timeoutMs },
    );
    if (!audit.ok || !existsSync(auditPath)) return fail("audit", audit);
    let doc;
    try {
      doc = JSON.parse(readFileSync(auditPath, "utf8"));
    } catch (e) {
      return fail("audit", { tail: `audit.json is not valid JSON: ${e.message}` });
    }
    const categories = {};
    for (const c of doc.categories ?? []) categories[c.id] = c.score;
    return {
      ok: true,
      overallScore: doc.overallScore ?? null,
      grade: doc.grade ?? null,
      categories,
      pagesScanned: doc.pagesScanned ?? null,
      rubricVersion: doc.rubricVersion ?? null,
      port,
      serverPid: server.pid,
    };
  } finally {
    stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

// ---------- report ----------

function gitHead(cwd) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function renderSummary(r) {
  const site = r.site;
  const rows = [
    ["mode", r.mode],
    ["harness / arm", r.run ? `${r.run.harness} / ${r.run.arm}` : "-"],
    ["site", site.ok ? "ok" : `FAILED at ${site.stage}`],
    ["overall score", site.ok ? `${site.overallScore} (${site.grade})` : "null"],
  ];
  if (r.baselineChanges) {
    rows.push(
      ["baseline files deleted", String(r.baselineChanges.deleted.length)],
      ["baseline files replaced", String(r.baselineChanges.replaced.length)],
    );
  }
  if (r.scriptsChanged)
    rows.push(["package.json scripts changed", r.scriptsChanged.flagged ? "YES" : "no"]);
  if (r.transcript) {
    const t = r.transcript;
    rows.push(
      ["unpublished-package attempts", String(t.unpublishedAttempts.length)],
      ["tool calls", String(t.toolCalls.total)],
      ["wall time (s)", r.run ? String(Math.round(r.run.wallMs / 1000)) : "-"],
      ["cost / tokens", t.cost != null ? `$${t.cost.toFixed(2)}` : JSON.stringify(t.tokens)],
    );
    rows.push([
      "containment flags",
      t.containment.enforcedBy ? t.containment.enforcedBy : String(t.containment.flags.length),
    ]);
    if (t.docsOnlyViolations)
      rows.push(["docs-only violations", String(t.docsOnlyViolations.length)]);
  }
  const lines = ["| item | value |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v} |`)];
  const list = (title, items) => {
    if (!items?.length) return;
    lines.push("", `${title}:`, ...items.map((i) => `- ${i}`));
  };
  if (!site.ok)
    list("Site failure tail", [`\`${(site.tail ?? "").split("\n").slice(-5).join(" / ")}\``]);
  if (site.ok) {
    list(
      "Category scores",
      Object.entries(site.categories).map(([k, v]) => `${k}: ${v}`),
    );
  }
  if (r.baselineChanges) {
    list("Deleted baseline files", r.baselineChanges.deleted);
    list(
      "Replaced baseline files",
      r.baselineChanges.replaced.map((x) => `${x.file} (${Math.round(x.kept * 100)}% kept)`),
    );
  }
  if (r.scriptsChanged?.flagged) {
    const sc = r.scriptsChanged;
    list(
      "package.json scripts changed",
      sc.error
        ? [sc.error]
        : [
            ...Object.entries(sc.added).map(([n, c]) => `added ${n}: \`${c}\``),
            ...sc.changed.map((x) => `changed ${x.name}: \`${x.from}\` -> \`${x.to}\``),
            ...sc.removed.map((n) => `removed ${n}`),
          ],
    );
  }
  if (r.transcript) {
    list("Unpublished-package attempts", r.transcript.unpublishedAttempts);
    list(
      "Containment flags",
      r.transcript.containment.flags.map((f) => `${f.kind}: ${f.target}`),
    );
    list("Docs-only violations", r.transcript.docsOnlyViolations);
  }
  return `${lines.join("\n")}\n`;
}

const SITE_SKIP = new Set(["node_modules", ".next", "next-env.d.ts"]);

export async function main(argv = process.argv.slice(2)) {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) throw new Error(`Node >= 22 required (running ${process.version})`);

  const opts = parseArgs(argv);
  const cli = path.resolve(opts.cli);
  if (!existsSync(cli)) {
    throw new Error(`CLI not found at ${cli}. Build it first (pnpm build) or pass --cli <path>.`);
  }
  const timeoutMs = opts.timeout * 60_000;

  let out;
  let siteDir;
  let cacheDir;
  let result;
  if (opts.baseline) {
    out = path.resolve(opts.out);
    const src = path.join(HERE, "fixtures", opts.fixture);
    if (!existsSync(src)) throw new Error(`fixture not found: ${opts.fixture}`);
    siteDir = path.join(out, "site");
    cacheDir = path.join(out, ".cache");
    mkdirSync(out, { recursive: true });
    cpSync(src, siteDir, {
      recursive: true,
      filter: (p) => !SITE_SKIP.has(path.basename(p)),
    });
    result = { mode: "baseline", fixture: opts.fixture };
  } else {
    const runDir = path.resolve(opts.run);
    const runJsonPath = path.join(runDir, "run.json");
    if (!existsSync(runJsonPath)) throw new Error(`run.json not found in ${runDir}`);
    const run = JSON.parse(readFileSync(runJsonPath, "utf8"));
    out = path.resolve(opts.out ?? runDir);
    const workspace = path.join(runDir, "workspace");
    siteDir = path.join(workspace, "site");
    cacheDir = path.join(workspace, ".cache");
    if (!existsSync(siteDir)) throw new Error(`site not found: ${siteDir}`);
    mkdirSync(out, { recursive: true });

    const baselineChanges = compareToBaseline(path.join(runDir, "baseline"), siteDir);
    const scripts = scriptsChanged(
      readIfExists(path.join(runDir, "baseline", "package.json")),
      readIfExists(path.join(siteDir, "package.json")),
    );
    const tPath = path.join(runDir, "transcript.jsonl");
    const parsed = parseTranscript(
      existsSync(tPath) ? readFileSync(tPath, "utf8") : "",
      run.harness,
    );
    const claude = run.harness === "claude";
    result = {
      mode: "run",
      run,
      baselineChanges,
      scriptsChanged: scripts,
      transcript: {
        badLines: parsed.badLines,
        toolCalls: countToolCalls(parsed.calls),
        turns: parsed.turns,
        cost: parsed.cost,
        tokens: parsed.tokens,
        unpublishedAttempts: findUnpublishedAttempts(parsed.calls),
        containment: claude
          ? { enforcedBy: null, flags: containmentFlags(parsed.calls, workspace) }
          : { enforcedBy: "sandbox-enforced", flags: [] },
        docsOnlyViolations:
          run.arm === "docs-only"
            ? docsOnlyViolations(parsed.calls, workspace, { persistCwd: claude })
            : null,
      },
    };
  }

  result.site = await scoreSite({ siteDir, cacheDir, cli, outDir: out, timeoutMs });
  result.scorer = {
    cli: path.relative(REPO_ROOT, cli),
    cliRef: gitHead(REPO_ROOT),
  };
  result.overallScore = result.site.overallScore;
  result.grade = result.site.grade;

  writeFileSync(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(path.join(out, "summary.md"), renderSummary(result));
  console.log(out);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  });
}
