import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionSchemas,
  apiEndpoints,
  formsStructured,
  mcpDiscovery,
  webmcpDeclarative,
  webmcpImperative,
  wellKnownUcp,
} from "../../src/audit/checks/protocols.js";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";

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

describe("webmcp-declarative", () => {
  it("skips when no forms exist", () => {
    const result = webmcpDeclarative.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "skip", score: 100 });
  });

  it("fails when forms exist but none have WebMCP attributes", () => {
    const html = `<html><body><form>
      <input type="text" name="query" />
    </form></body></html>`;
    const result = webmcpDeclarative.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.message).toContain("No forms have WebMCP");
  });

  it("passes when all forms have toolname", () => {
    const html = `<html><body>
      <form toolname="search" tooldescription="Search things">
        <input type="text" name="q" toolparamdescription="Search query" />
      </form>
    </body></html>`;
    const result = webmcpDeclarative.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("1/1");
  });

  it("returns partial when some forms have toolname", () => {
    const html = `<html><body>
      <form toolname="search" tooldescription="Search">
        <input type="text" name="q" />
      </form>
      <form>
        <input type="text" name="email" />
      </form>
      <form>
        <input type="text" name="name" />
      </form>
    </body></html>`;
    const result = webmcpDeclarative.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "partial" });
    expect(result.score).toBe(33); // Math.round(1/3 * 100)
    expect(result.message).toContain("1/3");
  });
});

describe("webmcp-imperative", () => {
  it("fails when no scripts exist", () => {
    const result = webmcpImperative.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });

  it("passes when inline script uses navigator.modelContext", () => {
    const html = `<html><body>
      <script>
        navigator.modelContext.registerTool({
          name: "test",
          description: "A test tool",
          inputSchema: { type: "object", properties: {} },
          async execute() {}
        });
      </script>
    </body></html>`;
    const result = webmcpImperative.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("1 page(s)");
  });

  it("fails when script exists but has no modelContext", () => {
    const html = `<html><body>
      <script>console.log("hello");</script>
    </body></html>`;
    const result = webmcpImperative.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });

  it("fails when script is external (src attribute)", () => {
    const html = `<html><body>
      <script src="/webmcp-tools.js"></script>
    </body></html>`;
    const result = webmcpImperative.run([{ ...basePage, html }], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
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
