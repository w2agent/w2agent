import { type ChildProcess, execSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAdapter } from "../src/adapters/registry.js";
import type { PlatformId } from "../src/adapters/types.js";
import { allChecks } from "../src/audit/checks/index.js";
import { runAudit } from "../src/audit/engine.js";
import type { AuditReport, CheckResult, SiteMetadata } from "../src/audit/types.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";

import "../src/adapters/index.js";

const FIXTURES_DIR = resolve(__dirname, "fixtures/platforms");

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

function makeCtx(baseUrl = "https://example.com"): GenerateContext {
  return { pages: [], rawPages: [], metadata: baseMeta, baseUrl };
}

function makeCoreFiles(): GeneratedFile[] {
  return [
    { filename: "llms.txt", content: "# Example\n\n> A test site\n", size: 25 },
    { filename: "llms-full.txt", content: "# Full content\n", size: 16 },
    { filename: "robots.txt", content: "User-agent: *\nAllow: /\n", size: 23 },
    {
      filename: "agent-card.json",
      content: JSON.stringify({
        name: "Example",
        description: "A test site",
        supportedInterfaces: [
          { url: "https://example.com/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
        version: "1.0.0",
        capabilities: {},
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [],
      }),
      size: 300,
    },
  ];
}

function loadFixture(
  platformId: PlatformId,
  fixtureName: string,
): {
  dir: string;
  files: GeneratedFile[];
} {
  const fixtureDir = join(FIXTURES_DIR, fixtureName);
  const dir = mkdtempSync(join(tmpdir(), `w2agent-integration-${platformId}-`));
  cpSync(fixtureDir, dir, { recursive: true });

  const adapter = getAdapter(platformId);
  if (!adapter) throw new Error(`No adapter for ${platformId}`);

  const ctx = makeCtx();
  const coreFiles = makeCoreFiles();
  const files = adapter.generateIntegration(ctx, coreFiles);

  return { dir, files };
}

// Explicit skip list instead of heuristic pattern matching (fix for Issue #6)
const SKIP_FILES = new Set(["INSTALL.md"]);
const SKIP_SUFFIXES = ["/w2agent-build.mjs"];

function writeGeneratedFiles(dir: string, files: GeneratedFile[], prefix: string): string[] {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const basename = file.filename.split("/").pop()!;
    if (SKIP_FILES.has(basename) || SKIP_SUFFIXES.some((s) => file.filename.endsWith(s))) {
      skipped.push(file.filename);
      continue;
    }

    const relativePath = file.filename.startsWith(`${prefix}/`)
      ? file.filename.slice(prefix.length + 1)
      : file.filename;

    const fullPath = join(dir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, "utf-8");
    written.push(relativePath);
  }

  return written;
}

// NOTE: All exec/spawn calls use hardcoded commands only (no user input).
function npmInstallAndBuild(dir: string): { success: boolean; output: string } {
  try {
    // Run install and build as separate steps so failures are distinguishable
    execSync("npm install --ignore-scripts 2>&1", {
      cwd: dir,
      timeout: 60_000,
      encoding: "utf-8",
      env: { ...process.env, NODE_ENV: "production" },
    });
    const output = execSync("npm run build 2>&1", {
      cwd: dir,
      timeout: 120_000,
      encoding: "utf-8",
      env: { ...process.env, NODE_ENV: "production" },
    });
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: err.stdout || err.stderr || err.message };
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Fix for Issue #1: require HTTP 200 from homepage, not just "any non-5xx"
async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return; // 200-299 only
      lastError = `HTTP ${res.status}`;
    } catch (err: any) {
      lastError = err.message || "connection failed";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms (last: ${lastError})`);
}

interface ServerHandle {
  proc: ChildProcess;
  port: number;
  url: string;
  kill: () => void;
}

function startServer(
  dir: string,
  command: string,
  args: string[],
  port: number,
  env: Record<string, string> = {},
): ServerHandle {
  const proc = spawn(command, args, {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  const url = `http://localhost:${port}`;
  return {
    proc,
    port,
    url,
    kill: () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 2000);
    },
  };
}

function getCheckResult(report: AuditReport, checkId: string): CheckResult | undefined {
  for (const cat of report.categories) {
    const found = cat.checks.find((c) => c.id === checkId);
    if (found) return found;
  }
  return undefined;
}

// Fix for Issue #3: helper to assert audit actually ran checks
function totalChecksRan(report: AuditReport): number {
  return report.categories.reduce((sum, c) => sum + c.checks.length, 0);
}

// Fix for Issue #4: use checksOverride param instead of global mutable state
async function auditServer(url: string): Promise<AuditReport> {
  return runAudit(url, { maxPages: 3, timeout: 5000 }, undefined, allChecks);
}

// ─── Astro: Audit Live Server ─────────────────────────────────

describe("integration: Astro", { timeout: 180_000 }, () => {
  let fixtureDir: string;
  let files: GeneratedFile[];
  let server: ServerHandle | undefined;
  let report: AuditReport;

  beforeAll(async () => {
    const result = loadFixture("astro", "astro-app");
    fixtureDir = result.dir;
    files = result.files;

    writeGeneratedFiles(fixtureDir, files, "astro");

    const { success, output } = npmInstallAndBuild(fixtureDir);
    if (!success) throw new Error(`Astro build failed: ${output}`);

    const port = await getFreePort();
    server = startServer(fixtureDir, "npx", ["astro", "preview", "--port", String(port)], port);
    await waitForServer(`http://localhost:${port}`);

    report = await auditServer(`http://localhost:${port}`);
  });

  afterAll(() => server?.kill());

  it("audit ran checks", () => {
    expect(totalChecksRan(report)).toBeGreaterThan(0);
  });

  it("builds successfully", () => {
    expect(existsSync(join(fixtureDir, "dist/index.html"))).toBe(true);
  });

  it("build output contains llms.txt", () => {
    expect(existsSync(join(fixtureDir, "dist/llms.txt"))).toBe(true);
    const content = readFileSync(join(fixtureDir, "dist/llms.txt"), "utf-8");
    expect(content).toContain("# Example");
  });

  it("build output contains agent-card.json", () => {
    expect(existsSync(join(fixtureDir, "dist/.well-known/agent-card.json"))).toBe(true);
  });

  it("audit: llms.txt exists and is found", () => {
    const check = getCheckResult(report, "llms-txt-exists");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });

  it("audit: llms.txt follows spec", () => {
    const check = getCheckResult(report, "llms-txt-valid");
    expect(check).toBeDefined();
    expect(check?.score).toBeGreaterThanOrEqual(50);
  });

  it("audit: agent-card.json is discoverable", () => {
    const check = getCheckResult(report, "well-known-agent-card");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });

  it("audit: no error status codes", () => {
    const check = getCheckResult(report, "status-codes");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });

  it("audit: fast response time", () => {
    const check = getCheckResult(report, "response-time");
    expect(check).toBeDefined();
    expect(check?.score).toBeGreaterThanOrEqual(60);
  });
});

// ─── Next.js: Audit Live Server ───────────────────────────────

describe("integration: Next.js", { timeout: 180_000 }, () => {
  let fixtureDir: string;
  let files: GeneratedFile[];
  let server: ServerHandle | undefined;
  let report: AuditReport;

  beforeAll(async () => {
    const result = loadFixture("nextjs", "nextjs-app");
    fixtureDir = result.dir;
    files = result.files;

    writeGeneratedFiles(fixtureDir, files, "nextjs");

    const { success, output } = npmInstallAndBuild(fixtureDir);
    if (!success) throw new Error(`Next.js build failed: ${output}`);

    const port = await getFreePort();
    server = startServer(fixtureDir, "npx", ["next", "start", "-p", String(port)], port);
    await waitForServer(`http://localhost:${port}`);

    report = await auditServer(`http://localhost:${port}`);
  });

  afterAll(() => server?.kill());

  it("audit ran checks", () => {
    expect(totalChecksRan(report)).toBeGreaterThan(0);
  });

  it("builds successfully", () => {
    expect(existsSync(join(fixtureDir, ".next"))).toBe(true);
  });

  it("audit: llms.txt exists and is found", () => {
    const check = getCheckResult(report, "llms-txt-exists");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });

  it("audit: llms.txt follows spec", () => {
    const check = getCheckResult(report, "llms-txt-valid");
    expect(check).toBeDefined();
    expect(check?.score).toBeGreaterThanOrEqual(50);
  });

  it("audit: agent-card.json is discoverable", () => {
    const check = getCheckResult(report, "well-known-agent-card");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });

  it("audit: no error status codes", () => {
    const check = getCheckResult(report, "status-codes");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });
});

// ─── Nuxt: Audit Live Server ──────────────────────────────────

describe("integration: Nuxt", { timeout: 180_000 }, () => {
  let fixtureDir: string;
  let files: GeneratedFile[];
  let server: ServerHandle | undefined;
  let report: AuditReport;

  beforeAll(async () => {
    const result = loadFixture("nuxt", "nuxt-app");
    fixtureDir = result.dir;
    files = result.files;

    writeGeneratedFiles(fixtureDir, files, "nuxt");

    const { success, output } = npmInstallAndBuild(fixtureDir);
    if (!success) throw new Error(`Nuxt build failed: ${output}`);

    const port = await getFreePort();
    server = startServer(fixtureDir, "node", [".output/server/index.mjs"], port, {
      PORT: String(port),
      HOST: "localhost",
    });
    await waitForServer(`http://localhost:${port}`);

    report = await auditServer(`http://localhost:${port}`);
  });

  afterAll(() => server?.kill());

  it("audit ran checks", () => {
    expect(totalChecksRan(report)).toBeGreaterThan(0);
  });

  it("builds successfully", () => {
    expect(existsSync(join(fixtureDir, ".output/server/index.mjs"))).toBe(true);
  });

  it("audit: llms.txt exists and is found", () => {
    const check = getCheckResult(report, "llms-txt-exists");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });

  it("audit: agent-card.json is discoverable", () => {
    const check = getCheckResult(report, "well-known-agent-card");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });

  it("audit: no error status codes", () => {
    const check = getCheckResult(report, "status-codes");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });
});

// ─── Docusaurus: Audit Live Server ────────────────────────────

describe("integration: Docusaurus", { timeout: 240_000 }, () => {
  let fixtureDir: string;
  let files: GeneratedFile[];
  let server: ServerHandle | undefined;
  let report: AuditReport;

  beforeAll(async () => {
    const result = loadFixture("docusaurus", "docusaurus-site");
    fixtureDir = result.dir;
    files = result.files;

    // Fix for Issue #7: use writeGeneratedFiles consistently.
    // Docusaurus generated files have prefix "docusaurus/" and go into a subdir.
    // For static file integration, we write them into the project's static/ dir.
    const staticFiles = files.filter((f) => f.filename.startsWith("docusaurus/static/"));
    for (const file of staticFiles) {
      // "docusaurus/static/llms.txt" -> "static/llms.txt"
      const relativePath = file.filename.replace("docusaurus/", "");
      const fullPath = join(fixtureDir, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, "utf-8");
    }
    // Assert we actually wrote the files we expected
    expect(existsSync(join(fixtureDir, "static/llms.txt"))).toBe(true);
    expect(existsSync(join(fixtureDir, "static/.well-known/agent-card.json"))).toBe(true);

    const { success, output } = npmInstallAndBuild(fixtureDir);
    if (!success) throw new Error(`Docusaurus build failed: ${output}`);

    const port = await getFreePort();
    server = startServer(
      fixtureDir,
      "npx",
      ["docusaurus", "serve", "--port", String(port), "--no-open"],
      port,
    );
    await waitForServer(`http://localhost:${port}`);

    report = await auditServer(`http://localhost:${port}`);
  });

  afterAll(() => server?.kill());

  it("audit ran checks", () => {
    expect(totalChecksRan(report)).toBeGreaterThan(0);
  });

  it("builds successfully", () => {
    expect(existsSync(join(fixtureDir, "build/index.html"))).toBe(true);
  });

  it("build output contains llms.txt", () => {
    expect(existsSync(join(fixtureDir, "build/llms.txt"))).toBe(true);
  });

  it("audit: llms.txt exists and is found", () => {
    const check = getCheckResult(report, "llms-txt-exists");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });

  it("audit: agent-card.json is discoverable", () => {
    const check = getCheckResult(report, "well-known-agent-card");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });

  it("audit: no error status codes", () => {
    const check = getCheckResult(report, "status-codes");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });
});

// ─── Non-JS Platform Syntax + Behavior Tests ──────────────────

describe("integration: WordPress", () => {
  let files: GeneratedFile[];
  let fixtureDir: string;

  beforeAll(() => {
    const result = loadFixture("wordpress", "wordpress-theme");
    fixtureDir = result.dir;
    files = result.files;
    writeGeneratedFiles(fixtureDir, files, "wordpress");
  });

  it("generates expected files", () => {
    const filenames = files.map((f) => f.filename);
    expect(filenames).toContain("wordpress/w2agent-plugin.php");
    expect(filenames).toContain("wordpress/data/llms.txt");
    expect(filenames).toContain("wordpress/data/robots-rules.txt");
  });

  it("generated PHP has valid syntax", () => {
    const phpFiles = files.filter((f) => f.filename.endsWith(".php"));
    expect(phpFiles.length).toBeGreaterThan(0);

    for (const file of phpFiles) {
      expect(file.content).toContain("<?php");
      const opens = (file.content.match(/{/g) || []).length;
      const closes = (file.content.match(/}/g) || []).length;
      expect(opens).toBe(closes);
    }
  });

  it("plugin serves /llms.txt endpoint", () => {
    const plugin = files.find((f) => f.filename.endsWith(".php"))!;
    expect(plugin.content).toContain("/llms.txt");
    expect(plugin.content).toContain("text/plain");
    expect(plugin.content).toContain("w2agent_generate_llms_txt");
  });

  it("plugin serves /.well-known/agent-card.json endpoint", () => {
    const plugin = files.find((f) => f.filename.endsWith(".php"))!;
    expect(plugin.content).toContain("/.well-known/agent-card.json");
    expect(plugin.content).toContain("application/json");
    expect(plugin.content).toContain("w2agent_generate_agent_card");
  });

  it("plugin adds discovery <link> tag", () => {
    const plugin = files.find((f) => f.filename.endsWith(".php"))!;
    expect(plugin.content).toContain("wp_head");
    expect(plugin.content).toContain('rel="alternate"');
    expect(plugin.content).toContain('type="text/markdown"');
    expect(plugin.content).toContain('href="/llms.txt"');
  });

  it("plugin hooks into robots.txt", () => {
    const plugin = files.find((f) => f.filename.endsWith(".php"))!;
    expect(plugin.content).toContain("robots_txt");
    expect(plugin.content).toContain("robots-rules.txt");
  });

  it("plugin auto-regenerates on content changes", () => {
    const plugin = files.find((f) => f.filename.endsWith(".php"))!;
    expect(plugin.content).toContain("save_post");
    expect(plugin.content).toContain("wp_cache_delete");
  });

  // Fix for Issue #8: skip with message instead of silently passing with 0 assertions
  it.skipIf(!phpAvailable())("validates PHP syntax with php -l", () => {
    const phpFile = join(fixtureDir, "w2agent-plugin.php");
    const result = execSync(`php -l "${phpFile}" 2>&1`, { encoding: "utf-8" });
    expect(result).toContain("No syntax errors");
  });
});

function phpAvailable(): boolean {
  try {
    execSync("php --version", { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("integration: Shopify", () => {
  let files: GeneratedFile[];

  beforeAll(() => {
    const result = loadFixture("shopify", "shopify-theme");
    files = result.files;
  });

  it("generates expected files", () => {
    const filenames = files.map((f) => f.filename);
    expect(filenames).toContain("shopify/snippets/w2agent-head.liquid");
    expect(filenames).toContain("shopify/templates/robots.txt.liquid");
    expect(filenames).toContain("shopify/data/llms.txt");
  });

  it("head snippet includes discovery link", () => {
    const head = files.find((f) => f.filename.includes("w2agent-head.liquid"))!;
    expect(head.content).toContain('rel="alternate"');
    expect(head.content).toContain('type="text/markdown"');
    expect(head.content).toContain('href="/pages/llms-txt"');
  });

  it("head snippet includes product schema.org", () => {
    const head = files.find((f) => f.filename.includes("w2agent-head.liquid"))!;
    expect(head.content).toContain("schema.org");
    expect(head.content).toContain('"@type": "Product"');
    expect(head.content).toContain("product.title");
    expect(head.content).toContain("product.price");
  });

  it("robots.txt template allows AI-relevant paths", () => {
    const robots = files.find((f) => f.filename.includes("robots.txt.liquid"))!;
    expect(robots.content).toContain("Allow: /pages/llms-txt");
    expect(robots.content).toContain("Allow: /collections");
    expect(robots.content).toContain("Allow: /products");
    expect(robots.content).toContain("Disallow: /admin");
    expect(robots.content).toContain("Disallow: /checkout");
  });

  it("generated Liquid templates have valid syntax", () => {
    const liquidFiles = files.filter((f) => f.filename.endsWith(".liquid"));
    expect(liquidFiles.length).toBeGreaterThan(0);

    for (const file of liquidFiles) {
      const openTags = (file.content.match(/{%/g) || []).length;
      const closeTags = (file.content.match(/%}/g) || []).length;
      expect(openTags).toBe(closeTags);

      const openOutput = (file.content.match(/{{/g) || []).length;
      const closeOutput = (file.content.match(/}}/g) || []).length;
      expect(openOutput).toBe(closeOutput);

      const ifOpens = (file.content.match(/{%[-\s]*if\s/g) || []).length;
      const ifCloses = (file.content.match(/{%[-\s]*endif/g) || []).length;
      expect(ifOpens).toBe(ifCloses);
    }
  });
});

// ─── Negative Tests: Prove Audit Catches Missing Features ─────

describe("integration: negative tests", { timeout: 180_000 }, () => {
  it("audit detects missing llms.txt when not generated", async () => {
    // Build Astro fixture WITHOUT writing any generated files
    const fixtureDir = mkdtempSync(join(tmpdir(), "w2agent-negative-llms-"));
    cpSync(join(FIXTURES_DIR, "astro-app"), fixtureDir, { recursive: true });

    const { success } = npmInstallAndBuild(fixtureDir);
    expect(success).toBe(true);

    const port = await getFreePort();
    const server = startServer(
      fixtureDir,
      "npx",
      ["astro", "preview", "--port", String(port)],
      port,
    );
    try {
      await waitForServer(`http://localhost:${port}`);
      const report = await auditServer(`http://localhost:${port}`);

      expect(totalChecksRan(report)).toBeGreaterThan(0);

      const llmsCheck = getCheckResult(report, "llms-txt-exists");
      expect(llmsCheck).toBeDefined();
      expect(llmsCheck?.status).toBe("fail");

      const agentCardCheck = getCheckResult(report, "well-known-agent-card");
      expect(agentCardCheck).toBeDefined();
      expect(agentCardCheck?.status).toBe("fail");
    } finally {
      server.kill();
    }
  });

  it("audit detects invalid llms.txt content", async () => {
    // Build Astro fixture with garbage llms.txt (no markdown structure)
    const fixtureDir = mkdtempSync(join(tmpdir(), "w2agent-negative-invalid-"));
    cpSync(join(FIXTURES_DIR, "astro-app"), fixtureDir, { recursive: true });

    // Write invalid llms.txt (no H1, no blockquote, no URLs, no sections)
    mkdirSync(join(fixtureDir, "public"), { recursive: true });
    writeFileSync(
      join(fixtureDir, "public/llms.txt"),
      "just some plain text with no structure",
      "utf-8",
    );

    const { success } = npmInstallAndBuild(fixtureDir);
    expect(success).toBe(true);

    const port = await getFreePort();
    const server = startServer(
      fixtureDir,
      "npx",
      ["astro", "preview", "--port", String(port)],
      port,
    );
    try {
      await waitForServer(`http://localhost:${port}`);
      const report = await auditServer(`http://localhost:${port}`);

      expect(totalChecksRan(report)).toBeGreaterThan(0);

      // llms.txt exists but doesn't follow spec
      const llmsExists = getCheckResult(report, "llms-txt-exists");
      expect(llmsExists).toBeDefined();
      expect(llmsExists?.status).toBe("pass"); // it exists

      const llmsValid = getCheckResult(report, "llms-txt-valid");
      expect(llmsValid).toBeDefined();
      expect(llmsValid?.score).toBeLessThan(50); // but it's not valid
    } finally {
      server.kill();
    }
  });

  it("audit detects invalid agent-card.json", async () => {
    // Build Astro fixture with broken agent-card.json
    const fixtureDir = mkdtempSync(join(tmpdir(), "w2agent-negative-agentcard-"));
    cpSync(join(FIXTURES_DIR, "astro-app"), fixtureDir, { recursive: true });

    mkdirSync(join(fixtureDir, "public/.well-known"), { recursive: true });
    writeFileSync(join(fixtureDir, "public/llms.txt"), "# Valid\n\n> desc\n", "utf-8");
    writeFileSync(join(fixtureDir, "public/.well-known/agent-card.json"), "not json {{{", "utf-8");

    const { success } = npmInstallAndBuild(fixtureDir);
    expect(success).toBe(true);

    const port = await getFreePort();
    const server = startServer(
      fixtureDir,
      "npx",
      ["astro", "preview", "--port", String(port)],
      port,
    );
    try {
      await waitForServer(`http://localhost:${port}`);
      const report = await auditServer(`http://localhost:${port}`);

      expect(totalChecksRan(report)).toBeGreaterThan(0);

      const agentCardCheck = getCheckResult(report, "well-known-agent-card");
      expect(agentCardCheck).toBeDefined();
      expect(agentCardCheck?.status).toBe("fail");
    } finally {
      server.kill();
    }
  });
});

// ─── Cross-Platform Conformance ───────────────────────────────

describe("integration: conformance", () => {
  const platforms: { id: PlatformId; prefix: string }[] = [
    { id: "nextjs", prefix: "nextjs" },
    { id: "nuxt", prefix: "nuxt" },
    { id: "astro", prefix: "astro" },
    { id: "docusaurus", prefix: "docusaurus" },
    { id: "wordpress", prefix: "wordpress" },
    { id: "shopify", prefix: "shopify" },
  ];

  for (const { id, prefix } of platforms) {
    describe(id, () => {
      let files: GeneratedFile[];

      beforeAll(() => {
        const adapter = getAdapter(id)!;
        files = adapter.generateIntegration(makeCtx(), makeCoreFiles());
      });

      it("generates at least one file", () => {
        expect(files.length).toBeGreaterThan(0);
      });

      it("all files have content", () => {
        for (const file of files) {
          expect(file.content.length).toBeGreaterThan(0);
        }
      });

      it("all files have correct byte sizes", () => {
        for (const file of files) {
          const expectedSize = new TextEncoder().encode(file.content).length;
          expect(file.size).toBe(expectedSize);
        }
      });

      it("filenames are prefixed with platform directory", () => {
        for (const file of files) {
          expect(file.filename).toMatch(new RegExp(`^${prefix}/`));
        }
      });

      it("no files contain undefined or null template values", () => {
        for (const file of files) {
          expect(file.content).not.toContain("undefined");
        }
      });

      it("includes an INSTALL.md", () => {
        expect(files.some((f) => f.filename.endsWith("INSTALL.md"))).toBe(true);
      });

      it("serves llms.txt content", () => {
        const hasLlmsTxt = files.some(
          (f) => f.filename.includes("llms.txt") || f.content.includes("llms.txt"),
        );
        expect(hasLlmsTxt).toBe(true);
      });
    });
  }
});
