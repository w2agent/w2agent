import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchedPage } from "../src/audit/types.js";
import type { EcommerceArtifacts } from "../src/generate/ecommerce.js";
import { htmlToMarkdown } from "../src/generate/html-to-markdown.js";
import type { LocalBusinessArtifacts } from "../src/generate/local-business.js";
import { detectTools, generateMcpServer } from "../src/generate/mcp-server.js";
import type { GenerateContext } from "../src/generate/types.js";
import {
  type Booted,
  bootGenerated,
  callTool,
  listTools,
  VARIANTS,
  type Variant,
} from "./helpers/mcp-boot.js";
import { CORE_DIR, killTracked } from "./helpers/mcp-harness.js";

const SITE = "https://example.com";
const FORM_HOST = "https://forms.example.net";
const API_HOST = "https://api.example.net";

let tmpRoot = "";
let fixture: HttpServer;
let port = 0;
const closers: Array<() => void> = [];

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(CORE_DIR, ".tmp-mcp-cf-"));
  fixture = createHttpServer((_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end("ok");
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", () => r()));
  port = (fixture.address() as { port: number }).port;
});

afterAll(() => {
  for (const c of closers) c();
  killTracked();
  fixture?.closeAllConnections();
  fixture?.close();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

const faqHtml = readFileSync(join(CORE_DIR, "tests/fixtures/faq-page.html"), "utf-8");
const contactForm = `<form action="${FORM_HOST}/contact-submit" method="post"><label for="n">Name</label><input id="n" name="name" type="text" required></form>`;
const searchLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  url: `${SITE}/`,
  potentialAction: {
    "@type": "SearchAction",
    target: `${SITE}/find?q={search_term_string}`,
    "query-input": "required name=search_term_string",
  },
};

function rawPage(url: string, html: string): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 1 };
}

function buildCtx(): GenerateContext {
  const contactHtml = `<!doctype html><html><head><title>Contact</title></head><body><main><h1>Contact</h1>${contactForm}</main></body></html>`;
  const homeHtml = `<!doctype html><html><head><title>Home</title><script type="application/ld+json">${JSON.stringify(searchLd)}</script></head><body><main><h1>Home</h1></main></body></html>`;
  return {
    pages: [
      htmlToMarkdown(homeHtml, `${SITE}/`),
      htmlToMarkdown(contactHtml, `${SITE}/contact`),
      {
        url: `${SITE}/faq`,
        title: "FAQ",
        description: "Questions",
        markdown: "Frequently asked questions",
      },
    ],
    rawPages: [
      rawPage(`${SITE}/`, homeHtml),
      rawPage(`${SITE}/faq`, faqHtml),
      rawPage(`${SITE}/contact`, contactHtml),
    ],
    metadata: {
      baseUrl: SITE,
      wellKnown: {},
      openapi: {
        specUrl: `${API_HOST}/openapi.json`,
        version: "3.0.0",
        serverUrl: API_HOST,
        endpoints: [
          {
            path: "/pets/{petId}",
            method: "get",
            operationId: "getPet",
            summary: "Get a pet",
            parameters: [{ name: "petId", in: "path", required: true, type: "string" }],
          },
        ],
      } as any,
    },
    baseUrl: SITE,
    allowedOffOriginHosts: ["forms.example.net", "api.example.net"],
  };
}

const ecommerce: EcommerceArtifacts = {
  products: [
    {
      productId: "p_1",
      name: "Blue Widget",
      url: `${SITE}/widget`,
      price: 5,
      availability: "InStock",
      source: "json-ld",
    },
  ],
};

const localBusiness: LocalBusinessArtifacts = {
  business: {
    name: "Corner Cafe",
    type: "CafeOrCoffeeShop",
    url: SITE,
    hours: [{ days: ["Mon", "Tue"], opens: "08:00", closes: "17:00" }],
    menu: `${SITE}/menu`,
    services: `${SITE}/services`,
    bookingUrl: `${SITE}/book`,
    source: "json-ld",
  },
};

const artifacts = { ecommerce, localBusiness };

function readmeTools(booted: Booted): string[] {
  const readme = readFileSync(join(booted.dir, "README.md"), "utf-8");
  return [...readme.matchAll(/^- \*\*(.+?)\*\*:/gm)].map((m) => m[1]);
}

function sampleArgs(schema: any): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const name of schema?.required ?? []) {
    const p = schema.properties[name];
    if (p.enum) args[name] = p.enum[0];
    else if (p.type === "number") args[name] = 1;
    else if (p.type === "boolean") args[name] = true;
    else if (p.type === "array") args[name] = [];
    else args[name] = "x";
  }
  return args;
}

const post = (url: string, body: string, accept = "application/json, text/event-stream") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body,
  });

describe.each(VARIANTS)("tool parity: %s", (variant: Variant) => {
  let booted: Booted;
  let tools: any[] = [];
  const expected = detectTools(buildCtx(), ecommerce, localBusiness).tools.map((t) => t.name);

  beforeAll(async () => {
    booted = await bootGenerated(
      variant,
      buildCtx(),
      join(tmpRoot, `parity-${variant}`),
      [
        [FORM_HOST, `http://127.0.0.1:${port}`],
        [API_HOST, `http://127.0.0.1:${port}`],
      ],
      artifacts,
    );
    closers.push(booted.close);
    tools = await listTools(booted.rpc);
  }, 60000);

  it("tools/list, detected tools and the README list the same names", () => {
    const names = tools.map((t) => t.name as string);
    expect([...names].sort()).toEqual([...expected].sort());
    expect([...readmeTools(booted)].sort()).toEqual([...expected].sort());
    for (const n of [
      "search-faq",
      "get-hours",
      "get-menu",
      "get-services",
      "book-appointment",
      "site-search",
      "get-product",
      "get-pet",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("every listed tool is callable", async () => {
    // Lookup tools get ids that exist; form and OpenAPI tools hit the loopback fixture.
    const real: Record<string, Record<string, unknown>> = {
      "get-page": { url: `${SITE}/faq` },
      "get-product": { productId: "p_1" },
      "check-inventory": { productId: "p_1" },
      "get-reviews": { productId: "p_1" },
    };
    for (const t of tools) {
      const r = await callTool(booted.rpc, t.name, real[t.name] ?? sampleArgs(t.inputSchema));
      const label = `${t.name} -> ${JSON.stringify(r)}`;
      expect(r.error, label).toBeUndefined();
      expect(r.isError, label).toBe(false);
      expect(r.text, label).not.toMatch(/not found/i);
    }
  });

  it("serves the local business and FAQ data", async () => {
    expect((await callTool(booted.rpc, "get-hours")).text).toContain("08:00");
    expect((await callTool(booted.rpc, "get-menu")).text).toContain("/menu");
    expect((await callTool(booted.rpc, "book-appointment")).text).toContain("/book");
    expect((await callTool(booted.rpc, "search-faq", { query: "pricing" })).text).toContain(
      "Free, Pro, and Enterprise",
    );
  });

  it("get-product with an empty or blank id finds nothing", async () => {
    for (const productId of ["", "   "]) {
      const r = await callTool(booted.rpc, "get-product", { productId });
      expect(r.text).toBe("Product not found");
    }
    expect((await callTool(booted.rpc, "get-product", { productId: "p_1" })).text).toContain(
      "Blue Widget",
    );
  });
});

describe("cloudflare worker HTTP surface", () => {
  let booted: Booted;
  let worker: { fetch: (req: Request, env: unknown) => Promise<Response> };
  const data: Record<string, string> = {};
  const env = { MCP_DATA: { get: async (k: string) => data[k] ?? null } };

  beforeAll(async () => {
    booted = await bootGenerated(
      "cf",
      buildCtx(),
      join(tmpRoot, "surface-cf"),
      [
        [FORM_HOST, `http://127.0.0.1:${port}`],
        [API_HOST, `http://127.0.0.1:${port}`],
      ],
      artifacts,
    );
    for (const k of ["pages", "faq", "products", "business"]) {
      data[k] = readFileSync(join(booted.dir, "data", `${k}.json`), "utf-8");
    }
    worker = (await import(/* @vite-ignore */ pathToFileURL(join(booted.dir, "worker.mjs")).href))
      .default;
  }, 60000);

  const url = "http://127.0.0.1/mcp";

  it("answers a malformed body with a 400 parse error", async () => {
    const res = await worker.fetch(post(url, "{not json"), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("answers ping and acknowledges notifications with 202", async () => {
    const ping = await worker.fetch(
      post(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })),
      env,
    );
    expect(ping.status).toBe(200);
    expect((await ping.json()).result).toEqual({});
    const note = await worker.fetch(
      post(url, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })),
      env,
    );
    expect(note.status).toBe(202);
  });

  it("returns an invalid-argument result instead of throwing", async () => {
    const r = await callTool(
      async (b) =>
        (await worker.fetch(post(url, JSON.stringify(b)), env).then((x) => x.json())) as any,
      "search-site",
      { query: 42 },
    );
    expect(r.isError).toBe(true);
  });

  it("returns 503 JSON-RPC errors that name the missing KV data", async () => {
    for (const key of ["pages", "faq", "products", "business"]) {
      const partial = { ...data };
      delete partial[key];
      const res = await worker.fetch(
        post(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
        { MCP_DATA: { get: async (k: string) => partial[k] ?? null } },
      );
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.id).toBeNull();
      expect(body.error.message).toContain(key);
      expect(body.error.message).toContain("setup.sh");
    }
  });

  it("treats unparseable and JSON-null KV values as unusable", async () => {
    for (const key of ["pages", "faq", "products", "business"]) {
      for (const bad of ["null", "{not json"]) {
        const res = await worker.fetch(
          post(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
          { MCP_DATA: { get: async (k: string) => (k === key ? bad : (data[k] ?? null)) } },
        );
        expect(res.status, `${key}=${bad}`).toBe(503);
        const body = await res.json();
        expect(body.id).toBeNull();
        expect(body.error.message).toContain(key);
        expect(body.error.message).toContain("setup.sh");
      }
    }
  });

  it("rejects GET and DELETE with 405 and an Allow header", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await worker.fetch(new Request(url, { method }), env);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect((await res.json()).jsonrpc).toBe("2.0");
    }
  });

  it("keeps the .well-known redirect and 404s other paths", async () => {
    const res = await worker.fetch(new Request("http://127.0.0.1/.well-known/mcp"), env);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://127.0.0.1/mcp");
    expect((await worker.fetch(new Request("http://127.0.0.1/other"), env)).status).toBe(404);
  });
});

describe("cloudflare setup.sh uploads exactly the keys the worker requires", () => {
  const cases: Array<
    [string, GenerateContext, EcommerceArtifacts | undefined, LocalBusinessArtifacts | undefined]
  > = [
    ["all features", buildCtx(), ecommerce, localBusiness],
    [
      "local business only",
      {
        pages: [{ url: `${SITE}/`, title: "Home", description: "", markdown: "hi" }],
        rawPages: [],
        metadata: { baseUrl: SITE, wellKnown: {} },
        baseUrl: SITE,
      },
      undefined,
      localBusiness,
    ],
  ];

  it.each(cases)("%s", (_name, ctx, eco, lb) => {
    const files = generateMcpServer(ctx, "cf", eco, lb);
    const content = (f: string) =>
      files.find((x) => x.filename === `mcp-server/${f}`)?.content ?? "";
    const workerKeys = JSON.parse(
      /const KV_KEYS = (\[.*?\]);/.exec(content("worker.ts"))?.[1] ?? "null",
    );
    const setupKeys = [
      ...content("setup.sh").matchAll(/kv key put --binding MCP_DATA "([^"]+)"/g),
    ].map((m) => m[1]);
    expect(workerKeys).toContain("business");
    expect(setupKeys).toEqual(workerKeys);
    for (const k of workerKeys)
      expect(files.some((x) => x.filename === `mcp-server/data/${k}.json`)).toBe(true);
  });
});
