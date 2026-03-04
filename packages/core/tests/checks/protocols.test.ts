import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";
import {
  mcpDiscovery,
  formsStructured,
  actionSchemas,
  wellKnownUcp,
} from "../../src/audit/checks/protocols.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => Promise.resolve(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "test-server", version: "1.0.0" },
          capabilities: { tools: {} },
        },
      })),
    });

    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: '{"endpoints": []}' },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("test-server");
    expect(result.details).toContain("test-server");
  });

  it("scores 50 when endpoint exists but returns non-200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 405,
      statusText: "Method Not Allowed",
      headers: new Headers(),
    });

    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: "something" },
    });
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("405");
  });

  it("scores 50 when endpoint returns invalid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: () => Promise.resolve("<html>not json</html>"),
    });

    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: "exists" },
    });
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("invalid MCP response");
  });

  it("scores 50 when fetch throws (timeout/network)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("timeout"));

    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: "exists" },
    });
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("could not complete");
  });

  it("parses SSE format responses", async () => {
    const sseBody = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "sse-server", version: "2.0.0" },
        capabilities: {},
      },
    })}\n\n`;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/event-stream" }),
      text: () => Promise.resolve(sseBody),
    });

    const result = await mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: "exists" },
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
