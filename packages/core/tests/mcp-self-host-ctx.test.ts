import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGenerate } from "../src/generate/engine.js";
import type { GenerateOptions } from "../src/generate/types.js";
import { type Booted, bootFiles, listTools, type Variant } from "./helpers/mcp-boot.js";
import { CORE_DIR, killTracked } from "./helpers/mcp-harness.js";

const FAQ_HTML = readFileSync(join(CORE_DIR, "tests/fixtures/faq-page.html"), "utf-8");
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

let site: Server;
let origin = "";
let tmpRoot = "";
const closers: Array<() => void> = [];

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(CORE_DIR, ".tmp-mcp-selfhost-"));
  site = createServer((req, res) => {
    const routes: Record<string, string> = {
      "/": page(
        "Home",
        '<a href="/faq">FAQ</a><a href="/widget">Widget</a><a href="/subscribe">Subscribe</a>',
      ),
      "/faq": FAQ_HTML,
      "/widget": page("Widget", "", PRODUCT_LD),
      "/subscribe": page(
        "Subscribe",
        '<form action="https://forms.example.com/subscribe" method="post"><label for="e">Email</label><input id="e" name="email" type="email" required></form>',
      ),
    };
    const html = routes[req.url ?? ""];
    if (!html) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});

afterAll(() => {
  for (const c of closers) c();
  killTracked();
  site?.closeAllConnections();
  site?.close();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

async function toolNames(
  variant: Variant,
  extra: Partial<GenerateOptions>,
  label: string,
): Promise<string[]> {
  const result = await runGenerate(origin, {
    maxPages: 10,
    formats: ["mcp-server"],
    ...(variant === "express" ? {} : { mcpSelfHost: variant }),
    ...extra,
  });
  expect(result.pagesProcessed).toBeGreaterThan(1);
  const booted: Booted = await bootFiles(variant, result.files, join(tmpRoot, label), [
    ["https://forms.example.com", origin],
  ]);
  closers.push(booted.close);
  return (await listTools(booted.rpc)).map((t) => t.name as string).sort();
}

describe("runGenerate mcpSelfHost keeps the full crawl context", () => {
  let standalone: string[] = [];

  beforeAll(async () => {
    standalone = await toolNames(
      "express",
      { allowedOffOriginHosts: ["forms.example.com"] },
      "express",
    );
  }, 60000);

  it("standalone baseline has FAQ, product and off-origin form tools", () => {
    expect(standalone).toContain("search-faq");
    expect(standalone).toContain("submit-subscribe");
    expect(standalone.some((n) => n.includes("product"))).toBe(true);
    expect(standalone.length).toBeGreaterThan(3);
  });

  it.each(["cf", "vercel"] as const)("%s serves the same tool set as standalone", async (v) => {
    const names = await toolNames(v, { allowedOffOriginHosts: ["forms.example.com"] }, v);
    expect(names).toEqual(standalone);
  }, 60000);

  it.each([
    "cf",
    "vercel",
  ] as const)("%s without allowedOffOriginHosts omits only the off-origin form tool", async (v) => {
    const names = await toolNames(v, {}, `${v}-control`);
    expect(names).not.toContain("submit-subscribe");
    expect(names).toEqual(standalone.filter((n) => n !== "submit-subscribe"));
  }, 60000);
});
