import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedOpenAPISpec } from "../src/audit/types.js";
import { generateDataFiles } from "../src/generate/mcp-server.js";
import type { GenerateContext } from "../src/generate/types.js";
import { OPENAPI_PROBE_PATHS, parseOpenAPISpec, probeOpenAPIPaths } from "../src/shared/openapi.js";

// --- parseOpenAPISpec ---

describe("parseOpenAPISpec", () => {
  it("parses OpenAPI 3.x spec with endpoints", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Pet Store", description: "A pet API" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            summary: "List pets",
            parameters: [{ name: "limit", in: "query", type: "integer", required: false }],
          },
          post: {
            operationId: "createPet",
            summary: "Create a pet",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    properties: { name: { type: "string" }, tag: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = parseOpenAPISpec(spec, "https://example.com/openapi.json");
    expect(result).not.toBeNull();
    expect(result?.version).toBe("3.0.3");
    expect(result?.title).toBe("Pet Store");
    expect(result?.serverUrl).toBe("https://api.example.com");
    expect(result?.endpoints).toHaveLength(2);
    expect(result?.endpoints[0].method).toBe("GET");
    expect(result?.endpoints[0].parameters).toHaveLength(1);
    expect(result?.endpoints[1].requestBody?.contentType).toBe("application/json");
    expect(result?.endpoints[1].requestBody?.properties).toHaveProperty("name");
  });

  it("parses Swagger 2.0 spec with basePath and body parameter", () => {
    const spec = {
      swagger: "2.0",
      info: { title: "Legacy API" },
      basePath: "/v1",
      paths: {
        "/users": {
          post: {
            operationId: "createUser",
            parameters: [
              {
                name: "body",
                in: "body",
                required: true,
                schema: {
                  properties: { email: { type: "string" }, name: { type: "string" } },
                },
              },
              { name: "api_key", in: "header", type: "string", required: true },
            ],
          },
        },
      },
    };
    const result = parseOpenAPISpec(spec, "https://example.com/swagger.json");
    expect(result?.version).toBe("2.0");
    expect(result?.serverUrl).toBe("/v1");
    expect(result?.endpoints[0].parameters).toHaveLength(1);
    expect(result?.endpoints[0].parameters[0].name).toBe("api_key");
    expect(result?.endpoints[0].requestBody).toBeDefined();
    expect(result?.endpoints[0].requestBody?.properties).toHaveProperty("email");
  });

  it("resolves $ref within same document", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Ref Test" },
      paths: {
        "/items": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Item" },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Item: {
            properties: {
              id: { type: "integer" },
              name: { type: "string", description: "Item name" },
            },
          },
        },
      },
    };
    const result = parseOpenAPISpec(spec, "https://example.com/openapi.json");
    expect(result?.endpoints[0].requestBody?.properties.id.type).toBe("integer");
    expect(result?.endpoints[0].requestBody?.properties.name.description).toBe("Item name");
  });

  it("caps at 200 endpoints", () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 250; i++) {
      paths[`/endpoint-${i}`] = { get: { operationId: `op${i}` } };
    }
    const spec = { openapi: "3.0.0", info: { title: "Big" }, paths };
    const result = parseOpenAPISpec(spec, "https://example.com/openapi.json");
    expect(result?.endpoints.length).toBe(200);
  });

  it("returns null for missing openapi/swagger key", () => {
    expect(parseOpenAPISpec({ info: { title: "Not a spec" } }, "x")).toBeNull();
  });

  it("returns null for missing paths", () => {
    expect(parseOpenAPISpec({ openapi: "3.0.0", info: {} }, "x")).toBeNull();
  });

  it("handles malformed path items gracefully", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Test" },
      paths: { "/ok": { get: { summary: "works" } }, "/bad": null },
    };
    const result = parseOpenAPISpec(spec, "x");
    expect(result?.endpoints).toHaveLength(1);
  });
});

// --- probeOpenAPIPaths ---

vi.mock("../src/shared/fetcher.js", () => ({
  fetchText: vi.fn(),
}));

import { fetchText } from "../src/shared/fetcher.js";

const mockFetchText = vi.mocked(fetchText);

describe("probeOpenAPIPaths", () => {
  beforeEach(() => {
    mockFetchText.mockReset();
  });

  const opts = { timeout: 5000, userAgent: "test" };

  it("returns parsed spec when valid JSON found", async () => {
    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/openapi.json")) {
        return {
          text: JSON.stringify({
            openapi: "3.0.0",
            info: { title: "Test" },
            paths: { "/a": { get: {} } },
          }),
          status: 200,
        };
      }
      return null;
    });
    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Test");
  });

  it("returns null when no valid spec found", async () => {
    mockFetchText.mockResolvedValue(null);
    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result).toBeNull();
  });

  it("skips non-JSON responses", async () => {
    mockFetchText.mockResolvedValue({ text: "<html>Not JSON</html>", status: 200 });
    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result).toBeNull();
  });

  it("skips JSON without openapi/swagger key", async () => {
    mockFetchText.mockResolvedValue({ text: JSON.stringify({ data: "something" }), status: 200 });
    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result).toBeNull();
  });

  it("probes all 15 paths", async () => {
    mockFetchText.mockResolvedValue(null);
    await probeOpenAPIPaths("https://example.com", opts);
    expect(mockFetchText).toHaveBeenCalledTimes(15);
    for (const path of OPENAPI_PROBE_PATHS) {
      expect(mockFetchText).toHaveBeenCalledWith(`https://example.com${path}`, opts);
    }
  });

  it("extracts spec URL from Swagger UI HTML response", async () => {
    const swaggerUIHtml = `
      <html><body>
      <div id="swagger-ui"></div>
      <script>
        SwaggerUIBundle({ url: "/internal/spec.json", dom_id: '#swagger-ui' })
      </script>
      </body></html>
    `;
    const specJson = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Swagger UI Discovered" },
      paths: { "/pets": { get: {} } },
    });

    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/api-docs")) {
        return { text: swaggerUIHtml, status: 200 };
      }
      if (url.endsWith("/internal/spec.json")) {
        return { text: specJson, status: 200 };
      }
      return null;
    });

    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Swagger UI Discovered");
  });

  it("does not follow Swagger UI URLs when direct probe succeeds", async () => {
    const swaggerUIHtml = `<html><div id="swagger-ui"></div><script>SwaggerUIBundle({ url: "/internal/spec.json" })</script></html>`;
    const specJson = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Direct" },
      paths: { "/a": { get: {} } },
    });

    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/openapi.json")) {
        return { text: specJson, status: 200 };
      }
      if (url.endsWith("/api-docs")) {
        return { text: swaggerUIHtml, status: 200 };
      }
      return null;
    });

    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result?.title).toBe("Direct");
    expect(mockFetchText).not.toHaveBeenCalledWith("https://example.com/internal/spec.json", opts);
  });

  it("detects Spring Boot spec at /v3/api-docs", async () => {
    const specJson = JSON.stringify({
      openapi: "3.0.1",
      info: { title: "Spring Boot API" },
      paths: { "/actuator/health": { get: { summary: "Health check" } } },
    });
    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/v3/api-docs")) return { text: specJson, status: 200 };
      return null;
    });
    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result?.title).toBe("Spring Boot API");
    expect(result?.version).toBe("3.0.1");
  });

  it("detects ASP.NET spec at /swagger/v1/swagger.json", async () => {
    const specJson = JSON.stringify({
      openapi: "3.0.1",
      info: { title: "ASP.NET API" },
      paths: { "/api/values": { get: {} } },
    });
    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/swagger/v1/swagger.json")) return { text: specJson, status: 200 };
      return null;
    });
    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result?.title).toBe("ASP.NET API");
  });

  it("detects httpbin-style spec at /spec.json", async () => {
    const specJson = JSON.stringify({
      swagger: "2.0",
      info: { title: "httpbin" },
      basePath: "/",
      paths: { "/get": { get: { summary: "GET request" } } },
    });
    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/spec.json")) return { text: specJson, status: 200 };
      return null;
    });
    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result?.title).toBe("httpbin");
    expect(result?.version).toBe("2.0");
  });

  it("discovers spec from homepage <a> link when probes fail", async () => {
    const homepageHtml = `
      <html><body>
        <a href="/developer/openapi.json">API Documentation</a>
      </body></html>
    `;
    const specJson = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Discovered via Link" },
      paths: { "/users": { get: {} } },
    });
    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/developer/openapi.json")) return { text: specJson, status: 200 };
      return null;
    });
    const result = await probeOpenAPIPaths("https://example.com", opts, { homepageHtml });
    expect(result?.title).toBe("Discovered via Link");
  });

  it("discovers spec from homepage <link> tag", async () => {
    const homepageHtml = `
      <html><head>
        <link rel="openapi" href="/api/v1/swagger.json" />
      </head><body></body></html>
    `;
    const specJson = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Link Tag Spec" },
      paths: { "/items": { get: {} } },
    });
    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/api/v1/swagger.json")) return { text: specJson, status: 200 };
      return null;
    });
    const result = await probeOpenAPIPaths("https://example.com", opts, { homepageHtml });
    expect(result?.title).toBe("Link Tag Spec");
  });

  it("does not scan homepage HTML when direct probe succeeds", async () => {
    const homepageHtml = `<html><a href="/custom/openapi.json">API</a></html>`;
    const specJson = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Direct Hit" },
      paths: { "/a": { get: {} } },
    });
    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/openapi.json")) return { text: specJson, status: 200 };
      return null;
    });
    const result = await probeOpenAPIPaths("https://example.com", opts, { homepageHtml });
    expect(result?.title).toBe("Direct Hit");
    expect(mockFetchText).not.toHaveBeenCalledWith("https://example.com/custom/openapi.json", opts);
  });

  it("returns null when no spec found even with homepage HTML", async () => {
    const homepageHtml = `<html><body><a href="/about">About</a></body></html>`;
    mockFetchText.mockResolvedValue(null);
    const result = await probeOpenAPIPaths("https://example.com", opts, { homepageHtml });
    expect(result).toBeNull();
  });

  it("ignores homepage links without API keywords", async () => {
    const homepageHtml = `<html><body><a href="/docs/guide.json">Guide</a></body></html>`;
    mockFetchText.mockResolvedValue(null);
    const result = await probeOpenAPIPaths("https://example.com", opts, { homepageHtml });
    expect(result).toBeNull();
    expect(mockFetchText).toHaveBeenCalledTimes(15);
  });

  it("extracts spec URL from Swagger UI with JSON-style config", async () => {
    const swaggerUIHtml = `
      <html><body>
      <div id="swagger-ui"></div>
      <script>
        const ui = SwaggerUIBundle({"url": "/api/v2/spec.json", "dom_id": "#swagger-ui"})
      </script>
      </body></html>
    `;
    const specJson = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "JSON Config Swagger" },
      paths: { "/test": { get: {} } },
    });
    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/api-docs")) return { text: swaggerUIHtml, status: 200 };
      if (url.endsWith("/api/v2/spec.json")) return { text: specJson, status: 200 };
      return null;
    });
    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result?.title).toBe("JSON Config Swagger");
  });

  it("detects Petstore-style spec at /api/v3/openapi.json", async () => {
    const specJson = JSON.stringify({
      openapi: "3.0.2",
      info: { title: "Petstore" },
      paths: {
        "/pet": { get: {}, post: {} },
        "/pet/{petId}": { get: {}, delete: {} },
      },
    });
    mockFetchText.mockImplementation(async (url) => {
      if (url.endsWith("/api/v3/openapi.json")) return { text: specJson, status: 200 };
      return null;
    });
    const result = await probeOpenAPIPaths("https://example.com", opts);
    expect(result?.title).toBe("Petstore");
    expect(result?.endpoints).toHaveLength(4);
  });
});

// --- generateDataFiles with OpenAPI ---

describe("generateDataFiles with OpenAPI", () => {
  const minimalContext: GenerateContext = {
    pages: [
      { url: "https://example.com", title: "Home", description: "Home page", markdown: "# Home" },
    ],
    rawPages: [],
    metadata: {
      baseUrl: "https://example.com",
      wellKnown: {},
    },
    baseUrl: "https://example.com",
  };

  it("does not include openapi.json when no openapi in metadata", () => {
    const files = generateDataFiles(minimalContext);
    expect(files.find((f) => f.filename === "mcp-server/data/openapi.json")).toBeUndefined();
  });

  it("includes openapi.json when openapi is present in metadata", () => {
    const openapi: ParsedOpenAPISpec = {
      specUrl: "https://example.com/openapi.json",
      version: "3.0.0",
      title: "Test API",
      endpoints: [{ path: "/test", method: "GET", parameters: [] }],
    };
    const ctx: GenerateContext = {
      ...minimalContext,
      metadata: { ...minimalContext.metadata, openapi },
    };
    const files = generateDataFiles(ctx);
    const openapiFile = files.find((f) => f.filename === "mcp-server/data/openapi.json");
    expect(openapiFile).toBeDefined();
    const parsed = JSON.parse(openapiFile?.content);
    expect(parsed.title).toBe("Test API");
    expect(parsed.endpoints).toHaveLength(1);
  });
});

// Security: origin policy on serverUrl — reject off-origin hosts that would
// turn the generated MCP server into an SSRF / proxy surface.
describe("parseOpenAPISpec — origin policy", () => {
  const makeSpec = (serverUrl: string) => ({
    openapi: "3.0.0",
    info: { title: "Test" },
    servers: [{ url: serverUrl }],
    paths: { "/x": { get: { operationId: "getX", parameters: [] } } },
  });

  it("drops spec when serverUrl is off-origin and not allowlisted", () => {
    const result = parseOpenAPISpec(
      makeSpec("https://attacker.example/api"),
      "https://example.com/openapi.json",
      { baseUrl: "https://example.com", allowedHosts: [] },
    );
    expect(result).toBeNull();
  });

  it("keeps spec when serverUrl is same-origin", () => {
    const result = parseOpenAPISpec(
      makeSpec("https://example.com/api"),
      "https://example.com/openapi.json",
      { baseUrl: "https://example.com" },
    );
    expect(result).not.toBeNull();
  });

  it("keeps spec when off-origin serverUrl host is allowlisted", () => {
    const result = parseOpenAPISpec(
      makeSpec("https://api.partner.com"),
      "https://example.com/openapi.json",
      { baseUrl: "https://example.com", allowedHosts: ["api.partner.com"] },
    );
    expect(result).not.toBeNull();
    expect(result?.serverUrl).toBe("https://api.partner.com");
  });

  it("drops spec whose serverUrl resolves to a private IP even if allowlisted", () => {
    const result = parseOpenAPISpec(
      makeSpec("http://169.254.169.254/meta-data"),
      "https://example.com/openapi.json",
      { baseUrl: "https://example.com", allowedHosts: ["169.254.169.254"] },
    );
    expect(result).toBeNull();
  });

  it("accepts relative serverUrl (resolves against baseUrl)", () => {
    const result = parseOpenAPISpec(makeSpec("/v1/api"), "https://example.com/openapi.json", {
      baseUrl: "https://example.com",
    });
    expect(result).not.toBeNull();
    expect(result?.serverUrl).toBe("/v1/api");
  });
});
