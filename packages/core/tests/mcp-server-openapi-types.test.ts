import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const API_HOST = "https://api.example.net";

interface Hit {
  method: string;
  url: string;
  body: string;
}

let tmpRoot = "";
let fixture: HttpServer;
let port = 0;
let hits: Hit[] = [];
const closers: Array<() => void> = [];

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(CORE_DIR, ".tmp-mcp-oas-types-"));
  fixture = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      hits.push({ method: req.method ?? "", url: req.url ?? "", body });
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

const param = (name: string, loc: "path" | "query", type: unknown, required = true) => ({
  name,
  in: loc,
  type: type as string,
  required,
});

function buildCtx(): GenerateContext {
  return {
    pages: [{ url: `${SITE}/`, title: "Home", description: "", markdown: "hi" }],
    rawPages: [],
    metadata: {
      baseUrl: SITE,
      wellKnown: {},
      openapi: {
        specUrl: `${API_HOST}/openapi.json`,
        version: "3.1.0",
        serverUrl: API_HOST,
        endpoints: [
          {
            path: "/items/{pflag}/{ptags}/{pobj}/{pnum}",
            method: "get",
            operationId: "typedGet",
            summary: "typed-get",
            parameters: [
              param("pflag", "path", "boolean"),
              param("ptags", "path", "array"),
              param("pobj", "path", "object"),
              param("pnum", "path", "integer"),
              param("qflag", "query", "boolean"),
              param("qtags", "query", ["array", "null"]),
              param("qobj", "query", "object"),
              param("qnum", "query", "integer"),
              param("qstr", "query", "string", false),
              param("qopt", "query", "boolean", false),
            ],
          },
          {
            path: "/submit",
            method: "post",
            operationId: "typedPost",
            summary: "typed-post",
            parameters: [],
            requestBody: {
              contentType: "application/json",
              required: false,
              properties: {
                enabled: { type: "boolean" },
                count: { type: "integer" },
                tags: { type: "array" },
                meta: { type: "object" },
                nullable: { type: ["boolean", "null"] as unknown as string },
                label: { type: "string" },
                loose: {},
              },
            },
          },
        ],
      },
    },
    baseUrl: SITE,
    allowedOffOriginHosts: ["api.example.net"],
  };
}

describe.each(VARIANTS)("generated OpenAPI typed params: %s", (variant: Variant) => {
  let booted: Booted;
  let tools: any[] = [];
  const tool = (summary: string) => tools.find((t) => t.description === summary);

  beforeAll(async () => {
    booted = await bootGenerated(variant, buildCtx(), join(tmpRoot, `oas-${variant}`), [
      [API_HOST, `http://127.0.0.1:${port}`],
    ]);
    closers.push(booted.close);
    tools = await listTools(booted.rpc);
  }, 60000);

  it("advertises boolean, array, object and number JSON-schema types", () => {
    const get = tool("typed-get").inputSchema.properties;
    expect(get.pflag.type).toBe("boolean");
    expect(get.ptags.type).toBe("array");
    expect(get.pobj.type).toBe("object");
    expect(get.pnum.type).toBe("number");
    expect(get.qflag.type).toBe("boolean");
    expect(get.qtags.type).toBe("array");
    expect(get.qobj.type).toBe("object");
    expect(get.qstr.type).toBe("string");
    const post = tool("typed-post").inputSchema.properties;
    expect(post.enabled.type).toBe("boolean");
    expect(post.count.type).toBe("number");
    expect(post.tags.type).toBe("array");
    expect(post.meta.type).toBe("object");
    expect(post.nullable.type).toBe("boolean");
    expect(post.label.type).toBe("string");
    expect(post.loose.type).toBe("string");
  });

  it("sends path and query values in OpenAPI default style", async () => {
    hits = [];
    const r = await callTool(booted.rpc, tool("typed-get").name, {
      pflag: true,
      ptags: ["a b/c", 2],
      pobj: { k: "v/w" },
      pnum: 5,
      qflag: false,
      qtags: [1, "a"],
      qobj: { k: "v", n: { x: 1 } },
      qnum: 3,
      qstr: "s",
    });
    expect(r.isError).toBe(false);
    expect(hits).toHaveLength(1);
    const [pathPart, query] = hits[0].url.split("?");
    expect(hits[0].method).toBe("GET");
    expect(pathPart).toBe("/items/true/a%20b%2Fc,2/k,v%2Fw/5");
    expect([...new URLSearchParams(query)]).toEqual([
      ["qflag", "false"],
      ["qtags", "1"],
      ["qtags", "a"],
      ["k", "v"],
      ["n", '{"x":1}'],
      ["qnum", "3"],
      ["qstr", "s"],
    ]);
  });

  it("sends an optional boolean query value of false and omits it when absent", async () => {
    hits = [];
    const base = {
      pflag: true,
      ptags: [],
      pobj: {},
      pnum: 1,
      qflag: true,
      qtags: [],
      qobj: {},
      qnum: 1,
    };
    expect(
      (await callTool(booted.rpc, tool("typed-get").name, { ...base, qopt: false })).isError,
    ).toBe(false);
    expect((await callTool(booted.rpc, tool("typed-get").name, base)).isError).toBe(false);
    expect([...new URLSearchParams(hits[0].url.split("?")[1])]).toEqual([
      ["qflag", "true"],
      ["qnum", "1"],
      ["qopt", "false"],
    ]);
    expect([...new URLSearchParams(hits[1].url.split("?")[1])]).toEqual([
      ["qflag", "true"],
      ["qnum", "1"],
    ]);
  });

  it("passes typed values through the JSON body", async () => {
    hits = [];
    const r = await callTool(booted.rpc, tool("typed-post").name, {
      enabled: true,
      count: 2,
      tags: [1, "a"],
      meta: { k: "v" },
      nullable: false,
      label: "x",
    });
    expect(r.isError).toBe(false);
    expect(hits).toHaveLength(1);
    expect(hits[0].method).toBe("POST");
    expect(hits[0].url).toBe("/submit");
    expect(JSON.parse(hits[0].body)).toEqual({
      enabled: true,
      count: 2,
      tags: [1, "a"],
      meta: { k: "v" },
      nullable: false,
      label: "x",
    });
  });

  it("still rejects a wrong-typed value without sending a request", async () => {
    hits = [];
    const bad = [
      ["typed-post", { enabled: "true" }],
      ["typed-post", { tags: "a" }],
      ["typed-post", { meta: [1] }],
      ["typed-post", { nullable: "yes" }],
      ["typed-post", { count: "2" }],
    ] as const;
    for (const [name, args] of bad) {
      const r = await callTool(booted.rpc, tool(name).name, { ...args });
      expect(r.isError || r.error !== undefined, JSON.stringify(args)).toBe(true);
    }
    const r = await callTool(booted.rpc, tool("typed-get").name, {
      pflag: "true",
      ptags: [],
      pobj: {},
      pnum: 1,
      qflag: true,
      qtags: [],
      qobj: {},
      qnum: 1,
    });
    expect(r.isError || r.error !== undefined).toBe(true);
    expect(r.text + (r.error?.message ?? "")).toMatch(/boolean/i);
    expect(hits).toEqual([]);
  });
});
