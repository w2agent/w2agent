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

const str = { schema: { type: "string" } };
const bool = { schema: { type: "boolean" } };
const obj = { schema: { type: "object" } };

const spec = {
  openapi: "3.0.3",
  info: { title: "Collide" },
  servers: [{ url: API_HOST }],
  paths: {
    "/scalar-first": {
      get: {
        operationId: "scalarFirst",
        summary: "scalar-first",
        parameters: [
          { name: "flag", in: "query", ...bool },
          { name: "filter", in: "query", ...obj },
        ],
      },
    },
    "/object-first": {
      get: {
        operationId: "objectFirst",
        summary: "object-first",
        parameters: [
          { name: "filter", in: "query", ...obj },
          { name: "flag", in: "query", ...bool },
        ],
      },
    },
    "/two-objects": {
      get: {
        operationId: "twoObjects",
        summary: "two-objects",
        parameters: [
          { name: "a", in: "query", ...obj },
          { name: "b", in: "query", ...obj },
        ],
      },
    },
    "/own-name": {
      get: {
        operationId: "ownName",
        summary: "own-name",
        parameters: [
          { name: "filter", in: "query", ...obj },
          { name: "other", in: "query", ...str },
        ],
      },
    },
    "/object-named": {
      get: {
        operationId: "objectNamed",
        summary: "object-named",
        parameters: [
          { name: "filter", in: "query", ...obj },
          { name: "sort", in: "query", ...obj },
        ],
      },
    },
    "/path-{flag}": {
      get: {
        operationId: "pathAndQuery",
        summary: "path-and-query",
        parameters: [
          { name: "flag", in: "path", required: true, ...str },
          { name: "filter", in: "query", ...obj },
        ],
      },
    },
  },
};

function ctxFor(): GenerateContext {
  const openapi = parseOpenAPISpec(
    spec as unknown as Record<string, unknown>,
    `${API_HOST}/openapi.json`,
  );
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
  tmpRoot = mkdtempSync(join(CORE_DIR, ".tmp-mcp-oas-collide-"));
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

describe.each(VARIANTS)("generated query key collisions: %s", (variant: Variant) => {
  let booted: Booted;

  beforeAll(async () => {
    booted = await bootGenerated(variant, ctxFor(), join(tmpRoot, variant), [
      [API_HOST, `http://127.0.0.1:${port}`],
    ]);
    closers.push(booted.close);
  }, 60000);

  const call = async (tool: string, args: Record<string, unknown>) => {
    urls = [];
    const r = await callTool(booted.rpc, tool, args);
    return { r, sent: [...urls] };
  };

  for (const tool of ["scalar-first", "object-first"]) {
    it(`${tool}: an object property named like another query parameter is a tool error, nothing is sent`, async () => {
      const { r, sent } = await call(tool, { flag: true, filter: { flag: "evil", color: "red" } });
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toContain('"flag"');
      expect(r.text).toContain('"filter"');
      expect(sent).toEqual([]);
    });

    it(`${tool}: the collision is declared, so it errors even when the scalar is not supplied`, async () => {
      const { r, sent } = await call(tool, { filter: { flag: "evil" } });
      expect(r.isError, r.text).toBe(true);
      expect(sent).toEqual([]);
    });

    it(`${tool}: a non-colliding object still explodes in order`, async () => {
      const { r, sent } = await call(tool, { flag: true, filter: { color: "red", size: 2 } });
      expect(r.isError, r.text).toBe(false);
      expect(sent).toHaveLength(1);
      const query = sent[0].split("?")[1];
      expect(query.split("&").sort()).toEqual(["color=red", "flag=true", "size=2"]);
    });
  }

  it("two object parameters that share a property key is a tool error, nothing is sent", async () => {
    const { r, sent } = await call("two-objects", { a: { x: 1, y: 2 }, b: { y: 3 } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('"y"');
    expect(sent).toEqual([]);
  });

  it("two object parameters with distinct keys both explode", async () => {
    const { r, sent } = await call("two-objects", { a: { x: 1 }, b: { y: 3 } });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/two-objects?x=1&y=3"]);
  });

  it("an object property equal to its own parameter name is sent", async () => {
    const { r, sent } = await call("own-name", { filter: { filter: "x" }, other: "o" });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/own-name?filter=x&other=o"]);
  });

  it("an object property named like another object parameter is sent: that name never goes on the wire", async () => {
    const { r, sent } = await call("object-named", {
      filter: { sort: "up" },
      sort: { dir: "asc" },
    });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/object-named?sort=up&dir=asc"]);
  });

  it("two object parameters that both set the property sort are still refused", async () => {
    const { r, sent } = await call("object-named", { filter: { sort: "up" }, sort: { sort: "x" } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('"sort"');
    expect(sent).toEqual([]);
  });

  it("a path parameter with the same name does not collide with an object property", async () => {
    const { r, sent } = await call("path-and-query", { flag: "p", filter: { flag: "q" } });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/path-p?flag=q"]);
  });
});
