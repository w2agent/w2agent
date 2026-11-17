import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

let server: Server;
let baseUrl: string;
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

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.setHeader("content-type", "text/html");
      res.end("<html><head><title>Plain</title></head><body><h1>Plain page</h1></body></html>");
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

describe("integrate with no detectable platform (NX-11)", () => {
  it.skipIf(!existsSync(cliEntry))(
    "--install --dry-run writes nothing, names every platform, exits 1",
    async () => {
      const cwd = tmp("w2agent-cli-cwd-");
      const project = tmp("w2agent-cli-proj-");
      const { code, out } = await run(
        [
          "integrate",
          baseUrl,
          "--install",
          "--dry-run",
          "--project-dir",
          project,
          "--max-pages",
          "2",
        ],
        cwd,
      );
      expect(code).toBe(1);
      expect(out).not.toContain("Core files were still generated");
      expect(out).toContain("--platform <id> --install --project-dir <dir>");
      for (const id of ["wordpress", "nextjs", "shopify", "docusaurus", "nuxt", "astro"]) {
        expect(out).toContain(`--platform ${id}`);
      }
      expect(readdirSync(cwd)).toEqual([]);
      expect(readdirSync(project)).toEqual([]);
    },
    90000,
  );

  it.skipIf(!existsSync(cliEntry))(
    "--install alone also writes nothing and exits 1",
    async () => {
      const cwd = tmp("w2agent-cli-cwd-");
      const project = tmp("w2agent-cli-proj-");
      const { code } = await run(
        ["integrate", baseUrl, "--install", "--project-dir", project, "--max-pages", "2"],
        cwd,
      );
      expect(code).toBe(1);
      expect(readdirSync(cwd)).toEqual([]);
      expect(readdirSync(project)).toEqual([]);
    },
    90000,
  );

  it.skipIf(!existsSync(cliEntry))(
    "forced nextjs --install on an empty dir prints the summary and exits 1",
    async () => {
      const cwd = tmp("w2agent-cli-cwd-");
      const project = tmp("w2agent-cli-proj-");
      const { code, out } = await run(
        [
          "integrate",
          baseUrl,
          "--platform",
          "nextjs",
          "--install",
          "--project-dir",
          project,
          "--max-pages",
          "2",
        ],
        cwd,
      );
      expect(code).toBe(1);
      expect(out).toContain("Next.js");
      expect(readdirSync(project)).toEqual([]);
    },
    90000,
  );

  it.skipIf(!existsSync(cliEntry))(
    "without --install the core files are still written and exit is 0",
    async () => {
      const cwd = tmp("w2agent-cli-cwd-");
      const { code, out } = await run(["integrate", baseUrl, "--max-pages", "2"], cwd);
      expect(code).toBe(0);
      expect(out).toContain("Core files were still generated");
      expect(existsSync(join(cwd, "w2agent-output", "llms.txt"))).toBe(true);
    },
    90000,
  );
});
