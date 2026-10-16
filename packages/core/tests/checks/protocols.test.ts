import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionSchemas,
  apiEndpoints,
  formsStructured,
  mcpDiscovery,
  webmcpDeclarative,
  webmcpImperative,
  wellKnownUcp,
} from "../../src/audit/checks/protocols.js";
import { runAudit } from "../../src/audit/engine.js";
import type { Check, FetchedPage, SiteMetadata } from "../../src/audit/types.js";

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

const basePage: FetchedPage = {
  url: "https://example.com",
  status: 200,
  html: "<html><body>test</body></html>",
  headers: {},
  responseTime: 100,
};

describe("mcp-discovery", () => {
  const ENDPOINT = "https://mcp.example.com/mcp";

  it("fails when no MCP endpoint was confirmed", async () => {
    const result = await mcpDiscovery.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.message).not.toContain("well-known");
  });

  it.each([
    ["a JSON body at /.well-known/mcp", { ...baseMeta, wellKnown: { mcp: '{"endpoints": []}' } }],
    [
      "an unconfirmed probe result",
      { ...baseMeta, mcpInit: { mcpEndpointUrl: ENDPOINT, success: false, status: 405 } },
    ],
  ])("fails without the mcpEndpoint sentinel, even with %s", async (_label, meta) => {
    const result = await mcpDiscovery.run([basePage], meta as SiteMetadata);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });

  it("scores 100 for a handshake-confirmed endpoint and names the server and URL", async () => {
    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      mcpEndpoint: ENDPOINT,
      mcpInit: {
        mcpEndpointUrl: ENDPOINT,
        success: true,
        status: 200,
        transport: "streamable-http",
        serverInfo: { name: "test-server", version: "1.0.0" },
      },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("test-server");
    expect(result.details).toContain("test-server");
    expect(result.details).toContain(ENDPOINT);
  });

  it("scores 100 for a modern endpoint confirmed without serverInfo (e.g. -32022 error)", async () => {
    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      mcpEndpoint: ENDPOINT,
      mcpInit: {
        mcpEndpointUrl: ENDPOINT,
        success: false,
        status: 400,
        transport: "streamable-http",
      },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.details).toContain(ENDPOINT);
  });

  it("scores 75 for an auth-gated endpoint (401 + Bearer)", async () => {
    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      mcpEndpoint: ENDPOINT,
      mcpInit: {
        mcpEndpointUrl: ENDPOINT,
        success: false,
        status: 401,
        transport: "streamable-http",
      },
    });
    expect(result).toMatchObject({ status: "pass", score: 75 });
    expect(result.details).toContain(ENDPOINT);
  });

  it("scores partial 50 for the deprecated HTTP+SSE transport", async () => {
    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      mcpEndpoint: ENDPOINT,
      mcpInit: { mcpEndpointUrl: ENDPOINT, success: false, status: 200, transport: "http+sse" },
    });
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toMatch(/deprecated/i);
    expect(result.details).toContain(ENDPOINT);
  });

  it("scores partial 50, not 75, for an auth-gated HTTP+SSE-only endpoint (deprecated transport wins)", async () => {
    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      mcpEndpoint: ENDPOINT,
      mcpInit: { mcpEndpointUrl: ENDPOINT, success: false, status: 401, transport: "http+sse" },
    });
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toMatch(/deprecated/i);
  });
});

describe("forms-structured", () => {
  it("skips when no forms", () => {
    const result = formsStructured.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "skip", score: 100 });
  });

  it("passes with well-structured forms", () => {
    const html = `<html><body><form>
      <label for="name">Name</label>
      <input id="name" name="name" type="text" />
      <label for="email">Email</label>
      <input id="email" name="email" type="email" />
      <input type="submit" value="Submit" />
    </form></body></html>`;
    const result = formsStructured.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails with poorly structured forms", () => {
    const html = `<html><body><form>
      <input type="text" />
      <input type="email" />
    </form></body></html>`;
    const result = formsStructured.run([{ ...basePage, html }], baseMeta);
    expect(result.score).toBeLessThan(100);
  });
});

describe("action-schemas", () => {
  it("detects action schemas in JSON-LD", () => {
    const html = readFileSync(resolve(__dirname, "../fixtures/with-schema.html"), "utf-8");
    const result = actionSchemas.run([{ ...basePage, html }], baseMeta);
    expect(result.score).toBeGreaterThan(0);
  });

  it("fails without action schemas", () => {
    const result = actionSchemas.run([basePage], baseMeta);
    expect(result.score).toBe(0);
  });
});

describe("well-known-ucp", () => {
  // Trimmed live profile from https://www.allbirds.com/.well-known/ucp (Shopify default, 2026-09-14).
  const ALLBIRDS = readFileSync(resolve(__dirname, "../fixtures/ucp-allbirds.json"), "utf-8");
  const runUcp = (body: string | undefined) =>
    wellKnownUcp.run([basePage], { ...baseMeta, wellKnown: { ucp: body } });
  const withUcp = (edit: (ucp: Record<string, unknown>) => void) => {
    const doc = JSON.parse(ALLBIRDS);
    edit(doc.ucp);
    return JSON.stringify(doc);
  };

  it("passes a real Shopify-default profile (version date + services + payment_handlers)", () => {
    expect(runUcp(ALLBIRDS)).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails 0 when no profile was fetched", () => {
    const result = runUcp(undefined);
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.message).toMatch(/No UCP/);
  });

  // Existence alone earns nothing: an agent can't transact without a dated version, a service
  // endpoint, and a payment handler, so each missing piece zeroes the check and is named.
  it.each([
    ["version is not a date", (u: Record<string, unknown>) => (u.version = "1.0"), /version/],
    ["version missing", (u: Record<string, unknown>) => delete u.version, /version/],
    ["services missing", (u: Record<string, unknown>) => delete u.services, /services/],
    ["services empty", (u: Record<string, unknown>) => (u.services = {}), /services/],
    [
      "services value not an array",
      (u: Record<string, unknown>) => (u.services = { "dev.ucp.shopping": { transport: "mcp" } }),
      /services/,
    ],
    [
      "payment_handlers missing",
      (u: Record<string, unknown>) => delete u.payment_handlers,
      /payment_handlers/,
    ],
    [
      "payment_handlers empty",
      (u: Record<string, unknown>) => (u.payment_handlers = {}),
      /payment_handlers/,
    ],
    [
      "payment_handlers value not an array",
      (u: Record<string, unknown>) => (u.payment_handlers = { "com.google.pay": {} }),
      /payment_handlers/,
    ],
  ])("fails 0 when %s", (_label, edit, named) => {
    const result = runUcp(withUcp(edit));
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.message).toMatch(named);
  });

  it("names only the invalid field (a valid version is not reported)", () => {
    const result = runUcp(withUcp((u) => delete u.payment_handlers));
    expect(result.message).not.toMatch(/version|services/);
  });

  it.each([
    "{}",
    '{"ucp": {"version": "2026-08-25"}}',
    '{"ucp": {"version": "1.0", "services": {"a": []}, "payment_handlers": {"b": []}}}',
    "[]",
    "true",
    '"ucp"',
    '{"version": "1.0"}',
    '{"ucp": []}',
    '{"ucp": "2026-08-25"}',
    '{"error":"not found","path":"/.well-known/ucp"}',
  ])("fails when the body is not a valid ucp profile (%s)", (body) => {
    expect(runUcp(body)).toMatchObject({ status: "fail", score: 0 });
  });
});

// WebMCP is an origin-trial API that moved from navigator to document.modelContext
// mid-cycle (CG draft 2026-09-10): tracked at weight 0 so adoption is reported without
// moving anyone's score. Renderers hide tracked skips, so "nothing found" must be skip.
describe("webmcp-declarative", () => {
  const page = (body: string): FetchedPage => ({
    ...basePage,
    html: `<html><body>${body}</body></html>`,
  });

  it("is tracked at weight 0 on the definition and in results; no forms → skip 0", () => {
    expect(webmcpDeclarative).toMatchObject({ weight: 0, tracked: true });
    const result = webmcpDeclarative.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "skip", score: 0, weight: 0, tracked: true });
  });

  it("excludes unannotated search, login and newsletter forms from the denominator; every toolname form counts", () => {
    const html = `
      <form role="search" toolname="siteSearch"><input type="text" name="term" /></form>
      <form action="/login"><input type="text" name="user" /><input type="password" name="pw" /></form>
      <form action="/subscribe"><input type="email" name="email" /><button type="submit">Go</button></form>
      <form action="/book" toolname="bookTable"><input name="date" type="date" /><input name="party" type="number" /></form>
      <form action="/contact"><input name="name" /><textarea name="msg"></textarea></form>`;
    const result = webmcpDeclarative.run([page(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100, tracked: true });
    expect(result.message).toBe("2/3 task forms declare WebMCP tools");
    expect(result.details).toContain('https://example.com: <form toolname="bookTable">');
    expect(result.details).toContain('https://example.com: <form toolname="siteSearch">');
    expect(result.details).not.toContain("not counted");
  });

  it.each([
    ["role=search on the form", '<form role="search"><input name="term" /></form>'],
    ["an ancestor <search> element", '<search><form><input name="term" /></form></search>'],
    [
      "an input[type=search]",
      '<form><input type="search" name="k" /><select name="c"></select></form>',
    ],
    ["a lone text input named q", '<form><input name="q" /><button>Go</button></form>'],
    ["a lone text input named query", '<form><input type="text" name="query" /></form>'],
    ["a lone text input named s", '<form><input type="text" name="s" /></form>'],
    ["a password input", '<form><input name="user" /><input type="password" name="pw" /></form>'],
    ["a single email input", '<form><input type="email" name="e" /><input type="submit" /></form>'],
  ])("excludes a form with %s from the task-form count", (_label, form) => {
    const tagged = `${form}<form toolname="t"><input name="a" /><input name="b" /></form>`;
    expect(webmcpDeclarative.run([page(tagged)], baseMeta).message).toContain("1/1 task forms");
  });

  it("a toolname on a search-shaped form counts in both numerator and denominator", () => {
    const html = '<form role="search" toolname="siteSearch"><input name="q" /></form>';
    const result = webmcpDeclarative.run([page(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toBe("1/1 task forms declare WebMCP tools");
  });

  // A site that annotated its checkout and signup forms declared real tools; "0/0" would
  // read as "no task forms" and contradict the pass.
  it("toolname forms shaped like newsletter or login forms are never reported as 0/0", () => {
    const html = `
      <form action="/checkout/email" toolname="setCheckoutEmail"><input type="hidden" name="cart" value="1" /><input type="email" name="email" /><button>Next</button></form>
      <form action="/signup" toolname="createAccount"><input type="email" name="email" /><input type="password" name="pw" /></form>`;
    const result = webmcpDeclarative.run([page(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toBe("2/2 task forms declare WebMCP tools");
    expect(result.details).not.toContain("not counted");
  });

  it("a text input named query in a multi-field support form does not make it a search form", () => {
    const html = `
      <form action="/support"><input type="text" name="query" /><input type="email" name="email" /><textarea name="details"></textarea></form>
      <form toolname="t"><input name="a" /><input name="b" /></form>`;
    expect(webmcpDeclarative.run([page(html)], baseMeta).message).toBe(
      "1/2 task forms declare WebMCP tools",
    );
  });

  it("a newsletter form with a name field besides the email is a task form", () => {
    const html =
      '<form><input type="text" name="name" /><input type="email" name="email" /></form><form toolname="t"><input name="a" /><input name="b" /></form>';
    expect(webmcpDeclarative.run([page(html)], baseMeta).message).toContain("1/2 task forms");
  });

  it("skips when only search/login/newsletter forms exist and none declares a tool", () => {
    const html = `
      <form role="search"><input name="q" /></form>
      <form><input name="user" /><input type="password" name="pw" /></form>
      <form><input type="email" name="email" /></form>`;
    expect(webmcpDeclarative.run([page(html)], baseMeta)).toMatchObject({
      status: "skip",
      score: 0,
      tracked: true,
    });
  });

  it("skips when task forms exist but none declares a tool", () => {
    const html = '<form><input name="name" /><textarea name="msg"></textarea></form>';
    expect(webmcpDeclarative.run([page(html)], baseMeta)).toMatchObject({
      status: "skip",
      score: 0,
    });
  });
});

describe("webmcp-imperative", () => {
  const SITE = "https://example.com";
  const page = (body: string, url = SITE): FetchedPage => ({
    ...basePage,
    url,
    html: `<html><head></head><body>${body}</body></html>`,
  });
  const REGISTER = 'document.modelContext.registerTool({ name: "t", async execute() {} });';

  function serve(routes: Record<string, () => Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return routes[url]?.() ?? new Response("not found", { status: 404 });
    });
  }
  const fetchedUrls = (spy: ReturnType<typeof serve>) =>
    spy.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
  const js = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { headers: { "content-type": "text/javascript", ...headers } });

  function originTrialToken(payload: unknown): string {
    const json = Buffer.from(JSON.stringify(payload), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    return Buffer.concat([Buffer.from([3]), Buffer.alloc(64), length, json]).toString("base64");
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is tracked at weight 0; no signals → skip 0 with a message that does not recommend navigator.modelContext", async () => {
    const spy = serve({});
    expect(webmcpImperative).toMatchObject({ weight: 0, tracked: true });
    const result = await webmcpImperative.run([page("<script>console.log(1)</script>")], baseMeta);
    expect(result).toMatchObject({ status: "skip", score: 0, weight: 0, tracked: true });
    expect(result.message).not.toContain("navigator.modelContext");
    expect(result.fixSnippet).toContain("document.modelContext");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["document.modelContext.registerTool", REGISTER],
    [
      "document.modelContext without a direct registerTool chain",
      "const mc = document.modelContext; mc && mc.registerTool(x);",
    ],
    ["navigator.modelContext (deprecated alias)", "if (navigator.modelContext) { run(); }"],
    ["optional chaining", "document?.modelContext?.registerTool(x)"],
    ["bracket access", 'window.document["modelContext"]'],
  ])("inline %s → pass", async (_label, code) => {
    serve({});
    const result = await webmcpImperative.run([page(`<script>${code}</script>`)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100, tracked: true });
    expect(result.details).toContain(`inline script on ${SITE}`);
  });

  it("ignores data payload scripts (Next.js RSC flight data, JSON, ld+json) that quote the API", async () => {
    serve({});
    const quote = "Use document.modelContext.registerTool to register tools.";
    const result = await webmcpImperative.run(
      [
        page(
          `<script>self.__next_f.push([1,"${quote}"])</script><script type="application/json">{"t":"${quote}"}</script><script type="application/ld+json">{"d":"${quote}"}</script><script type="text/x-foo">${quote}</script>`,
        ),
      ],
      baseMeta,
    );
    expect(result).toMatchObject({ status: "skip", score: 0 });
  });

  it("still detects real inline registration code alongside a flight payload", async () => {
    serve({});
    const result = await webmcpImperative.run(
      [
        page(
          `<script>self.__next_f.push([1,"x"])</script><script type="module">navigator.modelContext.registerTool({ name: "t" });</script>`,
        ),
      ],
      baseMeta,
    );
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("detects registration in a same-origin external script and names the script URL", async () => {
    serve({ [`${SITE}/assets/app.js`]: () => js(`!function(){${REGISTER}}()`) });
    const result = await webmcpImperative.run(
      [page('<script src="/assets/app.js"></script>')],
      baseMeta,
    );
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.details).toContain(`script ${SITE}/assets/app.js`);
  });

  it("never fetches a cross-origin script", async () => {
    const spy = serve({ "https://cdn.other.com/app.js": () => js(REGISTER) });
    const result = await webmcpImperative.run(
      [page('<script src="https://cdn.other.com/app.js"></script>')],
      baseMeta,
    );
    expect(result).toMatchObject({ status: "skip", score: 0 });
    expect(fetchedUrls(spy)).toEqual([]);
  });

  it("fetches a same-origin script from a www page when baseUrl is the apex", async () => {
    const WWW = "https://www.example.com";
    const spy = serve({ [`${WWW}/theme.js`]: () => js(REGISTER) });
    const result = await webmcpImperative.run(
      [page('<script src="/theme.js"></script>', `${WWW}/`)],
      baseMeta,
    );
    expect(fetchedUrls(spy)).toEqual([`${WWW}/theme.js`]);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("never fetches scripts on other subdomains, other schemes, other ports or look-alike hosts", async () => {
    const spy = serve({});
    const result = await webmcpImperative.run(
      [
        page(
          '<script src="https://cdn.example.com/x.js"></script><script src="http://example.com/x.js"></script><script src="https://example.com:8443/x.js"></script><script src="https://www.example.com:8443/x.js"></script><script src="https://example.com.evil.test/x.js"></script>',
        ),
      ],
      baseMeta,
    );
    expect(fetchedUrls(spy)).toEqual([]);
    expect(result).toMatchObject({ status: "skip" });
  });

  // Eligibility is a property of the site, not of the page the tag was found on.
  it("fetches a www script referenced from an apex page via an absolute <base href>", async () => {
    const WWW = "https://www.example.com";
    const spy = serve({ [`${WWW}/assets/app.js`]: () => js(REGISTER) });
    const result = await webmcpImperative.run(
      [page(`<base href="${WWW}/assets/"><script src="app.js"></script>`)],
      baseMeta,
    );
    expect(fetchedUrls(spy)).toEqual([`${WWW}/assets/app.js`]);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("never fetches a script from a crawled page that lives on another site", async () => {
    const spy = serve({ "https://other.test/x.js": () => js(REGISTER) });
    const result = await webmcpImperative.run(
      [page('<script src="/x.js"></script>', "https://other.test/landing")],
      baseMeta,
    );
    expect(fetchedUrls(spy)).toEqual([]);
    expect(result).toMatchObject({ status: "skip" });
  });

  it("resolves script src against the page's <base href>", async () => {
    const spy = serve({ [`${SITE}/assets/tools.js`]: () => js(REGISTER) });
    const result = await webmcpImperative.run(
      [page('<base href="/assets/"><script src="tools.js"></script>', `${SITE}/docs/page`)],
      baseMeta,
    );
    expect(fetchedUrls(spy)).toEqual([`${SITE}/assets/tools.js`]);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("stops collecting script candidates after 5 on a page with 50 000 script tags", async () => {
    const spy = serve({});
    const html = page(
      Array.from({ length: 50_000 }, (_, i) => `<script src="/s${i}.js"></script>`).join(""),
    );
    let urlsBuilt = 0;
    vi.stubGlobal(
      "URL",
      class extends URL {
        constructor(...args: ConstructorParameters<typeof URL>) {
          super(...args);
          urlsBuilt++;
        }
      },
    );
    try {
      const result = await webmcpImperative.run([html], baseMeta);
      expect(urlsBuilt).toBeLessThan(100);
      expect(fetchedUrls(spy)).toEqual([0, 1, 2, 3, 4].map((i) => `${SITE}/s${i}.js`));
      expect(result).toMatchObject({ status: "skip" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("redirects", () => {
    // Behaves like undici: raw 3xx only when the caller asks for redirect: "manual",
    // otherwise follows Location itself (invisible to the spy), as a real fetch would.
    function serveRedirects(routes: Record<string, () => Response>) {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        let url = input instanceof Request ? input.url : String(input);
        for (let hop = 0; hop < 20; hop++) {
          const res = routes[url]?.() ?? new Response("not found", { status: 404 });
          const location = res.headers.get("location");
          if (init?.redirect === "manual" || res.status < 300 || res.status >= 400 || !location) {
            return res;
          }
          url = new URL(location, url).href;
        }
        throw new TypeError("redirect loop");
      });
    }
    const to =
      (location: string, status = 302) =>
      () =>
        new Response(null, { status, headers: { location } });

    it("a same-origin script redirecting to another host is not detected", async () => {
      serveRedirects({
        [`${SITE}/redir.js`]: to("https://cdn.other.test/app.js"),
        "https://cdn.other.test/app.js": () => js(REGISTER),
      });
      const result = await webmcpImperative.run(
        [page('<script src="/redir.js"></script>')],
        baseMeta,
      );
      expect(result).toMatchObject({ status: "skip", score: 0 });
    });

    it.each([
      301, 302, 303, 307, 308,
    ])("follows a %i to a same-site script through the fetch guard", async (status) => {
      const spy = serveRedirects({
        [`${SITE}/redir.js`]: to(`${SITE}/app.js`, status),
        [`${SITE}/app.js`]: () => js(REGISTER),
      });
      const result = await webmcpImperative.run(
        [page('<script src="/redir.js"></script>')],
        baseMeta,
      );
      expect(fetchedUrls(spy)).toEqual([`${SITE}/redir.js`, `${SITE}/app.js`]);
      expect(result).toMatchObject({ status: "pass", score: 100 });
    });

    it("follows a redirect from a www page's script to the apex baseUrl origin", async () => {
      const WWW = "https://www.example.com";
      const spy = serveRedirects({
        [`${WWW}/old.js`]: to(`${SITE}/app.js`, 301),
        [`${SITE}/app.js`]: () => js(REGISTER),
      });
      const result = await webmcpImperative.run(
        [page('<script src="/old.js"></script>', `${WWW}/`)],
        baseMeta,
      );
      expect(fetchedUrls(spy)).toEqual([`${WWW}/old.js`, `${SITE}/app.js`]);
      expect(result).toMatchObject({ status: "pass" });
    });

    it("a script shared by an apex page and a www page may redirect to the www host", async () => {
      const WWW = "https://www.example.com";
      const spy = serveRedirects({
        [`${SITE}/loader.js`]: to(`${WWW}/tool.js`),
        [`${WWW}/tool.js`]: () => js(REGISTER),
      });
      const result = await webmcpImperative.run(
        [
          page(`<script src="${SITE}/loader.js"></script>`),
          page(`<script src="${SITE}/loader.js"></script>`, `${WWW}/`),
        ],
        baseMeta,
      );
      expect(fetchedUrls(spy)).toEqual([`${SITE}/loader.js`, `${WWW}/tool.js`]);
      expect(result).toMatchObject({ status: "pass", score: 100 });
    });

    it("a redirect to another port on the site host is not followed", async () => {
      const spy = serveRedirects({
        [`${SITE}/redir.js`]: to("https://example.com:8443/app.js"),
        "https://example.com:8443/app.js": () => js(REGISTER),
      });
      const result = await webmcpImperative.run(
        [page('<script src="/redir.js"></script>')],
        baseMeta,
      );
      expect(fetchedUrls(spy)).toEqual([`${SITE}/redir.js`]);
      expect(result).toMatchObject({ status: "skip" });
    });

    it("follows at most 3 redirects", async () => {
      const chain = (hops: number) => {
        const routes: Record<string, () => Response> = { [`${SITE}/app.js`]: () => js(REGISTER) };
        for (let i = 0; i < hops; i++) {
          routes[`${SITE}/r${i}.js`] = to(i === hops - 1 ? "/app.js" : `/r${i + 1}.js`);
        }
        return routes;
      };
      serveRedirects(chain(3));
      const three = await webmcpImperative.run([page('<script src="/r0.js"></script>')], baseMeta);
      expect(three).toMatchObject({ status: "pass" });
      vi.restoreAllMocks();
      serveRedirects(chain(4));
      const four = await webmcpImperative.run([page('<script src="/r0.js"></script>')], baseMeta);
      expect(four).toMatchObject({ status: "skip" });
    });

    it("a redirect hop refused by isAllowedTarget is not fetched or detected", async () => {
      const spy = serveRedirects({
        [`${SITE}/redir.js`]: to("/private.js"),
        [`${SITE}/private.js`]: () => js(REGISTER),
      });
      const result = await webmcpImperative.run(
        [page('<script src="/redir.js"></script>')],
        baseMeta,
        { isAllowedTarget: (url) => !url.endsWith("/private.js") },
      );
      expect(fetchedUrls(spy)).toEqual([`${SITE}/redir.js`]);
      expect(result).toMatchObject({ status: "skip" });
    });
  });

  it("fetches at most 5 unique same-origin scripts, deduped across pages in page order", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 1; i <= 6; i++) routes[`${SITE}/s${i}.js`] = () => js(i === 6 ? REGISTER : "x()");
    const spy = serve(routes);
    const pages = [
      page(
        '<script src="/s1.js"></script><script src="/s2.js"></script><script src="/s3.js"></script>',
      ),
      page(
        '<script src="/s1.js"></script><script src="s4.js"></script><script src="/s5.js"></script><script src="/s6.js"></script>',
        `${SITE}/about`,
      ),
    ];
    const result = await webmcpImperative.run(pages, baseMeta);
    expect(fetchedUrls(spy)).toEqual([1, 2, 3, 4, 5].map((i) => `${SITE}/s${i}.js`));
    expect(result).toMatchObject({ status: "skip" });
  });

  it("does not read a script whose content-length exceeds 256 KB", async () => {
    serve({ [`${SITE}/big.js`]: () => js(REGISTER, { "content-length": "262145" }) });
    const result = await webmcpImperative.run([page('<script src="/big.js"></script>')], baseMeta);
    expect(result).toMatchObject({ status: "skip" });
  });

  it("reads at most 256 KB of a script body: a pattern past the cap is not detected", async () => {
    const body = `${"x".repeat(262144)}${REGISTER}`;
    serve({ [`${SITE}/long.js`]: () => js(body) });
    const result = await webmcpImperative.run([page('<script src="/long.js"></script>')], baseMeta);
    expect(result).toMatchObject({ status: "skip" });
  });

  it("a script refused by isAllowedTarget, a non-2xx script, or a network error → skip, never throws", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/err.js")) throw new TypeError("fetch failed");
      if (url.endsWith("/500.js")) return new Response(REGISTER, { status: 500 });
      return js(REGISTER);
    });
    const result = await webmcpImperative.run(
      [
        page(
          '<script src="/blocked.js"></script><script src="/err.js"></script><script src="/500.js"></script>',
        ),
      ],
      baseMeta,
      { isAllowedTarget: (url) => !url.endsWith("/blocked.js") },
    );
    expect(result).toMatchObject({ status: "skip", score: 0 });
    expect(fetchedUrls(spy)).not.toContain(`${SITE}/blocked.js`);
  });

  it("an origin-trial token for WebMCP without registration code is reported as detected", async () => {
    serve({});
    const token = originTrialToken({ origin: SITE, feature: "WebMCP", expiry: 1900000000 });
    const result = await webmcpImperative.run(
      [page(`<meta http-equiv="Origin-Trial" content="${token}">`)],
      baseMeta,
    );
    expect(result).toMatchObject({ status: "pass", score: 100, tracked: true });
    expect(result.details).toContain("origin-trial token for WebMCP");
    expect(result.details).toContain("origin-trial token only, no registration code found");
  });

  it.each([
    [
      "an origin-trial token for another feature",
      `content="${originTrialToken({ feature: "WebGPU" })}"`,
    ],
    ["malformed base64", 'content="!!!not-base64@@@"'],
    ["a truncated token", `content="${originTrialToken({ feature: "WebMCP" }).slice(0, 100)}"`],
    [
      "a non-JSON payload",
      `content="${Buffer.concat([Buffer.alloc(65), Buffer.from([0, 0, 0, 3]), Buffer.from("{{{")]).toString("base64")}"`,
    ],
  ])("%s → skip, no throw", async (_label, attr) => {
    serve({});
    const result = await webmcpImperative.run(
      [page(`<meta http-equiv="origin-trial" ${attr}>`)],
      baseMeta,
    );
    expect(result).toMatchObject({ status: "skip", score: 0 });
  });

  it("a WebMCP pass does not change the agent-protocols category score", async () => {
    serve({});
    const scored: Check = {
      id: "scored-stub",
      name: "scored-stub",
      category: "agent-protocols",
      weight: 1,
      severity: "info",
      run: () => ({
        id: "scored-stub",
        name: "scored-stub",
        category: "agent-protocols",
        status: "partial",
        score: 40,
        maxScore: 100,
        weight: 1,
        message: "stub",
        severity: "info",
      }),
    };
    const audit = async (body: string) => {
      const report = await runAudit(
        SITE,
        {
          categories: ["agent-protocols"],
          prefetchedPages: [{ ...page(body), headers: { "content-type": "text/html" } }],
          prefetchedMetadata: baseMeta,
        },
        undefined,
        [scored, webmcpImperative],
      );
      return report.categories.find((c) => c.id === "agent-protocols");
    };
    const withWebmcp = await audit(`<script>${REGISTER}</script>`);
    const without = await audit("<p>none</p>");
    expect(withWebmcp?.checks.find((c) => c.id === "webmcp-imperative")).toMatchObject({
      status: "pass",
      tracked: true,
    });
    expect(withWebmcp?.score).toBe(40);
    expect(without?.score).toBe(withWebmcp?.score);
  });
});

describe("api-endpoints", () => {
  it("passes when homepage links to /openapi.json (existing strong-href signal)", () => {
    const html = `<html><body>
      <a href="https://example.com/openapi.json">spec</a>
    </body></html>`;
    const result = apiEndpoints.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("passes when link text says 'API reference' even if href is just /api (Stripe pattern)", () => {
    const html = `<html><body>
      <a href="https://docs.example.com/api">API reference</a>
    </body></html>`;
    const result = apiEndpoints.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("passes for 'REST API' link text", () => {
    const html = `<html><body>
      <a href="/developers">REST API</a>
    </body></html>`;
    const result = apiEndpoints.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when no API link text or strong-href signals", () => {
    const html = `<html><body>
      <a href="/about">About</a>
      <a href="/pricing">Pricing</a>
    </body></html>`;
    const result = apiEndpoints.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});
