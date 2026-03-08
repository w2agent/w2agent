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

  it("probes all 5 paths", async () => {
    mockFetchText.mockResolvedValue(null);
    await probeOpenAPIPaths("https://example.com", opts);
    expect(mockFetchText).toHaveBeenCalledTimes(5);
    for (const path of OPENAPI_PROBE_PATHS) {
      expect(mockFetchText).toHaveBeenCalledWith(`https://example.com${path}`, opts);
    }
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
    const parsed = JSON.parse(openapiFile!.content);
    expect(parsed.title).toBe("Test API");
    expect(parsed.endpoints).toHaveLength(1);
  });
});
