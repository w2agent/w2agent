import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateMcpServer } from "../src/generate/mcp-server.js";
import type { GenerateContext } from "../src/generate/types.js";

const SITE = "https://example.com";
const hasBash = spawnSync("bash", ["--version"]).status === 0;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const ctx: GenerateContext = {
  pages: [
    { url: `${SITE}/`, title: "Home", description: "", markdown: "hi" },
    { url: `${SITE}/faq`, title: "FAQ", description: "", markdown: "Q" },
  ],
  rawPages: [],
  metadata: { baseUrl: SITE, wellKnown: {} },
  baseUrl: SITE,
};

const files = generateMcpServer(ctx, "cf");
const content = (f: string) => files.find((x) => x.filename === `mcp-server/${f}`)?.content ?? "";
const kvKeys: string[] = JSON.parse(
  /const KV_KEYS = (\[.*?\]);/.exec(content("worker.ts"))?.[1] ?? "null",
);

interface Project {
  dir: string;
  log: string;
}

function project(opts: { id?: string; skipData?: string; toml?: string } = {}): Project {
  const dir = mkdtempSync(join(tmpdir(), "mcp-cf-setup-"));
  roots.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "proj/data"), { recursive: true });
  const log = join(dir, "npx.log");
  writeFileSync(
    join(dir, "bin/npx"),
    `#!/bin/bash\necho "$*" >> "$SHIM_LOG"\nexit "\${SHIM_EXIT:-0}"\n`,
  );
  chmodSync(join(dir, "bin/npx"), 0o755);
  let toml = content("wrangler.toml");
  if (opts.id) toml = toml.replace(/^# id = .*$/m, `id = "${opts.id}"`);
  writeFileSync(join(dir, "proj/wrangler.toml"), opts.toml ?? toml);
  writeFileSync(join(dir, "proj/setup.sh"), content("setup.sh"));
  for (const k of kvKeys)
    if (k !== opts.skipData) writeFileSync(join(dir, `proj/data/${k}.json`), "{}");
  return { dir, log };
}

function run(p: Project, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [join(p.dir, "proj/setup.sh"), ...args], {
    cwd: tmpdir(),
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${join(p.dir, "bin")}:${process.env.PATH}`,
      SHIM_LOG: p.log,
      ...env,
    },
  });
  const calls = existsSync(p.log) ? readFileSync(p.log, "utf-8").split("\n").filter(Boolean) : [];
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

const expected = (scope: string) =>
  kvKeys.map((k) => `wrangler kv key put --binding MCP_DATA ${k} --path data/${k}.json ${scope}`);

describe.skipIf(!hasBash)("generated cloudflare setup.sh", () => {
  it("is valid bash", () => {
    const p = project();
    expect(spawnSync("bash", ["-n", join(p.dir, "proj/setup.sh")]).status).toBe(0);
  });

  it("remote with an id: puts every key with --remote, from any cwd", () => {
    const p = project({ id: "abc123" });
    const r = run(p, []);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(expected("--remote"));
    expect(r.out).toContain("npx wrangler deploy");
  });

  it("--local: puts every key with --local, no id needed", () => {
    const p = project();
    const r = run(p, ["--local"]);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(expected("--local"));
    expect(r.out).toContain("npx wrangler dev");
    expect(r.out).not.toContain("wrangler deploy");
  });

  it("remote without an id fails before any upload and names the fix", () => {
    const p = project();
    const r = run(p, []);
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("kv namespace create");
  });

  it("a commented-out id line does not count as an id", () => {
    const p = project();
    expect(content("wrangler.toml")).toMatch(/^# id = /m);
    expect(run(p, []).status).not.toBe(0);
  });

  const head = 'name = "x"\nmain = "worker.ts"\n\n';
  const noId: Array<[string, string]> = [
    [
      "id only under another binding",
      `${head}[[kv_namespaces]]\nbinding = "OTHER"\nid = "abc"\n\n[[kv_namespaces]]\nbinding = "MCP_DATA"\n`,
    ],
    [
      "id only under an env table",
      `${head}[[kv_namespaces]]\nbinding = "MCP_DATA"\n\n[[env.staging.kv_namespaces]]\nbinding = "MCP_DATA"\nid = "abc"\n`,
    ],
    ["placeholder id", `${head}[[kv_namespaces]]\nbinding = "MCP_DATA"\nid = "..."\n`],
    ["empty single-quoted id", `${head}[[kv_namespaces]]\nbinding = "MCP_DATA"\nid = ''\n`],
    ["commented id", `${head}[[kv_namespaces]]\nbinding = "MCP_DATA"\n  # id = "abc"\n`],
  ];
  it.each(noId)("remote rejects: %s", (_n, toml) => {
    const r = run(project({ toml }), []);
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("kv namespace create");
    expect(r.out).toContain("kv namespace list");
  });

  const okId: Array<[string, string]> = [
    ["single-quoted id", `${head}[[kv_namespaces]]\nbinding = "MCP_DATA"\nid = 'abc'\n`],
    [
      "id before binding in the table",
      `${head}[[kv_namespaces]]\nid = "abc"\nbinding = 'MCP_DATA'\n`,
    ],
    [
      "MCP_DATA is the second table",
      `${head}[[kv_namespaces]]\nbinding = "OTHER"\nid = "o"\n\n[[kv_namespaces]]\nbinding = "MCP_DATA"\nid = "abc" # note\n`,
    ],
  ];
  it.each(okId)("remote accepts: %s", (_n, toml) => {
    const r = run(project({ toml }), []);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(expected("--remote"));
  });

  it("stops at the first failed upload and does not report success", () => {
    const p = project({ id: "abc123" });
    const r = run(p, [], { SHIM_EXIT: "1" });
    expect(r.status).not.toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.out).not.toMatch(/uploaded|wrangler deploy/i);
  });

  it("a missing data file fails without a success line", () => {
    const p = project({ id: "abc123", skipData: kvKeys[kvKeys.length - 1] });
    const r = run(p, []);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`data/${kvKeys[kvKeys.length - 1]}.json`);
    expect(r.out).not.toMatch(/uploaded|wrangler deploy/i);
  });

  it("an unknown argument is a usage error (exit 2)", () => {
    const p = project({ id: "abc123" });
    for (const args of [["--bogus"], ["--local", "--remote"]]) {
      const r = run(p, args);
      expect(r.status).toBe(2);
      expect(r.calls).toEqual([]);
    }
  });
});

describe("generated README setup per variant", () => {
  const readme = (v?: "vercel" | "cf") =>
    generateMcpServer(ctx, v).find((x) => x.filename === "mcp-server/README.md")?.content ?? "";

  it("express keeps npm start and port 3100", () => {
    expect(readme()).toContain("npm start");
    expect(readme()).toContain("http://localhost:3100/mcp");
  });

  it("worker documents local test, deploy steps, re-crawl and the wrangler dev URL", () => {
    const r = readme("cf");
    for (const s of [
      "bash setup.sh --local",
      "npx wrangler dev",
      "npx wrangler kv namespace create MCP_DATA",
      "npx wrangler deploy",
      "rerun `bash setup.sh`",
      "http://localhost:8787/mcp",
    ])
      expect(r).toContain(s);
    expect(r).not.toContain("npm start");
    expect(r).not.toContain("3100");
  });

  it("vercel uses vercel dev / vercel --prod, not npm start or port 3100", () => {
    const r = readme("vercel");
    expect(r).toContain("npx vercel dev");
    expect(r).toContain("npx vercel --prod");
    expect(r).not.toContain("npm start");
    expect(r).not.toContain("3100");
  });
});

describe("generated cloudflare wrangler.toml", () => {
  it("has no empty id (wrangler rejects it) and keeps the binding", () => {
    const toml = content("wrangler.toml");
    expect(toml).not.toMatch(/^\s*id\s*=\s*""/m);
    expect(toml).toContain('binding = "MCP_DATA"');
    expect(toml).toMatch(/^# id = "\.\.\."/m);
  });
});
