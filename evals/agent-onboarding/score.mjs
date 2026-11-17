#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildEnv, waitForExit } from "./run.mjs";

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
  const lineNos = [];
  let bad = 0;
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
      lineNos.push(i + 1);
    } catch {
      bad++;
    }
  });
  return { events, bad, lineNos };
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

// Walks a shell string once, tracking quotes and backslash escapes. `onChar`
// sees each character with `quoted` true inside quotes or after a backslash.
function scanQuotes(str, onChar) {
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < str.length) {
        onChar(ch, true, i);
        onChar(str[++i], true, i);
      } else {
        onChar(ch, ch !== quote, i);
        if (ch === quote) quote = null;
      }
    } else if (ch === "\\" && i + 1 < str.length) {
      onChar(ch, true, i);
      onChar(str[++i], true, i);
    } else {
      onChar(ch, false, i);
      if (ch === "'" || ch === '"') quote = ch;
    }
  }
}

export function segmentsOf(command) {
  const str = unwrapShell(command);
  const out = [];
  let cur = "";
  let skip = 0;
  scanQuotes(str, (ch, quoted, i) => {
    if (skip > 0) {
      skip--;
      return;
    }
    if (!quoted) {
      const two = str.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        out.push(cur);
        cur = "";
        skip = 1;
        return;
      }
      if (ch === ";" || ch === "|" || ch === "\n") {
        out.push(cur);
        cur = "";
        return;
      }
    }
    cur += ch;
  });
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function tokensOf(segment) {
  const tokens = [];
  let cur = "";
  let has = false;
  const flush = () => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  scanQuotes(segment, (ch, quoted) => {
    if (!quoted && (ch === "'" || ch === '"')) {
      has = true;
    } else if (!quoted && /\s/.test(ch)) {
      flush();
    } else {
      cur += ch;
      has = true;
    }
  });
  flush();
  return tokens.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

// Drops `VAR=val` and the wrappers timeout/env/command/corepack so t[0] is the real verb.
function stripWrappers(tokens) {
  let t = tokens;
  for (;;) {
    if (t.length === 0) return t;
    if (ENV_ASSIGN.test(t[0])) {
      t = t.slice(1);
    } else if (t[0] === "command" || t[0] === "corepack") {
      t = t.slice(1);
    } else if (t[0] === "env") {
      t = t.slice(1);
      while (t.length && t[0].startsWith("-")) t = t.slice(1);
    } else if (t[0] === "timeout") {
      t = t.slice(1);
      while (t.length && t[0].startsWith("-")) t = t.slice(["-k", "-s"].includes(t[0]) ? 2 : 1);
      if (t.length && DURATION.test(t[0])) t = t.slice(1);
    } else {
      return t;
    }
  }
}

const VALUE_FLAGS = new Set([
  "-C",
  "--dir",
  "--prefix",
  "--cwd",
  "--filter",
  "-F",
  "--registry",
  "--cache",
  "--workspace",
  "--userconfig",
  "--store-dir",
]);
const DIR_FLAGS = new Set(["-C", "--dir", "--prefix", "--cwd"]);

// Splits args into positionals, `--package` values and directory-flag values.
function scanArgs(tokens, extraValueFlags = [], pkgFlags = ["--package"]) {
  const positionals = [];
  const pkgs = [];
  const dirs = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") continue;
    if (!t.startsWith("-")) {
      positionals.push(t);
      continue;
    }
    const eq = t.indexOf("=");
    const flag = eq < 0 ? t : t.slice(0, eq);
    const value = eq < 0 ? undefined : t.slice(eq + 1);
    if (pkgFlags.includes(flag)) {
      const v = value ?? tokens[++i];
      if (v) pkgs.push(v);
    } else if (VALUE_FLAGS.has(flag) || extraValueFlags.includes(flag)) {
      const v = value ?? tokens[++i];
      if (v !== undefined && DIR_FLAGS.has(flag)) dirs.push(v);
    }
  }
  return { positionals, pkgs, dirs };
}

const LOCAL_SPEC = /^(?:\.{0,2}\/|file:|link:|~|\$)|\.(?:tgz|tar\.gz|zip)$/;
const NAME_SPEC = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@[^\s/]+)?$/;

export function isW2agentPackage(spec) {
  if (LOCAL_SPEC.test(spec) || !NAME_SPEC.test(spec)) return false;
  return /w2agent/i.test(spec.replace(/(?<=.)@[^/]*$/, ""));
}

const PROBE_SUBS = new Set(["view", "info", "show", "v", "search"]);
const INSTALL_SUBS = new Set(["i", "install", "add"]);

// Classifies one segment's tokens (wrappers already stripped).
// -> { probe, targets: w2agent package names installed/exec'd, bare: dependency-driven install }
function classify(t) {
  const none = { probe: false, targets: [], bare: false };
  const verb = t[0];
  if (verb === "npx" || verb === "bunx") {
    const a = scanArgs(t.slice(1), [], ["--package", "-p"]);
    return { ...none, targets: [...a.pkgs, ...a.positionals.slice(0, 1)].filter(isW2agentPackage) };
  }
  if (!["npm", "pnpm", "yarn", "bun"].includes(verb)) return none;
  const a = scanArgs(t.slice(1));
  const sub = a.positionals[0];
  if (PROBE_SUBS.has(sub) && verb !== "yarn") return { ...none, probe: true };
  if (verb === "yarn" && sub === "info") return { ...none, probe: true };
  const rest = a.positionals.slice(1);
  const execSub = ["dlx", "exec", "x"].includes(sub);
  if (execSub) {
    return { ...none, targets: [...a.pkgs, ...rest.slice(0, 1)].filter(isW2agentPackage) };
  }
  const isInstall = INSTALL_SUBS.has(sub) || (verb === "yarn" && sub === undefined);
  if (!isInstall) return none;
  const targets = rest.filter(isW2agentPackage);
  return { ...none, targets, bare: rest.length === 0 && (verb !== "yarn" || sub !== "add") };
}

export function isInstallOfW2agentPackage(command) {
  return segmentsOf(command).some((s) => classify(stripWrappers(tokensOf(s))).targets.length > 0);
}

const RAW_CAP = 50;
const NPM404_RE = /E404|ERR_PNPM_FETCH_404|npm error 404|npm ERR! 404/;
const HTTP404_RE = /HTTP\/[\d.]+ 404|\b404 Not Found/;
const flat = (s) => s.replace(/\s+/g, " ").trim();

function* stringsOf(v, path = "") {
  if (typeof v === "string") yield [path, v];
  else if (Array.isArray(v)) for (const x of v) yield* stringsOf(x, path);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) yield* stringsOf(x, path ? `${path}.${k}` : k);
}

// Pieces of one event: { source, text, command?, authored }. Authored text is what the
// agent wrote (tool inputs, codex commands); results and file contents it read are not.
function* rawPieces(e, harness, names, seen, done) {
  const loose = () => stringsOf(e);
  if (harness === "claude") {
    if (!Array.isArray(e.message?.content)) {
      for (const [k, text] of loose()) yield { source: `${e.type}.${k}`, text, authored: false };
      return;
    }
    const blocks = e.message.content;
    for (const b of blocks) {
      if (b?.type === "tool_use") {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        const command = typeof b.input?.command === "string" ? b.input.command : undefined;
        names.set(b.id, { name: b.name, command });
        for (const [k, text] of stringsOf(b.input))
          yield { source: `tool_use:${b.name}.${k}`, text, command, authored: true };
      } else if (b?.type === "tool_result") {
        const c = names.get(b.tool_use_id);
        for (const [, text] of stringsOf(b.content))
          yield {
            source: `tool_result:${c?.name ?? "?"}`,
            text,
            command: c?.command,
            authored: false,
          };
      } else {
        for (const [k, text] of stringsOf(b))
          yield { source: `${e.type}.${k || "text"}`, text, authored: false };
      }
    }
    return;
  }
  const started = e.type === "item.started" && e.item;
  if (!started && !(e.type === "item.completed" && e.item)) {
    for (const [k, text] of loose()) yield { source: `${e.type}.${k}`, text, authored: false };
    return;
  }
  const it = e.item;
  if (started && (!it.id || done.has(it.id) || it.type !== "command_execution")) return;
  if (it.id) {
    if (seen.has(it.id)) return;
    seen.add(it.id);
  }
  if (it.type === "command_execution") {
    if (typeof it.command === "string")
      yield {
        source: "command_execution.command",
        text: it.command,
        command: it.command,
        authored: true,
      };
    if (!started && typeof it.aggregated_output === "string")
      yield {
        source: "command_execution.output",
        text: it.aggregated_output,
        command: it.command,
        authored: false,
      };
    return;
  }
  for (const [k, text] of stringsOf(it)) yield { source: `${it.type}.${k}`, text, authored: false };
}

const SHELL_LEAD = /^\s*(?:(?:if|then|elif|else|while|until|do)\s+|!\s+|[A-Za-z_]\w*=\S*\s*)/;
const mentionsInstall = (line) =>
  isInstallOfW2agentPackage(line) ||
  line.split(/\$\(|`|[()"']/).some((piece) => {
    let q = piece;
    for (let m = SHELL_LEAD.exec(q); m; m = SHELL_LEAD.exec(q)) q = q.slice(m[0].length);
    return isInstallOfW2agentPackage(q);
  });

// Advisory scan of the raw JSONL for npm/HTTP 404 signatures and for install/exec
// mentions in agent-authored text. A human classifies each hit.
export function scanRawTranscript(text, harness) {
  const { events, bad, lineNos } = parseLines(text);
  const out = { badLines: bad, counts: { npm404: 0, http404: 0, installMentions: 0 } };
  const lists = { npm404: [], http404: [], installMentions: [] };
  const add = (kind, hit) => {
    out.counts[kind]++;
    if (lists[kind].length < RAW_CAP) lists[kind].push(hit);
  };
  const names = new Map();
  const seen = new Set();
  const done = new Set(
    events.filter((e) => e.type === "item.completed" && e.item?.id).map((e) => e.item.id),
  );
  events.forEach((e, i) => {
    for (const p of rawPieces(e, harness, names, seen, done)) {
      const base = { line: lineNos[i], source: p.source, command: p.command };
      const snip = (str, m) =>
        flat(str.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80));
      const n = NPM404_RE.exec(p.text);
      if (n) add("npm404", { ...base, snippet: snip(p.text, n) });
      for (const l of p.text.split("\n")) {
        const m = HTTP404_RE.exec(l);
        if (m && !NPM404_RE.test(l)) {
          add("http404", { ...base, snippet: snip(l, m) });
          break;
        }
      }
      if (!p.authored) continue;
      for (const l of p.text.split("\n")) {
        if (mentionsInstall(l)) add("installMentions", { ...base, text: flat(l).slice(0, 200) });
      }
    }
  });
  return { ...out, ...lists };
}

const count404 = (out) => {
  const codes = (out.match(/\bE404\b|ERR_PNPM_FETCH_404/g) ?? []).length;
  return codes || (E404_RE.test(out) ? 1 : 0);
};
const namesW2agent404 = (out) => out.split("\n").some((l) => E404_RE.test(l) && /w2agent/i.test(l));

// Install/exec commands naming a w2agent package (or a bare install whose 404 names one).
// A segment after a probe (`npm view`) only counts when the output holds more 404s than
// the probes before it can explain.
export function findUnpublishedAttempts(calls) {
  const hits = [];
  for (const c of calls) {
    if (!c.command) continue;
    const out = c.output ?? "";
    const n404 = count404(out);
    if (n404 === 0) continue;
    let probes = 0;
    for (const seg of segmentsOf(c.command)) {
      const k = classify(stripWrappers(tokensOf(seg)));
      if (k.probe) {
        probes++;
      } else if (n404 > probes && (k.targets.length > 0 || (k.bare && namesW2agent404(out)))) {
        hits.push(c.command);
        break;
      }
    }
  }
  return hits;
}

// Walks a call's segments tracking cwd. A cd that the output reports as failed
// leaves the cwd unchanged. Segments carry the cwd they start in.
function failedCdTargets(output) {
  const failed = new Set();
  const res = [
    /\bcd:(?:cd:\d+:)?\s*(?:no such file or directory|not a directory|permission denied):?\s*(.+)$/gim,
    /\bcd: (.+?): (?:no such file or directory|not a directory|permission denied)/gim,
  ];
  for (const re of res)
    for (const m of (output ?? "").matchAll(re))
      failed.add(m[1].trim().replace(/^['"]|['"]$/g, ""));
  return failed;
}

function resolveCwd(cwd, target) {
  if (!target || target.startsWith("~") || target.startsWith("$")) return null;
  if (target.startsWith("/")) return path.posix.resolve(target);
  return cwd == null ? null : path.posix.resolve(cwd, target);
}

function analyzeCall(call, startCwd) {
  const failed = failedCdTargets(call.output);
  let cwd = startCwd;
  const segments = [];
  for (const raw of segmentsOf(call.command)) {
    const tokens = stripWrappers(tokensOf(raw));
    segments.push({ raw, tokens, cwd });
    if (tokens[0] === "cd" || tokens[0] === "pushd") {
      const target = tokens.slice(1).find((x) => !x.startsWith("-"));
      if (target === "-") continue;
      if (target !== undefined && failed.has(target)) continue;
      cwd = target === undefined ? null : resolveCwd(cwd, target);
    }
  }
  return { segments, cwd };
}

const isShellCall = (c) => c.command && (c.name === "Bash" || c.name === "command_execution");

// ---------- baseline comparison ----------

export const isReplaced = (ratio) => ratio < REPLACED_THRESHOLD;

const CODE_WORDS = new Set([
  "return",
  "export",
  "default",
  "const",
  "let",
  "var",
  "import",
  "from",
  "function",
  "type",
  "interface",
  "async",
  "await",
  "else",
  "null",
  "true",
  "false",
]);

// A line carries content when it still has >= 2 words of 3+ letters once tags,
// punctuation and JS keywords are gone. Structural lines (`}`, `);`, `<p>`) do not.
const isContentLine = (line) =>
  (line.replace(/<[^>]*>/g, " ").match(/[A-Za-z]{3,}/g) ?? []).filter(
    (w) => !CODE_WORDS.has(w.toLowerCase()),
  ).length >= 2;

// Share of the original's content lines that survive in the current file.
// Falls back to every non-empty line when the original has no content lines.
export function replacedRatio(original, current) {
  const lines = (t) =>
    t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const all = lines(original);
  const content = all.filter(isContentLine);
  const orig = content.length > 0 ? content : all;
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

export function trackedFiles(dir) {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(
      `git ls-files failed in ${dir}: ${r.error?.message ?? ((r.stderr || "").trim() || `exit ${r.status}`)}`,
    );
  }
  const files = r.stdout.split("\0").filter(Boolean);
  if (files.length === 0) throw new Error(`no git-tracked files in ${dir}`);
  return files;
}

export function compareToBaseline(baselineDir, siteDir, files = trackedFiles(baselineDir)) {
  const deleted = [];
  const replaced = [];
  for (const rel of files) {
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

function isOutsideTarget(target, cwd, workspace) {
  if (!target || DEV_NULLS.has(target)) return false;
  if (/^(?:~|\$\{?(?:HOME|TMPDIR)\b)/.test(target)) return true;
  if (target.startsWith("$")) return false;
  const abs = resolveCwd(cwd, target);
  return abs != null && !isInside(abs, workspace);
}

const REDIRECT = /(?<![<>&\d])(?:\d?>>?|&>>?)\s*(["']?)([^\s;&|)"']+)\1/dg;
const MASK = "\u0001";

// Redirect targets of a segment; `>` inside quotes or after a backslash is ignored.
function redirectTargets(raw) {
  let masked = "";
  scanQuotes(raw, (ch, quoted) => {
    masked += quoted ? MASK : ch;
  });
  return [...masked.matchAll(REDIRECT)].map((m) => raw.slice(...m.indices[2]));
}

// Positional arguments of a write verb that land on disk, or [].
function writeTargets(t) {
  const verb = t[0];
  const args = t.slice(1);
  if (verb === "tee") return scanArgs(args).positionals;
  if (verb === "rm") return scanArgs(args).positionals;
  if (verb === "mkdir") return scanArgs(args, ["-m"]).positionals;
  if (verb === "cp" || verb === "mv") return scanArgs(args, ["-t"]).positionals.slice(-1);
  if (verb === "sed" && args.some((x) => /^(?:--in-place|-[A-Za-z]*i)/.test(x))) {
    const a = scanArgs(args, ["-e", "-f", "--expression", "--file"]);
    const scripted = args.some((x) => ["-e", "-f", "--expression", "--file"].includes(x));
    return scripted ? a.positionals : a.positionals.slice(1);
  }
  return [];
}

const WRITE_VERB_KIND = { tee: "tee", rm: "rm", mkdir: "mkdir", cp: "cp", mv: "mv", sed: "sed-i" };

// Write-tool paths and shell writes / cd outside the workspace (advisory).
// Relative paths resolve against the tracked cwd.
export function containmentFlags(calls, workspace, { persistCwd = true } = {}) {
  const flags = [];
  let cwd = workspace;
  for (const c of calls) {
    if (WRITE_TOOLS.has(c.name) && c.filePath) {
      if (c.filePath.startsWith("/") && !isInside(c.filePath, workspace)) {
        flags.push({ kind: "write-tool", tool: c.name, target: c.filePath });
      }
    }
    if (c.name === "file_change") {
      for (const p of c.paths ?? []) {
        if (!isInside(p, workspace)) flags.push({ kind: "file-change", target: p });
      }
    }
    if (!isShellCall(c)) continue;
    if (!persistCwd) cwd = workspace;
    const a = analyzeCall(c, cwd);
    for (const seg of a.segments) {
      for (const target of redirectTargets(seg.raw)) {
        if (isOutsideTarget(target, seg.cwd, workspace))
          flags.push({ kind: "redirect", command: c.command, target });
      }
      const [verb] = seg.tokens;
      if (verb === "cd" || verb === "pushd") {
        const target = seg.tokens.slice(1).find((x) => !x.startsWith("-"));
        if (target && target !== "-" && isOutsideTarget(target, seg.cwd, workspace))
          flags.push({ kind: "cd", command: c.command, target });
      } else if (verb in WRITE_VERB_KIND) {
        for (const target of writeTargets(seg.tokens)) {
          if (isOutsideTarget(target, seg.cwd, workspace))
            flags.push({ kind: WRITE_VERB_KIND[verb], command: c.command, target });
        }
      }
    }
    cwd = a.cwd;
  }
  return flags;
}

// ---------- docs-only contamination ----------

const W2_COMPONENT = /(?:^|\/)w2agent(?:\/|$)/;
const BUILD_SUBCOMMANDS = new Set(["install", "i", "ci", "build", "add", "dlx", "exec"]);

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
    const a = analyzeCall(c, cwd);
    cwd = a.cwd;
    let flagged = false;
    for (const { tokens: t, cwd: segCwd } of a.segments) {
      const verb = t[0];
      if (!verb || verb === "cd" || verb === "pushd") continue;
      if (classify(t).targets.length > 0 || verb === "w2agent") {
        flagged = true;
        continue;
      }
      const inW2 = insideW2(segCwd, workspace);
      if ((W2_COMPONENT.test(verb) && verb.includes("/")) || (inW2 && verb.startsWith("./"))) {
        flagged = true;
        continue;
      }
      const pathArg = t.slice(1).some((x) => W2_COMPONENT.test(x));
      if (["pnpm", "npm", "yarn", "turbo", "npx", "bunx", "bun"].includes(verb)) {
        const args = scanArgs(t.slice(1));
        const dir = args.dirs.length ? resolveCwd(segCwd, args.dirs.at(-1)) : segCwd;
        if (!(insideW2(dir, workspace) || pathArg)) continue;
        const sub = args.positionals[0];
        const runBuild = sub === "run" && t.includes("build");
        const bareYarn = verb === "yarn" && sub === undefined;
        if (
          ["turbo", "npx", "bunx"].includes(verb) ||
          BUILD_SUBCOMMANDS.has(sub) ||
          runBuild ||
          bareYarn
        )
          flagged = true;
      } else if (["node", "tsx", "ts-node"].includes(verb)) {
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

// Process groups of the stage that is running now, killed on SIGINT/SIGTERM.
const activeGroups = new Set();

function runStage(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) activeGroups.add(child.pid);
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
    waitForExit(child).then(({ code, error }) => {
      clearTimeout(timer);
      activeGroups.delete(child.pid);
      if (error) return resolve({ ok: false, tail: `spawn error: ${error.message}` });
      const ok = code === 0 && !timedOut;
      resolve({ ok, tail: tail(timedOut ? `${buf}\n[timed out]` : buf) });
    });
  });
}

export async function waitForServer(port, child, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (child.exited) return false;
    try {
      const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function scoreSite(opts) {
  const onSignal = () => {
    for (const pid of activeGroups) killGroup(pid, "SIGKILL");
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await scoreSiteStages(opts);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

async function scoreSiteStages({ siteDir, cacheDir, cli, outDir, timeoutMs }) {
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
  activeGroups.add(server.pid);
  const stop = () => killGroup(server.pid, "SIGKILL");

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
    activeGroups.delete(server.pid);
  }
}

// ---------- report ----------

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

// HEAD of the checkout the --cli file lives in, and whether its packages/ has
// uncommitted changes (the scored CLI then differs from cliRef). null when not in a repo.
export function cliProvenance(cli) {
  const dir = path.dirname(cli);
  const head = git(dir, "rev-parse", "HEAD");
  if (head.status !== 0) return { cliRef: null, cliDirty: null };
  const top = git(dir, "rev-parse", "--show-toplevel");
  const status =
    top.status === 0 ? git(top.stdout.trim(), "status", "--porcelain", "--", "packages") : null;
  return {
    cliRef: head.stdout.trim(),
    cliDirty: status?.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

export function baselineDirFor(fixture) {
  if (!/^[A-Za-z0-9._-]+$/.test(fixture)) throw new Error("fixture must be a plain name");
  return path.join(HERE, "fixtures", fixture);
}

// Replaces the run dir, workspace and home prefixes in every string so result.json
// and summary.md carry no machine paths.
export function redactPaths(value, { runDir, workspace, home }) {
  const alias = (p) => (p.startsWith("/private/") ? [p, p.slice(8)] : [p, `/private${p}`]);
  const rules = [
    ...alias(workspace).map((p) => [p, "<workspace>"]),
    ...alias(runDir).map((p) => [p, "<run>"]),
    ...(home ? [[home, "~"]] : []),
  ].sort((a, b) => b[0].length - a[0].length);
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const res = rules.map(([p, to]) => [new RegExp(`${esc(p)}(?![A-Za-z0-9._-])`, "g"), to]);
  const walk = (v) => {
    if (typeof v === "string") return res.reduce((acc, [re, to]) => acc.replace(re, to), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
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
    if (t.rawScan)
      rows.push(
        ["raw npm404 (advisory)", String(t.rawScan.counts.npm404)],
        ["raw http404 (advisory)", String(t.rawScan.counts.http404)],
        ["raw install mentions (advisory)", String(t.rawScan.counts.installMentions)],
      );
    rows.push(["containment flags", String(t.containment.flags.length)]);
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
    const raw = r.transcript.rawScan;
    if (raw) {
      const at = (h) =>
        `line ${h.line} ${h.source}${h.command ? ` [${h.command.slice(0, 80)}]` : ""}`;
      list(
        "Raw npm404 hits (advisory; classify each)",
        raw.npm404.slice(0, 10).map((h) => `${at(h)}: \`${h.snippet}\``),
      );
      list(
        "Raw install mentions (advisory; classify each)",
        raw.installMentions.slice(0, 10).map((h) => `${at(h)}: \`${h.text}\``),
      );
    }
    list(
      "Containment flags",
      r.transcript.containment.flags.map((f) => `${f.kind}: ${f.target}`),
    );
    if (r.transcript.containment.note) lines.push("", `Note: ${r.transcript.containment.note}`);
    list("Docs-only violations", r.transcript.docsOnlyViolations);
  }
  return `${lines.join("\n")}\n`;
}

const CODEX_CONTAINMENT_NOTE =
  "codex sandbox limits writes to the workspace plus /tmp and $TMPDIR; flags are advisory";

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
  let runDir = null;
  let workspace = null;
  if (opts.baseline) {
    out = path.resolve(opts.out);
    const src = baselineDirFor(opts.fixture);
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
    runDir = path.resolve(opts.run);
    const runJsonPath = path.join(runDir, "run.json");
    if (!existsSync(runJsonPath)) throw new Error(`run.json not found in ${runDir}`);
    const run = JSON.parse(readFileSync(runJsonPath, "utf8"));
    out = path.resolve(opts.out ?? runDir);
    workspace = path.join(runDir, "workspace");
    siteDir = path.join(workspace, "site");
    cacheDir = path.join(workspace, ".cache");
    if (!existsSync(siteDir)) throw new Error(`site not found: ${siteDir}`);
    mkdirSync(out, { recursive: true });

    const baselineDir = baselineDirFor(run.fixture ?? "next-static");
    const baselineChanges = compareToBaseline(baselineDir, siteDir);
    const scripts = scriptsChanged(
      readIfExists(path.join(baselineDir, "package.json")),
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
        rawScan: scanRawTranscript(
          existsSync(tPath) ? readFileSync(tPath, "utf8") : "",
          run.harness,
        ),
        containment: {
          note: claude ? null : CODEX_CONTAINMENT_NOTE,
          flags: containmentFlags(parsed.calls, workspace, { persistCwd: claude }),
        },
        docsOnlyViolations:
          run.arm === "docs-only"
            ? docsOnlyViolations(parsed.calls, workspace, { persistCwd: claude })
            : null,
      },
    };
  }

  result.site = await scoreSite({ siteDir, cacheDir, cli, outDir: out, timeoutMs });
  result.scorer = { cli: path.relative(REPO_ROOT, cli), ...cliProvenance(cli) };
  result.overallScore = result.site.overallScore;
  result.grade = result.site.grade;

  const safe = redactPaths(result, {
    runDir: runDir ?? out,
    workspace: workspace ?? path.join(out, "workspace"),
    home: homedir(),
  });
  writeFileSync(path.join(out, "result.json"), `${JSON.stringify(safe, null, 2)}\n`);
  writeFileSync(path.join(out, "summary.md"), renderSummary(safe));
  console.log(out);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  });
}
