import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const NEXT_HTML =
  "<html><head><title>Next Site</title></head><body><h1>Next site</h1><p>Hello</p>" +
  '<script id="__NEXT_DATA__" type="application/json">{}</script>' +
  '<script src="/_next/static/chunks/main.js"></script></body></html>';

let server: Server;
let baseUrl: string;
let requests = 0;
const dirs: string[] = [];

function run(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliEntry, ...args],
      { cwd, timeout: 60000, env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "w2agent-fmt-"));
  dirs.push(d);
  return d;
}

function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).sort();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    if (req.url === "/" || req.url === "/index.html") {
      res.setHeader("content-type", "text/html");
      res.end(NEXT_HTML);
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

const skip = !existsSync(cliEntry);

describe("generate --format and --no-platform (NX-14, NX-5)", () => {
  it.skipIf(skip)(
    "positive control: without --no-platform a nextjs/ tree is written",
    async () => {
      const cwd = tmp();
      const { code, out } = await run(
        ["generate", baseUrl, "--format", "llms-txt", "--max-pages", "1", "-o", "out"],
        cwd,
      );
      expect(code).toBe(0);
      expect(out).toContain("nextjs");
      expect(existsSync(join(cwd, "out", "nextjs"))).toBe(true);
      expect(existsSync(join(cwd, "out", "llms.txt"))).toBe(true);
    },
    90000,
  );

  it.skipIf(skip)(
    "repeated --format with --no-platform writes exactly llms.txt and llms-full.txt",
    async () => {
      const cwd = tmp();
      const { code, out } = await run(
        [
          "generate",
          baseUrl,
          "--format",
          "llms-txt",
          "--format",
          "full",
          "--no-platform",
          "--max-pages",
          "1",
          "-o",
          "out",
        ],
        cwd,
      );
      expect(code).toBe(0);
      expect(out).toContain("Platform:");
      expect(out).not.toContain("integration files generated");
      expect(listFiles(join(cwd, "out"))).toEqual(["llms-full.txt", "llms.txt"]);
    },
    90000,
  );

  it.skipIf(skip)(
    "comma-separated --format with --no-platform writes exactly llms.txt and llms-full.txt",
    async () => {
      const cwd = tmp();
      const { code } = await run(
        [
          "generate",
          baseUrl,
          "--format",
          "llms-txt,full",
          "--no-platform",
          "--max-pages",
          "1",
          "-o",
          "out",
        ],
        cwd,
      );
      expect(code).toBe(0);
      expect(listFiles(join(cwd, "out"))).toEqual(["llms-full.txt", "llms.txt"]);
    },
    90000,
  );

  it.skipIf(skip)(
    "--format agents-md --no-platform writes agents.md only",
    async () => {
      const cwd = tmp();
      const { code, out } = await run(
        [
          "generate",
          baseUrl,
          "--format",
          "agents-md",
          "--no-platform",
          "--max-pages",
          "1",
          "-o",
          "out",
        ],
        cwd,
      );
      expect(code).toBe(0);
      expect(out).toContain("agents.md");
      expect(listFiles(join(cwd, "out"))).toEqual(["agents.md"]);
    },
    90000,
  );

  it.skipIf(skip)(
    "unknown --format exits non-zero, lists valid formats, makes no request and no output dir",
    async () => {
      const cwd = tmp();
      const before = requests;
      const { code, out } = await run(
        ["generate", baseUrl, "--format", "bogus", "--max-pages", "1", "-o", "out"],
        cwd,
      );
      expect(code).not.toBe(0);
      expect(out).toContain("bogus");
      for (const f of ["all", "llms-txt", "full", "agents-md", "mcp-server"]) {
        expect(out).toContain(f);
      }
      expect(existsSync(join(cwd, "out"))).toBe(false);
      expect(requests).toBe(before);
    },
    90000,
  );

  it.skipIf(skip)(
    "empty --format segment is rejected before any request",
    async () => {
      const cwd = tmp();
      const before = requests;
      const { code, out } = await run(
        ["generate", baseUrl, "--format", "llms-txt,,full", "-o", "out"],
        cwd,
      );
      expect(code).not.toBe(0);
      expect(out).toContain("empty");
      expect(existsSync(join(cwd, "out"))).toBe(false);
      expect(requests).toBe(before);
    },
    90000,
  );
});
