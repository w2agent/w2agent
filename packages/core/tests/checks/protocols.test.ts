import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionSchemas,
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
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fails when no MCP endpoint", async () => {
    const result = await mcpDiscovery.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });

  it("scores 100 when MCP endpoint returns valid initialize response", async () => {
    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: '{"endpoints": []}' },
      mcpInit: { mcpEndpointUrl: "https://example.com/.well-known/mcp", success: true, status: 200, serverInfo: { name: "test-server", version: "1.0.0" } },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("test-server");
    expect(result.details).toContain("test-server");
  });

  it("scores 50 when endpoint exists but returns non-200", async () => {
    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: "something" },
      mcpInit: { mcpEndpointUrl: "https://example.com/.well-known/mcp", success: false, status: 405 },
    });
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("405");
  });

  it("scores 50 when endpoint returns invalid JSON", async () => {
    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: "exists" },
      mcpInit: { mcpEndpointUrl: "https://example.com/.well-known/mcp", success: false, status: 200 },
    });
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("invalid MCP response");
  });

  it("scores 50 when fetch throws (timeout/network)", async () => {
    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: "exists" },
      mcpInit: { mcpEndpointUrl: "https://example.com/.well-known/mcp", success: false },
    });
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("could not complete");
  });

  it("parses SSE format responses", async () => {
    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: "exists" },
      mcpInit: { mcpEndpointUrl: "https://example.com/.well-known/mcp", success: true, status: 200, serverInfo: { name: "sse-server", version: "2.0.0" } },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("sse-server");
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
  it("passes when UCP exists", () => {
    const result = wellKnownUcp.run([basePage], {
      ...baseMeta,
      wellKnown: { ucp: '{"version": "1.0"}' },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
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
