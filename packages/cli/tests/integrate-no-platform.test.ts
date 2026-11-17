import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

  it.skipIf(!existsSync(cliEntry))(
    "WordPress outside-dir refusal (manual actions only) exits 1",
    async () => {
      const cwd = tmp("w2agent-cli-cwd-");
      const project = tmp("w2agent-cli-proj-");
      const outside = tmp("w2agent-cli-out-");
      writeFileSync(
        join(project, "wp-config.php"),
        `<?php\ndefine('WP_PLUGIN_DIR', '${outside}');\n`,
      );
      const { code } = await run(
        ["integrate", baseUrl, "--platform", "wordpress", "--install", "--project-dir", project],
        cwd,
      );
      expect(code).toBe(1);
      expect(readdirSync(outside)).toEqual([]);
    },
    90000,
  );

  it.skipIf(!existsSync(cliEntry))(
    "an fs write failure exits 1 and withdraws post-install steps",
    async () => {
      const cwd = tmp("w2agent-cli-cwd-");
      const project = tmp("w2agent-cli-proj-");
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ dependencies: { next: "15" } }),
      );
      chmodSync(project, 0o500);
      try {
        const { code, out } = await run(
          ["integrate", baseUrl, "--platform", "nextjs", "--install", "--project-dir", project],
          cwd,
        );
        expect(code).toBe(1);
        expect(out).toContain("could not be written");
        expect(out).toContain("do not apply");
      } finally {
        chmodSync(project, 0o700);
      }
    },
    90000,
  );

  it.skipIf(!existsSync(cliEntry))(
    "a re-run where everything is already up to date exits 0",
    async () => {
      const cwd = tmp("w2agent-cli-cwd-");
      const project = tmp("w2agent-cli-proj-");
      writeFileSync(join(project, "package.json"), JSON.stringify({ name: "site" }));
      const args = [
        "integrate",
        baseUrl,
        "--platform",
        "astro",
        "--install",
        "--project-dir",
        project,
      ];
      const first = await run(args, cwd);
      expect(first.code).toBe(0);
      const second = await run(args, cwd);
      expect(second.out).toContain("already up to date");
      expect(second.code).toBe(0);
    },
    90000,
  );

  it.skipIf(!existsSync(cliEntry))(
    "a partial write failure still exits 1 when other files were installed",
    async () => {
      const cwd = tmp("w2agent-cli-cwd-");
      const project = tmp("w2agent-cli-proj-");
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ dependencies: { next: "15" } }),
      );
      mkdirSync(join(project, "app"));
      chmodSync(join(project, "app"), 0o500);
      try {
        const { code, out } = await run(
          ["integrate", baseUrl, "--platform", "nextjs", "--install", "--project-dir", project],
          cwd,
        );
        expect(out).toContain("Installed:");
        expect(out).toContain("could not be written");
        expect(code).toBe(1);
      } finally {
        chmodSync(join(project, "app"), 0o700);
      }
    },
    90000,
  );
});
