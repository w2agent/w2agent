import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  process.env.AGENT_SURFACES_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const CLI = path.resolve(
  process.env.AGENT_SURFACES_CLI ?? path.join(ROOT, "packages/cli/dist/index.js"),
);

const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

const DOCS = [
  "README.md",
  "README_CN.md",
  "docs/AGENT-PLAYBOOK.md",
  "skills/w2agent/SKILL.md",
  "packages/cli/README.md",
];

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(m, "missing frontmatter between --- lines");
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return { fields, body: m[2] };
}

const skillDirs = readdirSync(path.join(ROOT, "skills")).filter((d) =>
  existsSync(path.join(ROOT, "skills", d, "SKILL.md")),
);

test("at least one skill exists", () => {
  assert.ok(skillDirs.length > 0);
});

for (const dir of skillDirs) {
  test(`skills/${dir}/SKILL.md follows the Agent Skills format`, () => {
    const { fields, body } = parseFrontmatter(read(`skills/${dir}/SKILL.md`));
    assert.equal(fields.name, dir, "name must equal the parent directory");
    assert.ok(fields.name.length >= 1 && fields.name.length <= 64, "name must be 1-64 chars");
    assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fields.description, "description must be non-empty");
    assert.ok(fields.description.length <= 1024, "description over 1024 chars");
    assert.ok(body.split("\n").length < 500, "body must be under 500 lines");
    assert.ok(!("allowed-tools" in fields), "allowed-tools is not allowed");
    assert.ok(!("hooks" in fields), "hooks is not allowed");
  });
}

const MANIFESTS = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "plugin.json"];

for (const rel of MANIFESTS) {
  test(`${rel} parses as JSON`, () => {
    assert.ok(existsSync(path.join(ROOT, rel)), `${rel} is missing`);
    assert.doesNotThrow(() => readJson(rel));
  });
}

test("marketplace plugins resolve to real plugin directories", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0);
  for (const entry of marketplace.plugins) {
    if (typeof entry.source !== "string") continue;
    assert.ok(entry.source.startsWith("./"), `source ${entry.source} must start with ./`);
    assert.ok(!entry.source.split("/").includes(".."), "source must not contain ..");
    const dir = path.resolve(ROOT, entry.source);
    assert.ok(dir === ROOT || dir.startsWith(ROOT + path.sep), "source escapes repo root");
    assert.ok(isDir(dir), `source ${entry.source} is not a directory`);
    const manifestPath = path.join(dir, ".claude-plugin/plugin.json");
    assert.ok(existsSync(manifestPath), `${entry.source} has no .claude-plugin/plugin.json`);
    const plugin = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(entry.name, plugin.name, "marketplace name must equal plugin name");

    const skillsDir = path.join(dir, "skills");
    assert.ok(isDir(skillsDir), `${entry.source} has no skills/ directory`);
    const found = readdirSync(skillsDir).filter((d) =>
      existsSync(path.join(skillsDir, d, "SKILL.md")),
    );
    assert.ok(found.length > 0, "plugin has no skills/<name>/SKILL.md");

    for (const key of ["skills", "commands", "agents", "hooks", "mcpServers"]) {
      const v = plugin[key];
      const paths =
        typeof v === "string"
          ? [v]
          : Array.isArray(v) && v.every((x) => typeof x === "string")
            ? v
            : [];
      for (const p of paths) {
        assert.ok(existsSync(path.resolve(dir, p)), `${key} path ${p} does not exist`);
      }
    }
    assert.ok(!("hooks" in plugin), "plugin.json must not declare hooks");
    assert.ok(!existsSync(path.join(dir, "hooks")), "plugin must not ship a hooks directory");
  }
});

test("root plugin.json follows Agent Plugins 1.0", () => {
  const p = readJson("plugin.json");
  assert.equal(p.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(typeof p.name, "string");
  assert.ok(p.name.length <= 64);
  assert.match(p.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  const allowed = new Set([
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ]);
  for (const k of Object.keys(p)) assert.ok(allowed.has(k), `unknown key ${k}`);
  if (p.author !== undefined) {
    const authorKeys = new Set(["name", "email", "url"]);
    for (const k of Object.keys(p.author)) {
      assert.ok(authorKeys.has(k), `unknown author key ${k}`);
    }
  }
  assert.equal(typeof p.repository, "string");
});

const version = readJson("packages/cli/package.json").version;

test("plugin manifests carry the CLI version", () => {
  assert.equal(readJson(".claude-plugin/plugin.json").version, version);
  assert.equal(readJson("plugin.json").version, version);
});

for (const rel of DOCS) {
  test(`${rel} pins the CLI version ${version}`, () => {
    const text = read(rel);
    assert.ok(text.includes(`w2agent@${version}`), `no w2agent@${version}`);
    const unpinned = text.match(/npx\s+(?:(?:-y|--yes)\s+)*w2agent(?=[\s"'`]|$)/m);
    assert.equal(unpinned, null, `unpinned npx invocation: ${unpinned?.[0]}`);
    for (const m of text.matchAll(/(?<![\w@/.-])w2agent@([^\s"'`),;\]]*)/g)) {
      if (m[1] === "w2agent") continue;
      assert.equal(m[1], version, `w2agent@${m[1]} differs from ${version}`);
    }
  });
}

function loadSchema() {
  if (!existsSync(CLI)) {
    assert.fail(`CLI not built at ${CLI}: run pnpm build first`);
  }
  return JSON.parse(execFileSync("node", [CLI, "schema"], { encoding: "utf8" }));
}

function codeSegments(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let pending = "";
  const prose = [];
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      if (inFence && pending) out.push(pending);
      pending = "";
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      prose.push(raw);
      continue;
    }
    if (/\\\s*$/.test(raw)) {
      pending += `${raw.replace(/\\\s*$/, "")} `;
      continue;
    }
    out.push(pending + raw);
    pending = "";
  }
  for (const line of prose) {
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return out;
}

const stripToken = (t) => t.replace(/^["'`(]+|["'`),;:]+$/g, "");
const isPlaceholder = (t) => /[<>[\]${}*]/.test(t);

function invocations(code) {
  const found = [];
  const noComment = code.replace(/(^|\s)#.*$/, "");
  for (const part of noComment.split(/\s(?:&&|\|\||\|)\s|;\s/)) {
    const tokens = part.trim().split(/\s+/).map(stripToken).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "w2agent") {
        found.push(tokens.slice(i + 1));
      } else if (t === "npx") {
        let j = i + 1;
        while (tokens[j] === "-y" || tokens[j] === "--yes") j++;
        if (tokens[j] === "w2agent" || tokens[j]?.startsWith("w2agent@")) {
          found.push(tokens.slice(j + 1));
          i = j;
        }
      } else if (t === "node" && tokens[i + 1]?.endsWith("packages/cli/dist/index.js")) {
        found.push(tokens.slice(i + 2));
        i += 1;
      }
    }
  }
  return found;
}

function flagsOf(cmd) {
  const set = new Set(["--help", "-h", "--version", "-V"]);
  for (const o of cmd.options ?? []) {
    if (o.long) set.add(o.long);
    if (o.short) set.add(o.short);
  }
  return set;
}

function checkInvocation(schema, args) {
  let cmd = schema;
  const trail = [];
  const flags = [];
  for (const raw of args) {
    if (raw === "--") break;
    if (raw.startsWith("-")) {
      if (!isPlaceholder(raw.split("=")[0])) flags.push(raw.split("=")[0]);
      continue;
    }
    if (isPlaceholder(raw)) continue;
    const sub = (cmd.commands ?? []).find((c) => c.name === raw);
    if (sub) {
      cmd = sub;
      trail.push(raw);
    } else if ((cmd.commands ?? []).length > 0) {
      return `unknown command "${[...trail, raw].join(" ")}"`;
    }
  }
  const known = flagsOf(cmd);
  for (const f of flags) {
    if (!known.has(f)) {
      return `flag ${f} not on "${trail.join(" ") || "w2agent"}"`;
    }
  }
  return null;
}

test("documented w2agent commands and flags exist in `w2agent schema`", () => {
  const schema = loadSchema();
  const problems = [];
  let checked = 0;
  for (const rel of DOCS) {
    for (const code of codeSegments(read(rel))) {
      for (const args of invocations(code)) {
        if (args.length === 0) continue;
        checked++;
        const problem = checkInvocation(schema, args);
        if (problem) problems.push(`${rel}: ${problem}: ${code.trim()}`);
      }
    }
  }
  assert.ok(checked > 0, "no w2agent invocations found in docs");
  assert.deepEqual(problems, []);
});

function allFlags(cmd, set = new Set()) {
  for (const f of flagsOf(cmd)) set.add(f);
  for (const c of cmd.commands ?? []) allFlags(c, set);
  return set;
}

const NON_W2AGENT_FLAGS = new Set(["--no", "-y", "-D"]);

function proseSpans(text) {
  const out = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of raw.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return out;
}

test("flags named in prose of the playbook and skill exist in `w2agent schema`", () => {
  const known = allFlags(loadSchema());
  const problems = [];
  for (const rel of ["docs/AGENT-PLAYBOOK.md", "skills/w2agent/SKILL.md"]) {
    for (const span of proseSpans(read(rel))) {
      for (const raw of span.split(/\s+/)) {
        const tok = stripToken(raw).split("=")[0];
        if (!/^--?[A-Za-z][\w-]*$/.test(tok) || isPlaceholder(tok)) continue;
        if (NON_W2AGENT_FLAGS.has(tok)) continue;
        if (!known.has(tok)) problems.push(`${rel}: unknown flag ${tok} in \`${span}\``);
      }
    }
  }
  assert.deepEqual(problems, []);
});

const isStr = (v) => typeof v === "string" && v.length > 0;
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

test("root plugin.json field types follow Agent Plugins 1.0", () => {
  const p = readJson("plugin.json");
  for (const k of ["name", "version", "description"])
    assert.ok(isStr(p[k]), `${k} must be a string`);
  for (const k of ["homepage", "repository", "license"]) {
    assert.ok(p[k] === undefined || isStr(p[k]), `${k} must be a string`);
  }
  if (p.author !== undefined) {
    assert.ok(isObj(p.author), "author must be an object");
    for (const [k, v] of Object.entries(p.author)) assert.equal(typeof v, "string", `author.${k}`);
  }
  if (p.keywords !== undefined) assert.ok(isStrArray(p.keywords), "keywords must be strings");
  if (p.extensions !== undefined) {
    assert.ok(isObj(p.extensions), "extensions must be an object");
    for (const [k, v] of Object.entries(p.extensions)) assert.ok(isObj(v), `extensions.${k}`);
  }
});

test(".claude-plugin manifests have the expected field types", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  for (const k of ["name", "version", "description"]) assert.ok(isStr(plugin[k]), `plugin ${k}`);
  assert.ok(plugin.keywords === undefined || isStrArray(plugin.keywords), "plugin keywords");
  const market = readJson(".claude-plugin/marketplace.json");
  assert.ok(isStr(market.name), "marketplace name");
  assert.ok(isObj(market.owner) && isStr(market.owner.name), "marketplace owner.name");
  assert.ok(Array.isArray(market.plugins), "marketplace plugins must be an array");
  for (const entry of market.plugins) {
    assert.ok(isStr(entry.name), "marketplace entry name");
    assert.ok(isStr(entry.source), "marketplace entry source");
  }
});

const CORE = path.resolve(
  process.env.AGENT_SURFACES_CORE ?? path.join(ROOT, "packages/core/dist/index.js"),
);
const GUIDE_DIR = "skills/w2agent/references/checks";
const GUIDE_SECTIONS = [
  "Passes when",
  "Who fixes it",
  "Fix (any framework)",
  "Next.js (App Router)",
  "Pitfalls",
  "Verify",
];

function readGuides() {
  return readdirSync(path.join(ROOT, GUIDE_DIR))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const text = read(`${GUIDE_DIR}/${file}`);
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      assert.ok(m, `${file}: missing front matter`);
      const checks = [
        ...(m[1].match(/^checks:\s*\r?\n((?:\s+-\s+\S+\r?\n?)+)/m)?.[1] ?? "").matchAll(
          /-\s+(\S+)/g,
        ),
      ].map((x) => x[1]);
      const headings = [];
      let fenced = false;
      for (const line of text.split(/\r?\n/)) {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        else if (!fenced && line.startsWith("## ")) headings.push(line.slice(3).trim());
      }
      return {
        file,
        id: m[1].match(/^id:\s*(\S+)\s*$/m)?.[1],
        fixBy: m[1].match(/^fixBy:\s*(\S+)\s*$/m)?.[1],
        checks,
        headings,
      };
    });
}

test("fix guides follow the guide file contract", () => {
  const guides = readGuides();
  assert.ok(guides.length > 0, "no guides found");
  for (const g of guides) {
    assert.equal(g.id, g.file.slice(0, -3), `${g.file}: id must equal the file name`);
    assert.ok(["agent", "owner", "integrate"].includes(g.fixBy), `${g.file}: fixBy ${g.fixBy}`);
    assert.ok(g.checks.length > 0, `${g.file}: checks is empty`);
    const expected = GUIDE_SECTIONS.filter(
      (s) => s !== "Next.js (App Router)" || g.headings.includes(s),
    );
    assert.deepEqual(g.headings, expected, `${g.file}: sections out of contract order`);
  }
});

test("guide map, guide files and the audit registry agree", async () => {
  const { CHECK_GUIDES, GUIDES, allChecks, allAdapters, getSiteTypeChecks } = await import(CORE);
  const siteTypes = ["ecommerce", "local-business"];
  const registry = new Set(
    [
      ...allChecks,
      ...allAdapters().flatMap((a) => a.checks),
      ...siteTypes.flatMap((t) => getSiteTypeChecks(t)),
    ].map((c) => c.id),
  );
  for (const id of ["nextjs-well-known-served", "local-business-nap-structured"]) {
    assert.ok(registry.has(id), `registry is missing ${id}`);
  }
  const guides = readGuides();
  const byId = new Map(guides.map((g) => [g.id, g]));

  for (const [checkId, guideId] of Object.entries(CHECK_GUIDES)) {
    const g = byId.get(guideId);
    assert.ok(g, `map sends ${checkId} to missing guide ${guideId}`);
    assert.ok(g.checks.includes(checkId), `guide ${guideId} does not list ${checkId}`);
  }
  for (const g of guides) {
    for (const checkId of g.checks) {
      assert.ok(registry.has(checkId), `guide ${g.id} lists unknown check ${checkId}`);
      assert.equal(
        CHECK_GUIDES[checkId],
        g.id,
        `check ${checkId} of guide ${g.id} is not in the map`,
      );
    }
  }
  assert.deepEqual(
    GUIDES.map((g) => ({ id: g.id, checks: g.checks, fixBy: g.fixBy })),
    guides.map((g) => ({ id: g.id, checks: g.checks, fixBy: g.fixBy })),
    "built core bundles guides that differ from the files; run pnpm build",
  );
});
