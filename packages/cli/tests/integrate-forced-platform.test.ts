import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");

const PRODUCT_LD = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Mug"}</script>`;

function shopPages(withSchema: boolean): Record<string, string> {
  return {
    "/": `<html><head><title>Shop</title><meta name="description" content="A test shop"></head><body><h1>Shop</h1><p>Welcome to the test shop with mugs and more.</p><a href="/products/mug">Mug</a></body></html>`,
    "/products/mug": `<html><head><title>Mug</title>${withSchema ? PRODUCT_LD : ""}</head><body><h1>Mug</h1><p>A ceramic mug that holds coffee and tea for testing.</p></body></html>`,
  };
}

function listen(pages: Record<string, string>): Promise<Server> {
  const server = createServer((req, res) => {
    const body = pages[new URL(req.url ?? "/", "http://x").pathname];
    if (body === undefined) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function origin(server: Server): string {
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "w2agent-forced-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of ["AI_AGENT", "CLAUDECODE", "CODEX_CI"]) delete env[name];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function outDir(): string {
  return mkdtempSync(join(tmpdir(), "w2agent-forced-out-"));
}

describe("built CLI: integrate --platform shopify uses the crawled pages", () => {
  let present: Server;
  let absent: Server;
  let nextSite: Server;
  let dead: Server;

  beforeAll(async () => {
    present = await listen(shopPages(true));
    absent = await listen(shopPages(false));
    nextSite = await listen({
      "/": `<html><head><title>Acme</title></head><body><script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/main.js"></script><h1>Acme widgets</h1><p>We sell widgets.</p></body></html>`,
    });
    dead = await listen({});
  });

  afterAll(async () => {
    await Promise.all(
      [present, absent, nextSite, dead].map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
  });

  it("a crawled product page with Product schema: no block, the nothing-to-add note", async () => {
    const out = outDir();
    const r = await run(["integrate", origin(present), "--platform", "shopify", "--output", out]);
    expect(r.code).toBe(0);
    const head = readFileSync(join(out, "shopify", "snippets", "w2agent-head.liquid"), "utf-8");
    expect(head).not.toContain("structured_data");
    const install = readFileSync(join(out, "shopify", "INSTALL.md"), "utf-8");
    expect(install).toContain("You have nothing to add.");
    expect(install).not.toContain("no crawled product page");
  });

  it("a crawled product page without Product schema: the head snippet carries the block", async () => {
    const out = outDir();
    const r = await run(["integrate", origin(absent), "--platform", "shopify", "--output", out]);
    expect(r.code).toBe(0);
    const head = readFileSync(join(out, "shopify", "snippets", "w2agent-head.liquid"), "utf-8");
    expect(head).toContain("structured_data");
    const install = readFileSync(join(out, "shopify", "INSTALL.md"), "utf-8");
    expect(install).toContain("The crawled product pages had no Product schema");
    expect(install).not.toContain("no crawled product page");
  });

  it("a forced platform that differs from the detected one produces only the forced files", async () => {
    const out = outDir();
    const r = await run(["integrate", origin(nextSite), "--platform", "shopify", "--output", out]);
    expect(r.code).toBe(0);
    expect(existsSync(join(out, "shopify", "INSTALL.md"))).toBe(true);
    expect(existsSync(join(out, "nextjs"))).toBe(false);
  });

  function platformLine(stdout: string): string {
    return stdout.split("\n").find((l) => l.includes("Platform:")) ?? "";
  }

  it("a forced platform equal to the detected one keeps the confidence", async () => {
    const r = await run([
      "integrate",
      origin(nextSite),
      "--platform",
      "nextjs",
      "--output",
      outDir(),
    ]);
    expect(r.code).toBe(0);
    expect(platformLine(r.stdout)).toMatch(/Platform: Next\.js \(\d+% confidence\)/);
  });

  it("a forced platform that differs from the detected one shows no confidence and names the detected one", async () => {
    const r = await run([
      "integrate",
      origin(nextSite),
      "--platform",
      "astro",
      "--output",
      outDir(),
    ]);
    expect(r.code).toBe(0);
    const line = platformLine(r.stdout);
    expect(line).toContain("Platform: Astro (forced; detected Next.js)");
    expect(line).not.toContain("confidence");
  });

  it("a forced platform with nothing detected says forced", async () => {
    const r = await run([
      "integrate",
      origin(dead),
      "--platform",
      "shopify",
      "--output",
      outDir(),
      "--timeout",
      "3000",
    ]);
    expect(r.code).toBe(0);
    expect(platformLine(r.stdout)).toMatch(/Platform: Shopify \(forced\)\s*$/);
  });

  it("a zero-page crawl with a forced platform still writes the scaffolding", async () => {
    const out = outDir();
    const r = await run([
      "integrate",
      origin(dead),
      "--platform",
      "shopify",
      "--output",
      out,
      "--timeout",
      "3000",
    ]);
    expect(r.code).toBe(0);
    expect(existsSync(join(out, "shopify", "INSTALL.md"))).toBe(true);
    const install = readFileSync(join(out, "shopify", "INSTALL.md"), "utf-8");
    expect(install).toContain("no crawled product page");
  });
});
