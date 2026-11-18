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
    "/case-own": {
      get: {
        operationId: "caseOwn",
        summary: "case-own",
        parameters: [
          { name: "filter", in: "query", ...obj },
          { name: "FILTER", in: "query", ...str },
        ],
      },
    },
    "/bracket-own": {
      get: {
        operationId: "bracketOwn",
        summary: "bracket-own",
        parameters: [
          { name: "page", in: "query", ...obj },
          { name: "page[size]", in: "query", ...str },
        ],
      },
    },
    "/declared-page-size": {
      get: {
        operationId: "declaredPageSize",
        summary: "declared-page-size",
        parameters: [
          { name: "page[size]", in: "query", ...str },
          { name: "filter[status]", in: "query", ...str },
          { name: "q", in: "query", ...obj },
        ],
      },
    },
    "/declared-flag-brackets": {
      get: {
        operationId: "declaredFlagBrackets",
        summary: "declared-flag-brackets",
        parameters: [
          { name: "flag[]", in: "query", ...str },
          { name: "filter", in: "query", ...obj },
        ],
      },
    },
    "/page-keys": {
      get: {
        operationId: "pageKeys",
        summary: "page-keys",
        parameters: [{ name: "page", in: "query", ...obj }],
      },
    },
    "/literal-brackets": {
      get: {
        operationId: "literalBrackets",
        summary: "literal-brackets",
        parameters: [
          { name: "ids[]", in: "query", ...str },
          { name: "filter", in: "query", ...obj },
        ],
      },
    },
    "/case-scalars": {
      get: {
        operationId: "caseScalars",
        summary: "case-scalars",
        parameters: [
          { name: "flag", in: "query", ...str },
          { name: "Flag", in: "query", ...str },
        ],
      },
    },
    "/path-level-flag": {
      parameters: [{ name: "flag", in: "query", ...bool }],
      get: {
        operationId: "pathLevelFlag",
        summary: "path-level-flag",
        parameters: [{ name: "filter", in: "query", ...obj }],
      },
    },
    "/things/{id}": {
      parameters: [
        { name: "id", in: "path", required: true, ...str },
        { name: "lang", in: "query", ...str },
      ],
      get: { operationId: "getThing", summary: "get-thing" },
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

  for (const key of ["flag[]", "flag[a]", "FLAG", "Flag[a]"]) {
    it(`an object property ${JSON.stringify(key)} reaches the declared flag on the upstream, so it is refused`, async () => {
      const { r, sent } = await call("scalar-first", { flag: true, filter: { [key]: "evil" } });
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toContain(JSON.stringify(key));
      expect(r.text).toContain('"flag"');
      expect(sent).toEqual([]);
    });
  }

  it("a property of a declared scalar that is itself bracketed or cased still collides", async () => {
    const { r, sent } = await call("literal-brackets", { filter: { ids: "x" } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('"ids[]"');
    expect(sent).toEqual([]);
  });

  it("two object parameters whose keys differ only by case are refused", async () => {
    const { r, sent } = await call("two-objects", { a: { Sort: 1 }, b: { sort: 2 } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain("another object query parameter");
    expect(sent).toEqual([]);
  });

  it("two distinct lone-surrogate keys in two object parameters are refused", async () => {
    const { r, sent } = await call("two-objects", { a: { "\uD800": "a" }, b: { "\uDC00": "b" } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain("another object query parameter");
    expect(sent).toEqual([]);
  });

  it("two lone-surrogate keys in one object are refused with a same-object message", async () => {
    const { r, sent } = await call("two-objects", { a: { "\uD800": "a", "\uDC00": "b" } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain("collide as one query key");
    expect(r.text).not.toContain("another object query parameter");
    expect(sent).toEqual([]);
  });

  it("keys that differ only by case in one object are refused with a same-object message", async () => {
    const { r, sent } = await call("two-objects", { a: { "Page[size]": 1, "page[size]": 2 } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain("collide as one query key");
    expect(sent).toEqual([]);
  });

  it("one lone-surrogate key is sent as the replacement character", async () => {
    const { r, sent } = await call("two-objects", { a: { "\uD800": "a" } });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/two-objects?%EF%BF%BD=a"]);
  });

  it("an object with page[size] and page[number] and no declared page is sent", async () => {
    const { r, sent } = await call("page-keys", { page: { "page[size]": 10, "page[number]": 2 } });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/page-keys?page%5Bsize%5D=10&page%5Bnumber%5D=2"]);
  });

  it("a declared scalar named ids[] beside an unrelated object is sent", async () => {
    const { r, sent } = await call("literal-brackets", { "ids[]": "1", filter: { color: "red" } });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/literal-brackets?ids%5B%5D=1&color=red"]);
  });

  it("declared scalars flag and Flag are both sent", async () => {
    const { r, sent } = await call("case-scalars", { flag: "a", Flag: "b" });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/case-scalars?flag=a&Flag=b"]);
  });

  it("a path-level query parameter collides with an operation-level object property", async () => {
    const { r, sent } = await call("path-level-flag", { flag: true, filter: { flag: "evil" } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('"flag"');
    expect(r.text).toContain('"filter"');
    expect(sent).toEqual([]);
  });

  it("a path-level query parameter and a non-colliding object are sent", async () => {
    const { r, sent } = await call("path-level-flag", { flag: true, filter: { color: "red" } });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/path-level-flag?flag=true&color=red"]);
  });

  it("an object property named like a case-variant declared scalar is refused, even equal to its own object name by case", async () => {
    const { r, sent } = await call("case-own", { filter: { FILTER: "x" }, FILTER: "a" });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('"FILTER"');
    expect(sent).toEqual([]);
  });

  it("an object property equal to a bracketed declared scalar is refused", async () => {
    const { r, sent } = await call("bracket-own", {
      page: { "page[size]": "x" },
      "page[size]": "a",
    });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('"page[size]"');
    expect(sent).toEqual([]);
  });

  for (const [first, second] of [
    [{ flag: "1" }, { "flag[]": "2" }],
    [{ "flag[]": "2" }, { flag: "1" }],
    [{ FLAG: "1" }, { "flag[a]": "2" }],
  ]) {
    it(`a bare key beside its bracket form across objects is refused: ${JSON.stringify([first, second])}`, async () => {
      const { r, sent } = await call("two-objects", { a: first, b: second });
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toContain("another object query parameter");
      expect(sent).toEqual([]);
    });
  }

  it("a bare key beside its bracket form in one object is refused with the same-object message", async () => {
    const { r, sent } = await call("two-objects", { a: { flag: "1", "FLAG[x]": "2" } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain("collide as one query key");
    expect(r.text).not.toContain("another object query parameter");
    expect(sent).toEqual([]);
  });

  it("distinct bracket keys with one base are sent across objects", async () => {
    const { r, sent } = await call("two-objects", { a: { "flag[a]": "1" }, b: { "flag[b]": "2" } });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/two-objects?flag%5Ba%5D=1&flag%5Bb%5D=2"]);
  });

  it("a declared page[size] and a property page[number] are sent", async () => {
    const { r, sent } = await call("declared-page-size", {
      "page[size]": "10",
      q: { "page[number]": 2, "filter[type]": "x" },
    });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual([
      "/declared-page-size?page%5Bsize%5D=10&page%5Bnumber%5D=2&filter%5Btype%5D=x",
    ]);
  });

  it("a declared page[size] and a bare property page are refused", async () => {
    const { r, sent } = await call("declared-page-size", { "page[size]": "10", q: { page: 2 } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('"page[size]"');
    expect(sent).toEqual([]);
  });

  it("a declared flag[] and a bare property flag are refused", async () => {
    const { r, sent } = await call("declared-flag-brackets", {
      "flag[]": "1",
      filter: { flag: "x" },
    });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('"flag[]"');
    expect(sent).toEqual([]);
  });

  it("a path-level path parameter is substituted into the URL", async () => {
    const { r, sent } = await call("get-thing", { id: "7", lang: "fr" });
    expect(r.isError, r.text).toBe(false);
    expect(sent).toEqual(["/things/7?lang=fr"]);
  });
});
