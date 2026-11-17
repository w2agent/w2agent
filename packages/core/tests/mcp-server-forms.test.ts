import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchedPage } from "../src/audit/types.js";
import { htmlToMarkdown } from "../src/generate/html-to-markdown.js";
import { detectTools, generateMcpServer } from "../src/generate/mcp-server.js";
import type { GenerateContext } from "../src/generate/types.js";
import { parseOpenAPISpec } from "../src/shared/openapi.js";
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

interface Hit {
  method: string;
  url: string;
  body: string;
  contentType: string;
}

let tmpRoot = "";
let fixture: HttpServer;
let port = 0;
let hits: Hit[] = [];
const closers: Array<() => void> = [];

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(CORE_DIR, ".tmp-mcp-forms-"));
  fixture = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      hits.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        contentType: String(req.headers["content-type"] ?? ""),
      });
      res.setHeader("connection", "close");
      res.end("fixture-ok");
    });
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

const searchForm = `<form action="${FORM_HOST}/find" method="get"><input type="search" name="query" aria-label="Search"></form>`;

const contactForm = `<form action="${FORM_HOST}/contact-submit" method="post">
<label for="n">Name</label><input id="n" name="name" type="text" required>
<input name="subscribe" type="checkbox" value="yes" aria-label="Subscribe">
<input name="plan" type="radio" value="free"><input name="plan" type="radio" value="pro" required><input name="plan" type="radio" value="team">
<input name="topics" type="checkbox" value="news"><input name="topics" type="checkbox" value="deals">
<select name="size"><option value="">-</option><option value="s">Small</option><option value="l">Large</option></select>
<input name="qty" type="number">
<input type="hidden" name="csrf" value="crawled-token">
<input type="submit" name="go" value="Send">
</form>`;

const lookupForm = `<form action="${FORM_HOST}/lookup?stale=1&x=2" method="GET"><input name="q" type="text"><input name="flag" type="checkbox"></form>`;
const upperPost = `<form action="${FORM_HOST}/legacy" method="POST"><input name="note" type="text"></form>`;
const loginNamed = `<form action="${FORM_HOST}/login" method="post"><input name="user" type="text"><input name="pass" type="password"></form>`;
const loginUnnamed = `<form action="${FORM_HOST}/login2" method="post"><input name="user" type="text"><input type="password"></form>`;
const uploadRequired = `<form action="${FORM_HOST}/upload-req" method="post"><input name="title" type="text"><input name="doc" type="file" required></form>`;
const uploadOptional = `<form action="${FORM_HOST}/upload-opt" method="post"><input name="title" type="text"><input name="doc" type="file"></form>`;
const protoForm = `<form action="${FORM_HOST}/proto" method="get"><input name="__proto__"><input name="constructor"><input name="kept"></form>`;
const dialogForm = `<form action="${FORM_HOST}/dialog" method="dialog"><input name="ok" type="text"></form>`;

function pageHtml(title: string, forms: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${forms}</main></body></html>`;
}

const SEARCH_TEMPLATE = `${SITE}/find?query={search_term_string}&alt={search_term_string}`;

function jsonLdHtml(graph: unknown): string {
  return `<!doctype html><html><head><title>Home</title><script type="application/ld+json">${JSON.stringify(graph)}</script></head><body></body></html>`;
}

const yoastGraph = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", name: "Acme" },
    {
      "@type": ["WebSite"],
      url: `${SITE}/`,
      potentialAction: [
        {
          "@type": "SearchAction",
          target: { "@type": "EntryPoint", urlTemplate: SEARCH_TEMPLATE },
          "query-input": "required name=search_term_string",
        },
      ],
    },
  ],
};

function rawPage(url: string, html: string): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 1 };
}

function buildFormsCtx(): GenerateContext {
  const pages = [
    { url: `${SITE}/`, html: pageHtml("Home", searchForm) },
    { url: `${SITE}/a`, html: pageHtml("A", searchForm) },
    { url: `${SITE}/b`, html: pageHtml("B", searchForm) },
    { url: `${SITE}/contact`, html: pageHtml("Contact", contactForm + lookupForm + upperPost) },
    { url: `${SITE}/login`, html: pageHtml("Login", loginNamed + loginUnnamed) },
    {
      url: `${SITE}/upload`,
      html: pageHtml("Upload", uploadRequired + uploadOptional + protoForm),
    },
    { url: `${SITE}/dialog`, html: pageHtml("Dialog", dialogForm) },
  ].map((p) => htmlToMarkdown(p.html, p.url));
  return {
    pages,
    rawPages: [rawPage(`${SITE}/`, jsonLdHtml(yoastGraph))],
    metadata: { baseUrl: SITE, wellKnown: {} },
    baseUrl: SITE,
    allowedOffOriginHosts: ["forms.example.net"],
  };
}

const parseForm = (body: string): Array<[string, string]> => [...new URLSearchParams(body)];

describe.each(VARIANTS)("generated form tools and site-search: %s", (variant: Variant) => {
  let booted: Booted;
  let tools: any[] = [];

  beforeAll(async () => {
    booted = await bootGenerated(variant, buildFormsCtx(), join(tmpRoot, `forms-${variant}`), [
      [FORM_HOST, `http://127.0.0.1:${port}`],
    ]);
    closers.push(booted.close);
    tools = await listTools(booted.rpc);
  }, 60000);

  const names = () => tools.map((t) => t.name as string);
  const tool = (name: string) => tools.find((t) => t.name === name);

  it("makes one tool for a form repeated on several pages", () => {
    expect(names().filter((n) => n.startsWith("submit-find"))).toEqual(["submit-find"]);
  });

  it("exposes no tool for password, required-file or dialog forms", () => {
    for (const n of ["submit-login", "submit-login2", "submit-upload-req", "submit-dialog"]) {
      expect(names()).not.toContain(n);
    }
    expect(JSON.stringify(tools)).not.toContain('"pass"');
  });

  it("never offers an optional file input as a parameter", () => {
    const props = Object.keys(tool("submit-upload-opt").inputSchema.properties);
    expect(props).toEqual(["title"]);
  });

  it("describes the normalised method and sets GET/POST annotations", () => {
    expect(tool("submit-find").description).toBe(`Submit form: GET http://127.0.0.1:${port}/find`);
    expect(tool("submit-find").annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(tool("submit-contact-submit").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("publishes a schema with boolean checkbox, enum radio, array group, number", () => {
    const schema = tool("submit-contact-submit").inputSchema;
    expect(schema.properties.subscribe.type).toBe("boolean");
    expect(schema.properties.plan.enum).toEqual(["free", "pro", "team"]);
    expect(schema.properties.topics.type).toBe("array");
    expect(schema.properties.topics.items.enum).toEqual(["news", "deals"]);
    expect(schema.properties.size.enum).toEqual(["s", "l"]);
    expect(schema.properties.qty.type).toBe("number");
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["name", "plan", "qty", "size", "subscribe", "topics"].sort(),
    );
    expect([...schema.required].sort()).toEqual(["name", "plan"]);
  });

  it("sends a GET form as a GET with the query and no body", async () => {
    hits = [];
    const r = await callTool(booted.rpc, "submit-find", { query: "a b&c" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("fixture-ok");
    expect(hits).toHaveLength(1);
    expect(hits[0].method).toBe("GET");
    expect(hits[0].url).toBe("/find?query=a+b%26c");
    expect(hits[0].body).toBe("");
  });

  it("replaces the action's own query on GET and serialises a checkbox as its value", async () => {
    hits = [];
    await callTool(booted.rpc, "submit-lookup", { q: "x", flag: true });
    await callTool(booted.rpc, "submit-lookup", { q: "y", flag: false });
    expect(hits.map((h) => `${h.method} ${h.url}`)).toEqual([
      "GET /lookup?q=x&flag=on",
      "GET /lookup?q=y",
    ]);
  });

  it("sends a POST form urlencoded with only the successful controls", async () => {
    hits = [];
    const r = await callTool(booted.rpc, "submit-contact-submit", {
      name: "alpha",
      subscribe: true,
      plan: "pro",
      topics: ["news", "deals"],
      size: "l",
      qty: 3,
    });
    expect(r.isError).toBe(false);
    expect(hits).toHaveLength(1);
    expect(hits[0].method).toBe("POST");
    expect(hits[0].contentType).toBe("application/x-www-form-urlencoded");
    expect(parseForm(hits[0].body)).toEqual([
      ["name", "alpha"],
      ["subscribe", "yes"],
      ["plan", "pro"],
      ["topics", "news"],
      ["topics", "deals"],
      ["size", "l"],
      ["qty", "3"],
    ]);
  });

  it("omits unset optionals, false checkboxes and never sends the crawled hidden value", async () => {
    hits = [];
    await callTool(booted.rpc, "submit-contact-submit", {
      name: "beta",
      subscribe: false,
      plan: "free",
    });
    expect(parseForm(hits[0].body)).toEqual([
      ["name", "beta"],
      ["plan", "free"],
    ]);
    expect(hits[0].body).not.toContain("csrf");
  });

  it("rejects a radio value or group member that is not an option, without a request", async () => {
    hits = [];
    const bad = await callTool(booted.rpc, "submit-contact-submit", {
      name: "gamma",
      plan: "enterprise",
    });
    const badGroup = await callTool(booted.rpc, "submit-contact-submit", {
      name: "gamma",
      plan: "pro",
      topics: ["spam"],
    });
    expect(bad.isError || bad.error !== undefined).toBe(true);
    expect(badGroup.isError || badGroup.error !== undefined).toBe(true);
    expect(hits).toEqual([]);
  });

  it("uppercase POST keeps POST", async () => {
    hits = [];
    await callTool(booted.rpc, "submit-legacy", { note: "hi" });
    expect(hits[0].method).toBe("POST");
    expect(hits[0].body).toBe("note=hi");
  });

  it("prototype-key field names are not parameters in any variant", async () => {
    expect(Object.keys(tool("submit-proto").inputSchema.properties)).toEqual(["kept"]);
    hits = [];
    const r = await callTool(booted.rpc, "submit-proto", { kept: "v" });
    expect(r.isError).toBe(false);
    expect(hits.map((h) => h.url)).toEqual(["/proto?kept=v"]);
  });

  it("site-search reports an error for a missing or unencodable query, without a request", async () => {
    hits = [];
    const missing = await callTool(booted.rpc, "site-search", {});
    const lone = await callTool(booted.rpc, "site-search", { query: "\ud800" });
    expect(missing.isError || missing.error !== undefined).toBe(true);
    expect(lone.isError || lone.error !== undefined).toBe(true);
    expect(missing.text).not.toContain("query=&");
    expect(hits).toEqual([]);
  });

  it("site-search returns the template URL with every placeholder encoded, no fetch", async () => {
    hits = [];
    const query = "cats & dogs #1 100%";
    const r = await callTool(booted.rpc, "site-search", { query });
    expect(r.isError).toBe(false);
    const encoded = encodeURIComponent(query);
    expect(r.text).toBe(`${SITE}/find?query=${encoded}&alt=${encoded}`);
    const u = new URL(r.text);
    expect(u.searchParams.get("query")).toBe(query);
    expect(u.searchParams.get("alt")).toBe(query);
    expect(u.hash).toBe("");
    expect(hits).toEqual([]);
    expect(tool("site-search").description).toBe(
      "Get the site's native search URL for a query (via SearchAction)",
    );
  });
});

describe("generated Express server with grouped fields", () => {
  it("type-checks: no duplicate keys for radios or checkbox groups", async () => {
    const root = join(tmpRoot, "forms-tsc");
    const booted = await bootGenerated("express", buildFormsCtx(), root, [
      [FORM_HOST, `http://127.0.0.1:${port}`],
    ]);
    closers.push(booted.close);
    const server = generateMcpServer(buildFormsCtx()).find((f) =>
      f.filename.endsWith("server.ts"),
    )?.content;
    expect(server?.split('["plan"]:').length).toBe(2);
    execFileSync(
      join(CORE_DIR, "node_modules/.bin/tsc"),
      ["--noEmit", "-p", join(booted.dir, "tsconfig.json")],
      { stdio: "pipe" },
    );
  }, 90000);
});

describe("form action policy and dedupe", () => {
  const ctxWith = (htmls: string[]): GenerateContext => ({
    pages: htmls.map((h, i) => htmlToMarkdown(pageHtml(`P${i}`, h), `${SITE}/p${i}`)),
    rawPages: [],
    metadata: { baseUrl: SITE, wellKnown: {} },
    baseUrl: SITE,
    allowedOffOriginHosts: ["forms.example.net"],
  });
  const formNames = (htmls: string[]) =>
    detectTools(ctxWith(htmls))
      .tools.filter((t) => t.condition === "hasForm")
      .map((t) => t.name);
  const get = (action: string) =>
    `<form action="${action}" method="get"><input name="q" type="text"></form>`;
  const post = (action: string) =>
    `<form action="${action}" method="post"><input name="q" type="text"></form>`;

  it("drops forms whose action carries credentials", () => {
    const ctx = ctxWith([post(`https://user:pw@forms.example.net/cred`)]);
    expect(detectTools(ctx).forms).toEqual([]);
    const server = generateMcpServer(ctx)
      .map((f) => f.content)
      .join("\n");
    expect(server).not.toContain("user:pw");
  });

  it("keys dedupe on the requested URL: no fragment, and no query for GET", () => {
    expect(formNames([get("/find"), get("/find?utm=1"), get("/find#top")])).toHaveLength(1);
    expect(formNames([post("/c"), post("/c#x")])).toHaveLength(1);
    expect(formNames([post("/c"), post("/c?v=1")])).toHaveLength(2);
    expect(formNames([get("/c"), post("/c")])).toHaveLength(2);
  });
});

describe("SearchAction detection", () => {
  const ctxFor = (html: string, allowed: string[] = []): GenerateContext => ({
    pages: [],
    rawPages: [rawPage(`${SITE}/`, html)],
    metadata: { baseUrl: SITE, wellKnown: {} },
    baseUrl: SITE,
    allowedOffOriginHosts: allowed,
  });
  const action = (target: unknown, queryInput: unknown = "required name=search_term_string") =>
    jsonLdHtml({
      "@type": "WebSite",
      potentialAction: { "@type": "SearchAction", target, "query-input": queryInput },
    });
  const found = (html: string, allowed?: string[]) =>
    detectTools(ctxFor(html, allowed)).searchAction;
  const T = "{search_term_string}";

  it("finds a Yoast-style @graph with an array potentialAction", () => {
    expect(detectTools(ctxFor(jsonLdHtml(yoastGraph))).searchAction).toEqual({
      template: SEARCH_TEMPLATE,
      placeholder: "search_term_string",
    });
  });

  it("accepts a string target, an array @type, a target array and a custom placeholder", () => {
    expect(found(action(`${SITE}/s?q=${T}`))?.template).toBe(`${SITE}/s?q=${T}`);
    const arrType = jsonLdHtml({
      "@type": "WebSite",
      potentialAction: {
        "@type": ["SearchAction"],
        target: `${SITE}/s?k={term}`,
        "query-input": "name=term",
      },
    });
    expect(found(arrType)).toEqual({ template: `${SITE}/s?k={term}`, placeholder: "term" });
    const targets = action([
      { urlTemplate: "https://evil.test/s?q={search_term_string}" },
      `${SITE}/ok?q=${T}`,
    ]);
    expect(found(targets)?.template).toBe(`${SITE}/ok?q=${T}`);
    expect(found(action(`/rel?q=${T}`))?.template).toBe(`${SITE}/rel?q=${T}`);
  });

  it.each([
    ["off-origin host", `https://evil.test/s?q=${T}`],
    ["private host", `http://169.254.169.254/s?q=${T}`],
    ["placeholder in host", `https://${T}.example.com/s?q=${T}`],
    ["placeholder in path only", `${SITE}/s/${T}`],
    ["placeholder in path and query", `${SITE}/${T}/s?q=${T}`],
    ["placeholder in port", `https://example.com:${T}/s?q=${T}`],
    ["placeholder in fragment", `${SITE}/s?q=1#${T}`],
    ["fragment before query", `${SITE}/#/s?q=${T}`],
    ["userinfo", `https://user:pw@example.com/s?q=${T}`],
    ["extra variable", `${SITE}/s?q=${T}&lang={lang}`],
    ["javascript scheme", `javascript:alert(1)?q=${T}`],
    ["backslash", `${SITE}\\@evil.test/s?q=${T}`],
    ["no placeholder", `${SITE}/s?q=fixed`],
    ["protocol-relative", `//evil.test/s?q=${T}`],
  ])("rejects %s", (_label, target) => {
    const html = action(target);
    expect(found(html)).toBeUndefined();
    expect(detectTools(ctxFor(html)).tools.map((t) => t.name)).not.toContain("site-search");
    const server = generateMcpServer(ctxFor(html)).find((f) => f.filename.endsWith("server.ts"));
    expect(server?.content).not.toContain("site-search");
  });

  it("uses an object query-input valueName as the placeholder", () => {
    const html = action(`${SITE}/s?k={term}`, {
      "@type": "PropertyValueSpecification",
      valueName: "term",
    });
    expect(found(html)).toEqual({ template: `${SITE}/s?k={term}`, placeholder: "term" });
    expect(found(action(`${SITE}/s?k={term}`, { valueName: "te rm" }))).toBeUndefined();
  });

  it("returns the WHATWG-normalised template", () => {
    expect(found(action(`https:example.com/a/../s?q=${T}#`))?.template).toBe(`${SITE}/s?q=${T}#`);
    expect(found(action(`HTTPS://EXAMPLE.com:443/s?q=${T}`))?.template).toBe(`${SITE}/s?q=${T}`);
  });

  it("still finds the action after a large run of plain values", () => {
    const html = jsonLdHtml({
      "@graph": [
        { "@type": "ItemList", keywords: Array.from({ length: 6000 }, (_, i) => `k${i}`) },
        {
          "@type": "WebSite",
          potentialAction: { "@type": "SearchAction", target: `${SITE}/s?q=${T}` },
        },
      ],
    });
    expect(found(html)?.template).toBe(`${SITE}/s?q=${T}`);
  });

  it("accepts an off-origin host only when allowlisted", () => {
    const html = action(`https://search.partner.test/s?q=${T}`);
    expect(found(html)).toBeUndefined();
    expect(found(html, ["search.partner.test"])?.template).toBe(
      `https://search.partner.test/s?q=${T}`,
    );
  });
});

describe("OpenAPI server URL pins (relative servers.url and Swagger 2 basePath)", () => {
  const op = {
    get: {
      operationId: "getItem",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    },
  };
  const specs: Array<[string, Record<string, unknown>, string]> = [
    [
      "OpenAPI 3 relative servers.url",
      { openapi: "3.0.0", servers: [{ url: "/api/v1" }], paths: { "/items/{id}": op } },
      "/api/v1",
    ],
    [
      "Swagger 2 basePath",
      {
        swagger: "2.0",
        basePath: "/v2",
        paths: {
          "/items/{id}": {
            get: {
              operationId: "getItem",
              parameters: [{ name: "id", in: "path", required: true, type: "string" }],
            },
          },
        },
      },
      "/v2",
    ],
  ];

  describe.each(specs)("%s", (_label, spec, prefix) => {
    describe.each(VARIANTS)("%s", (variant) => {
      let booted: Booted;
      beforeAll(async () => {
        const openapi = parseOpenAPISpec(spec, `${SITE}/openapi.json`, { baseUrl: SITE });
        expect(openapi).not.toBeNull();
        const ctx: GenerateContext = {
          pages: [],
          rawPages: [],
          metadata: { baseUrl: SITE, wellKnown: {}, openapi: openapi ?? undefined },
          baseUrl: SITE,
          allowedOffOriginHosts: [],
        };
        booted = await bootGenerated(
          variant,
          ctx,
          join(tmpRoot, `api-${prefix.slice(1)}-${variant}`),
          [[SITE, `http://127.0.0.1:${port}`]],
        );
        closers.push(booted.close);
      }, 60000);

      it("resolves the server URL against the site and encodes the path parameter", async () => {
        hits = [];
        const r = await callTool(booted.rpc, "get-item", { id: "a b/c" });
        expect(r.isError).toBe(false);
        expect(hits.map((h) => `${h.method} ${h.url}`)).toEqual([`GET ${prefix}/items/a%20b%2Fc`]);
      });
    });
  });
});
