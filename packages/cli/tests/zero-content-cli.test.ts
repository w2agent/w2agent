import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

const FAQ_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "How long does standard shipping take?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Standard shipping takes three to five business days within the country.",
      },
    },
    {
      "@type": "Question",
      name: "Can I return an unused product?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Unused products can be returned within thirty days for a full refund.",
      },
    },
  ],
};
const PRODUCT_LD = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Blue Widget",
  sku: "bw-1",
  offers: { "@type": "Offer", price: "5.00", priceCurrency: "USD", availability: "InStock" },
};

function page(title: string, body: string, ld?: unknown): string {
  const script = ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : "";
  return `<!doctype html><html><head><title>${title}</title>${script}</head><body><main><h1>${title}</h1><p>${title} page content for the loopback fixture.</p>${body}</main></body></html>`;
}

const RICH: Record<string, string> = {
  "/": page(
    "Home",
    '<a href="/faq">FAQ</a><a href="/widget">Widget</a><a href="/subscribe">Subscribe</a>',
  ),
  "/faq": page("FAQ", "<h2>Frequently asked questions</h2>", FAQ_LD),
  "/widget": page("Widget", "", PRODUCT_LD),
  "/subscribe": page(
    "Subscribe",
    '<form action="https://forms.example.com/subscribe" method="post"><label for="e">Email</label><input id="e" name="email" type="email" required></form>',
  ),
};

let rich: Server;
let empty: Server;
let richUrl = "";
let emptyUrl = "";
const dirs: string[] = [];

function listen(handler: Parameters<typeof createServer>[1]): Promise<Server> {
  const s = createServer(handler);
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

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
  const d = mkdtempSync(join(tmpdir(), "w2agent-zc-"));
  dirs.push(d);
  return d;
}

async function closedUrl(): Promise<string> {
  const s = await listen(() => {});
  const url = urlOf(s);
  await new Promise<void>((r) => s.close(() => r()));
  return url;
}

function listFiles(dir: string): string[] {
  return existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : [];
}

beforeAll(async () => {
  rich = await listen((req, res) => {
    const html = RICH[req.url ?? ""];
    if (!html) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  empty = await listen((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<html><head></head><body></body></html>");
  });
  richUrl = urlOf(rich);
  emptyUrl = urlOf(empty);
});

afterAll(async () => {
  for (const s of [rich, empty]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const skip = !existsSync(cliEntry);

describe("agent deploy --self-host keeps the crawled tool set (DEP-1)", () => {
  it.skipIf(skip).each(["cf", "vercel"])(
    "%s writes FAQ and product data and the off-origin form tool only with --allow-host",
    async (platform) => {
      const withHost = tmp();
      const a = await run(
        [
          "agent",
          "deploy",
          richUrl,
          "--self-host",
          platform,
          "--allow-host",
          "forms.example.com",
          "-o",
          "out",
        ],
        withHost,
      );
      expect(a.code).toBe(0);
      const data = join(withHost, "out", "mcp-server", "data");
      expect(existsSync(join(data, "faq.json"))).toBe(true);
      expect(existsSync(join(data, "products.json"))).toBe(true);
      const entry = platform === "cf" ? "worker.ts" : "api/mcp.ts";
      expect(readFileSync(join(withHost, "out", "mcp-server", entry), "utf-8")).toContain(
        "submit-subscribe",
      );

      const without = tmp();
      const b = await run(
        ["agent", "deploy", richUrl, "--self-host", platform, "-o", "out"],
        without,
      );
      expect(b.code).toBe(0);
      expect(existsSync(join(without, "out", "mcp-server", "data", "faq.json"))).toBe(true);
      expect(readFileSync(join(without, "out", "mcp-server", entry), "utf-8")).not.toContain(
        "submit-subscribe",
      );
    },
    120000,
  );
});

describe("zero usable pages write nothing and exit 1 (DEP-3, carry-over)", () => {
  it.skipIf(skip)("agent deploy against a dead host", async () => {
    const cwd = tmp();
    const { code, out } = await run(["agent", "deploy", await closedUrl(), "-o", "out"], cwd);
    expect(code).toBe(1);
    expect(out).toContain("No pages could be crawled");
    expect(out).toContain("nothing written");
    expect(listFiles(join(cwd, "out"))).toEqual([]);
  });

  it.skipIf(skip).each(["", "cf"])(
    "agent deploy against a 200 page with no content (self-host %j)",
    async (platform) => {
      const cwd = tmp();
      const args = [
        "agent",
        "deploy",
        emptyUrl,
        "-o",
        "out",
        ...(platform ? ["--self-host", platform] : []),
      ];
      const { code, out } = await run(args, cwd);
      expect(code).toBe(1);
      expect(out).toContain("extractable content");
      expect(out).toContain("nothing written");
      expect(listFiles(join(cwd, "out"))).toEqual([]);
    },
  );

  it.skipIf(skip)("generate llms-txt,full leaves an existing seed byte-identical", async () => {
    const cwd = tmp();
    const seed = "# Seed\n\n> hand-written llms.txt\n";
    writeFileSync(join(cwd, "llms.txt"), seed);
    const { code, out } = await run(
      ["generate", emptyUrl, "--format", "llms-txt,full", "--no-platform", "-o", "."],
      cwd,
    );
    expect(code).toBe(1);
    expect(out).toContain("nothing written");
    expect(out).toContain(emptyUrl);
    expect(readFileSync(join(cwd, "llms.txt"), "utf-8")).toBe(seed);
    expect(listFiles(cwd)).toEqual(["llms.txt"]);
  });

  it.skipIf(skip)("generate with default formats writes nothing", async () => {
    const cwd = tmp();
    const { code } = await run(["generate", emptyUrl, "--no-platform", "-o", "out"], cwd);
    expect(code).toBe(1);
    expect(listFiles(join(cwd, "out"))).toEqual([]);
  });

  it.skipIf(skip)("generate names --sections when given", async () => {
    const cwd = tmp();
    const { code, out } = await run(
      ["generate", emptyUrl, "--format", "llms-txt", "--sections", "docs", "-o", "out"],
      cwd,
    );
    expect(code).toBe(1);
    expect(out).toContain("--sections");
    expect(listFiles(join(cwd, "out"))).toEqual([]);
  });

  it.skipIf(skip)("non-content formats still write with a warning", async () => {
    const cwd = tmp();
    const { code, out } = await run(
      ["generate", emptyUrl, "--format", "robots-txt", "--no-platform", "-o", "out"],
      cwd,
    );
    expect(code).toBe(0);
    expect(out).toContain("extractable content");
    expect(listFiles(join(cwd, "out"))).toEqual(["robots.txt"]);
  });
});
