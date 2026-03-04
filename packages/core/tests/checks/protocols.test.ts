import { describe, it, expect } from "vitest";
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
  it("passes when MCP endpoint exists", () => {
    const result = mcpDiscovery.run([basePage], {
      ...baseMeta,
      wellKnown: { mcp: '{"endpoints": []}' },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when no MCP endpoint", () => {
    const result = mcpDiscovery.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
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
