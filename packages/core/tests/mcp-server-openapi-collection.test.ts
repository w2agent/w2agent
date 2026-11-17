import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerateContext } from "../src/generate/types.js";
import { parseOpenAPISpec } from "../src/shared/openapi.js";
import {
  type Booted,
  bootGenerated,
  callTool,
  VARIANTS,
  type Variant,
} from "./helpers/mcp-boot.js";
import { CORE_DIR, killTracked } from "./helpers/mcp-harness.js";

const SITE = "https://example.com";
const API_HOST = "https://api.example.net";

const arr = { type: "array", items: { type: "string" } };

const swagger2 = {
  swagger: "2.0",
  info: { title: "S2" },
  host: "api.example.net",
  schemes: ["https"],
  paths: {
    "/s2/{plist}": {
      get: {
        operationId: "readSwagger",
        summary: "read-swagger",
        parameters: [
          { name: "plist", in: "path", required: true, ...arr, collectionFormat: "pipes" },
          { name: "dflt", in: "query", required: false, ...arr },
          { name: "multi", in: "query", required: false, ...arr, collectionFormat: "multi" },
          { name: "ssv", in: "query", required: false, ...arr, collectionFormat: "ssv" },
          { name: "tsv", in: "query", required: false, ...arr, collectionFormat: "tsv" },
          { name: "pipes", in: "query", required: false, ...arr, collectionFormat: "pipes" },
        ],
      },
    },
  },
};

const oas3 = {
  openapi: "3.0.3",
  info: { title: "O3" },
  servers: [{ url: API_HOST }],
  paths: {
    "/o3": {
      get: {
        operationId: "readOas",
        summary: "read-oas",
        parameters: [
          { name: "plain", in: "query", schema: arr },
          { name: "flat", in: "query", explode: false, schema: arr },
          { name: "space", in: "query", style: "spaceDelimited", schema: arr },
          { name: "pipe", in: "query", style: "pipeDelimited", schema: arr },
        ],
      },
    },
  },
};

function ctxFor(spec: unknown): GenerateContext {
  const openapi = parseOpenAPISpec(spec as Record<string, unknown>, `${API_HOST}/openapi.json`);
  if (!openapi) throw new Error("spec did not parse");
  openapi.serverUrl = API_HOST;
  return {
    pages: [{ url: `${SITE}/`, title: "Home", description: "", markdown: "hi" }],
    rawPages: [],
    metadata: { baseUrl: SITE, wellKnown: {}, openapi },
    baseUrl: SITE,
    allowedOffOriginHosts: ["api.example.net"],
  };
}

let tmpRoot = "";
let fixture: HttpServer;
let port = 0;
let urls: string[] = [];
const closers: Array<() => void> = [];

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(CORE_DIR, ".tmp-mcp-oas-coll-"));
  fixture = createHttpServer((req, res) => {
    urls.push(req.url ?? "");
    res.setHeader("connection", "close");
    req.resume();
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

describe.each(VARIANTS)("generated array serialization: %s", (variant: Variant) => {
  const booted: Record<string, Booted> = {};

  beforeAll(async () => {
    for (const [name, spec] of [
      ["s2", swagger2],
      ["o3", oas3],
    ] as const) {
      booted[name] = await bootGenerated(
        variant,
        ctxFor(spec),
        join(tmpRoot, `${name}-${variant}`),
        [[API_HOST, `http://127.0.0.1:${port}`]],
      );
      closers.push(booted[name].close);
    }
  }, 60000);

  it("Swagger 2 honours collectionFormat (default csv, multi, ssv, tsv, pipes)", async () => {
    urls = [];
    const r = await callTool(booted.s2.rpc, "read-swagger", {
      plist: ["a,b", "c d"],
      dflt: ["a,b", "c"],
      multi: ["x", "y"],
      ssv: ["a b", "c"],
      tsv: [1, 2],
      pipes: ["a|b", "c"],
    });
    expect(r.isError, r.text).toBe(false);
    expect(urls, r.text).toHaveLength(1);
    const [path, query] = urls[0].split("?");
    expect(path).toBe("/s2/a%2Cb%7Cc%20d");
    expect(query).toBe("dflt=a%2Cb,c&multi=x&multi=y&ssv=a%20b%20c&tsv=1%092&pipes=a%7Cb|c");
  });

  it("OpenAPI 3 honours style and explode", async () => {
    urls = [];
    const r = await callTool(booted.o3.rpc, "read-oas", {
      plain: [1, 2],
      flat: [1, 2],
      space: [1, 2],
      pipe: [1, 2],
    });
    expect(r.isError, r.text).toBe(false);
    expect(urls, r.text).toHaveLength(1);
    expect(urls[0]).toBe("/o3?plain=1&plain=2&flat=1,2&space=1%202&pipe=1|2");
  });
});
