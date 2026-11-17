import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const skip = !existsSync(cliEntry);

const HTML: Record<string, (marker: string) => string> = {
  nextjs: (m) =>
    `<html><head><title>${m}</title></head><body><h1>${m}</h1><p>Hello</p>` +
    '<script id="__NEXT_DATA__" type="application/json">{}</script>' +
    '<script src="/_next/static/chunks/main.js"></script></body></html>',
  nuxt: (m) =>
    `<html><head><title>${m}</title><meta name="generator" content="Nuxt"></head>` +
    `<body><h1>${m}</h1><p>Hello</p><script>window.__NUXT__={}</script></body></html>`,
  astro: (m) =>
    `<html><head><title>${m}</title><meta name="generator" content="Astro v5.0.0"></head>` +
    `<body><h1>${m}</h1><p>Hello</p></body></html>`,
};

let server: Server;
let baseUrl: string;
let currentHtml = "";
const dirs: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function exec(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: 60000, env: { ...process.env, NO_COLOR: "1", ...env } },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).sort();
}

async function emit(platform: string, marker: string): Promise<string> {
  currentHtml = HTML[platform](marker);
  const out = tmp("w2agent-emit-");
  const { code } = await exec(
    process.execPath,
    [cliEntry, "generate", baseUrl, "--format", "llms-txt,full", "--max-pages", "1", "-o", out],
    out,
  );
  expect(code).toBe(0);
  expect(existsSync(join(out, platform))).toBe(true);
  return join(out, platform);
}

function makeProject(withCli: boolean): string {
  const project = tmp("w2agent proj-");
  writeFileSync(join(project, "package.json"), '{"name":"site","private":true}');
  if (withCli) {
    const bin = join(project, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, "w2agent");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${cliEntry}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return project;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.setHeader("content-type", "text/html");
      res.end(currentHtml);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const STALE = "# stale seed\n";

const DRIVER = [
  'import { pathToFileURL } from "node:url";',
  'import { resolve } from "node:path";',
  'import w2agent from "./w2agent-integration.mjs";',
  "const logger = { info: (m) => console.log(m), warn: (m) => console.log(m) };",
  'const dir = pathToFileURL(resolve("dist") + "/");',
  'await w2agent().hooks["astro:build:done"]({ dir, logger });',
  "",
].join("\n");

describe("generated build scripts refresh llms.txt (NX-5, GEN-5)", () => {
  const scriptCases: { platform: string; target: string }[] = [
    { platform: "nextjs", target: ".w2agent" },
    { platform: "nuxt", target: "public" },
    { platform: "astro", target: "public" },
  ];

  for (const { platform, target } of scriptCases) {
    it.skipIf(skip)(
      `${platform} w2agent-build.mjs writes llms.txt and llms-full.txt into ${target}/ and nothing else`,
      async () => {
        const marker = `Marker ${platform} Refresh`;
        const emitted = await emit(platform, marker);
        const project = makeProject(true);
        writeFileSync(
          join(project, "w2agent-build.mjs"),
          readFileSync(join(emitted, "w2agent-build.mjs")),
        );
        mkdirSync(join(project, target));
        writeFileSync(join(project, target, "llms.txt"), STALE);
        const before = listFiles(project);

        const { code, out } = await exec(process.execPath, ["w2agent-build.mjs"], project, {
          SITE_URL: baseUrl,
        });

        expect(code).toBe(0);
        expect(out).toContain("Done. Files written");
        expect(readFileSync(join(project, target, "llms.txt"), "utf-8")).toContain(marker);
        expect(
          readFileSync(join(project, target, "llms-full.txt"), "utf-8").length,
        ).toBeGreaterThan(0);
        expect(listFiles(project)).toEqual([...before, `${target}/llms-full.txt`].sort());
      },
      120000,
    );
  }

  it.skipIf(skip)(
    "astro integration plugin writes into a dist dir whose path contains a space",
    async () => {
      const marker = "Marker Astro Integration";
      const emitted = await emit("astro", marker);
      const project = makeProject(true);
      expect(project).toContain(" ");
      writeFileSync(
        join(project, "w2agent-integration.mjs"),
        readFileSync(join(emitted, "w2agent-integration.mjs")),
      );
      writeFileSync(join(project, "driver.mjs"), DRIVER);
      mkdirSync(join(project, "dist"));
      writeFileSync(join(project, "dist", "llms.txt"), STALE);
      const before = listFiles(project);

      const { code, out } = await exec(process.execPath, ["driver.mjs"], project, {
        SITE_URL: baseUrl,
      });

      expect(code).toBe(0);
      expect(out).toContain("Done. Files written");
      expect(readFileSync(join(project, "dist", "llms.txt"), "utf-8")).toContain(marker);
      expect(readFileSync(join(project, "dist", "llms-full.txt"), "utf-8").length).toBeGreaterThan(
        0,
      );
      expect(listFiles(project)).toEqual([...before, "dist/llms-full.txt"].sort());
      expect(listFiles(project).some((f) => f.includes("%20"))).toBe(false);
    },
    120000,
  );

  const negativeCases = [
    {
      name: "nextjs build script",
      platform: "nextjs",
      file: "w2agent-build.mjs",
      target: ".w2agent",
    },
    { name: "nuxt build script", platform: "nuxt", file: "w2agent-build.mjs", target: "public" },
    { name: "astro build script", platform: "astro", file: "w2agent-build.mjs", target: "public" },
    {
      name: "astro integration",
      platform: "astro",
      file: "w2agent-integration.mjs",
      target: "dist",
    },
  ];

  for (const c of negativeCases) {
    it.skipIf(skip)(
      `${c.name}: without a local w2agent it exits 0, prints the install hint and downloads nothing`,
      async () => {
        const emitted = await emit(c.platform, "Marker Negative");
        const project = makeProject(false);
        writeFileSync(join(project, c.file), readFileSync(join(emitted, c.file)));
        const entry = c.file === "w2agent-integration.mjs" ? "driver.mjs" : c.file;
        if (entry === "driver.mjs") writeFileSync(join(project, "driver.mjs"), DRIVER);
        mkdirSync(join(project, c.target));
        writeFileSync(join(project, c.target, "llms.txt"), STALE);
        const before = listFiles(project);

        const registryHits: string[] = [];
        let registryUrl = "";
        const registry = createServer((req, res) => {
          registryHits.push(req.url ?? "");
          if (req.url === "/w2agent") {
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                name: "w2agent",
                "dist-tags": { latest: "9.9.9" },
                versions: {
                  "9.9.9": {
                    name: "w2agent",
                    version: "9.9.9",
                    bin: { w2agent: "bin.js" },
                    dist: { tarball: `${registryUrl}w2agent/-/w2agent-9.9.9.tgz` },
                  },
                },
              }),
            );
            return;
          }
          res.statusCode = 404;
          res.end("{}");
        });
        await new Promise<void>((r) => registry.listen(0, "127.0.0.1", r));
        registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;

        const started = Date.now();
        let result: { code: number; out: string };
        try {
          result = await exec(process.execPath, [entry], project, {
            SITE_URL: baseUrl,
            npm_config_registry: registryUrl,
            npm_config_fetch_retries: "0",
            npm_config_update_notifier: "false",
          });
        } finally {
          await new Promise<void>((r) => registry.close(() => r()));
        }
        const { code, out } = result;

        expect(registryHits.filter((u) => u.includes(".tgz"))).toEqual([]);
        expect(code).toBe(0);
        expect(Date.now() - started).toBeLessThan(15000);
        expect(out).toContain("Generation failed");
        expect(out).toContain("npm install -D <path-to-w2agent>/packages/cli");
        expect(out).not.toContain("Done. Files written");
        expect(readFileSync(join(project, c.target, "llms.txt"), "utf-8")).toBe(STALE);
        expect(listFiles(project)).toEqual(before);
      },
      120000,
    );
  }
});
