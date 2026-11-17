import { type ChildProcess, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateMcpServer, OUTBOUND_HELPER_SOURCE } from "../src/generate/mcp-server.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";
import {
  CORE_DIR,
  freePort,
  killTracked,
  spawnServer,
  waitForRunning,
} from "./helpers/mcp-harness.js";

const API_HOST = "https://api.example.net";
const FORM_HOST = "https://forms.example.net";
const MAX_BYTES = 1048576;
const SHRUNK_TIMEOUT_MS = 400;
const CALL_DEADLINE_MS = 6000;

type Variant = "express" | "cf" | "vercel";
const VARIANTS: Variant[] = ["express", "cf", "vercel"];

const BAD_PATHS = ["/files/{a}#x", "/files\\{a}", "/files/{a}\t", "/files/{a}?q", "/files/{a}\n"];

const op = (operationId: string, path: string, method = "get", withBody = false) => ({
  path,
  method,
  operationId,
  parameters: [],
  ...(withBody
    ? {
        requestBody: {
          contentType: "application/json",
          required: true,
          properties: { note: { type: "string" } },
        },
      }
    : {}),
});

const form = (id: string, path: string) => ({
  id,
  action: `${FORM_HOST}${path}`,
  method: "POST",
  fields: [{ name: "note", type: "text", required: false }],
});

function buildCtx(): GenerateContext {
  return {
    pages: [
      {
        url: "https://example.com/",
        title: "Home",
        description: "",
        markdown: "hi",
      },
      {
        url: "https://example.com/contact",
        title: "Contact",
        description: "",
        markdown: "c",
        forms: [
          form("f-redirect", "/redirect307"),
          form("f-endless", "/endless"),
          form("f-stall", "/stall"),
        ],
      },
    ],
    rawPages: [],
    metadata: {
      baseUrl: "https://example.com",
      wellKnown: {},
      openapi: {
        specUrl: `${API_HOST}/openapi.json`,
        version: "3.0.0",
        serverUrl: API_HOST,
        endpoints: [
          op("redirGet", "/redirect302"),
          op("redirPost", "/redirect307", "post", true),
          op("endlessGet", "/endless"),
          op("stallGet", "/stall"),
          op("redirSelf", "/redirectSelf"),
          op("exactCap", "/exactcap"),
          {
            path: "/dup/proto",
            method: "post",
            operationId: "protoBody",
            summary: "proto-body",
            parameters: [],
            requestBody: {
              contentType: "application/json",
              required: false,
              properties: JSON.parse('{"__proto__":{"type":"string"}}'),
            },
          },
          ...BAD_PATHS.map((path, i) => op(`badPath${i}`, path)),
          {
            path: "/items/{id}",
            method: "get",
            operationId: "travItem",
            summary: "trav-item",
            parameters: [{ name: "id", in: "path", required: true, type: "string" }],
          },
          {
            path: "/files/{a}{b}",
            method: "get",
            operationId: "travCompose",
            summary: "trav-compose",
            parameters: [
              { name: "a", in: "path", required: true, type: "string" },
              { name: "b", in: "path", required: true, type: "string" },
            ],
          },
          {
            path: "/files/.{c}",
            method: "get",
            operationId: "travLiteral",
            summary: "trav-literal",
            parameters: [{ name: "c", in: "path", required: true, type: "string" }],
          },
          {
            path: "/dup/{id}",
            method: "post",
            operationId: "dupParams",
            summary: "dup-params",
            parameters: [
              { name: "id", in: "path", required: true, type: "string" },
              { name: "id", in: "query", required: true, type: "string" },
              { name: "id_query", in: "query", required: false, type: "string" },
            ],
            requestBody: {
              contentType: "application/json",
              required: false,
              properties: { id: { type: "string" } },
            },
          },
        ],
      },
    },
    baseUrl: "https://example.com",
    allowedOffOriginHosts: ["forms.example.net", "api.example.net"],
  };
}

let tmpRoot = "";
let fixtureA: HttpServer;
let fixtureB: HttpServer;
let portA = 0;
let portB = 0;
let hitsA: string[] = [];
let hitsB: string[] = [];
let bodiesA: string[] = [];
let expressDir = "";
let endlessWritten = 0;
let endlessClosed: Promise<void> = Promise.resolve();
const sockets = new Set<Socket>();

function track(srv: HttpServer) {
  srv.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
}

function destroyAll() {
  for (const s of sockets) s.destroy();
  sockets.clear();
}

function handleA(req: IncomingMessage, res: ServerResponse) {
  const path = req.url ?? "";
  hitsA.push(`${req.method} ${path}`);
  res.setHeader("connection", "close");
  if (/^\/(items|files|dup)\//.test(path)) {
    void readReqBody(req).then((b) => {
      bodiesA.push(b);
      res.end("echo");
    });
    return;
  }
  req.resume();
  if (path.startsWith("/redirectSelf")) {
    res.writeHead(302, { Location: `http://127.0.0.1:${portA}/landedSelf` });
    res.end();
  } else if (path.startsWith("/redirect302")) {
    res.writeHead(302, { Location: `http://127.0.0.1:${portB}/landed302` });
    res.end();
  } else if (path.startsWith("/redirect307")) {
    res.writeHead(307, { Location: `http://127.0.0.1:${portB}/landed307` });
    res.end();
  } else if (path.startsWith("/exactcap")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write(Buffer.alloc(MAX_BYTES, 0x61));
  } else if (path.startsWith("/endless")) {
    endlessWritten = 0;
    let open = true;
    endlessClosed = new Promise<void>((done) => {
      res.on("close", () => {
        open = false;
        done();
      });
    });
    res.writeHead(200, { "content-type": "text/plain" });
    const chunk = Buffer.alloc(16384, 0x61);
    const pump = () => {
      if (!open) return;
      endlessWritten += chunk.length;
      res.write(chunk);
      setTimeout(pump, 0);
    };
    pump();
  } else if (path.startsWith("/stall")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial");
  } else {
    res.end("ok");
  }
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(CORE_DIR, ".tmp-mcp-outbound-"));
  fixtureA = createHttpServer(handleA);
  fixtureB = createHttpServer((req, res) => {
    hitsB.push(`${req.method} ${req.url}`);
    req.resume();
    res.setHeader("connection", "close");
    res.end("landed");
  });
  track(fixtureA);
  track(fixtureB);
  await Promise.all([
    new Promise<void>((r) => fixtureA.listen(0, "127.0.0.1", () => r())),
    new Promise<void>((r) => fixtureB.listen(0, "127.0.0.1", () => r())),
  ]);
  portA = (fixtureA.address() as { port: number }).port;
  portB = (fixtureB.address() as { port: number }).port;
});

beforeEach(() => {
  hitsA = [];
  hitsB = [];
  bodiesA = [];
  endlessWritten = 0;
});

afterEach(() => {
  destroyAll();
});

afterAll(() => {
  killTracked();
  destroyAll();
  fixtureA?.close();
  fixtureB?.close();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

const TIMEOUT_DECL = "const OUTBOUND_TIMEOUT_MS = 10000;";

function shrinkTimeout(content: string): string {
  const count = content.split(TIMEOUT_DECL).length - 1;
  if (count === 0) return content;
  expect(count).toBe(1);
  return content.replace(TIMEOUT_DECL, `const OUTBOUND_TIMEOUT_MS = ${SHRUNK_TIMEOUT_MS};`);
}

function writeFiles(files: GeneratedFile[], root: string): void {
  for (const f of files) {
    const target = join(root, f.filename);
    mkdirSync(dirname(target), { recursive: true });
    let content = f.content
      .replaceAll(API_HOST, `http://127.0.0.1:${portA}`)
      .replaceAll(FORM_HOST, `http://127.0.0.1:${portA}`);
    if (/(server|worker|mcp)\.ts$/.test(f.filename)) content = shrinkTimeout(content);
    writeFileSync(target, content);
  }
}

function transpile(file: string): void {
  const out = ts.transpileModule(readFileSync(file, "utf-8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: file,
  });
  writeFileSync(file.replace(/\.ts$/, ".mjs"), out.outputText);
}

function parseBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = trimmed.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`Unparseable response: ${text}`);
  return JSON.parse(dataLine.slice(5).trim());
}

type Rpc = (body: unknown) => Promise<any>;

async function readReqBody(req: IncomingMessage): Promise<string> {
  return await new Promise((res) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => res(data));
  });
}

const closers: Array<() => void> = [];
afterAll(() => {
  for (const c of closers) c();
});

async function boot(variant: Variant): Promise<Rpc> {
  const root = join(tmpRoot, variant);
  const ctx = buildCtx();
  if (variant === "express") {
    writeFiles(generateMcpServer(ctx), root);
    const dir = join(root, "mcp-server");
    expressDir = dir;
    const port = await freePort();
    const { proc, output } = spawnServer(dir, port);
    closers.push(() => killProc(proc));
    await waitForRunning(proc, output);
    return async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_DEADLINE_MS),
      });
      return parseBody(await res.text());
    };
  }
  if (variant === "cf") {
    writeFiles(generateMcpServer(ctx, "cf"), root);
    const dir = join(root, "mcp-server");
    transpile(join(dir, "worker.ts"));
    const data: Record<string, string> = {};
    for (const k of ["pages", "faq", "products", "business"]) {
      const p = join(dir, "data", `${k}.json`);
      if (existsSync(p)) data[k] = readFileSync(p, "utf-8");
    }
    const env = { MCP_DATA: { get: async (k: string) => data[k] ?? null } };
    const worker = (await import(/* @vite-ignore */ pathToFileURL(join(dir, "worker.mjs")).href))
      .default as { fetch: (req: Request, env: unknown) => Promise<Response> };
    return async (body) => {
      const res = await worker.fetch(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(body),
        }),
        env,
      );
      return parseBody(await res.text());
    };
  }
  writeFiles(generateMcpServer(ctx, "vercel"), root);
  const dir = join(root, "mcp-server");
  transpile(join(dir, "api/mcp.ts"));
  const mod = await import(/* @vite-ignore */ pathToFileURL(join(dir, "api/mcp.mjs")).href);
  const srv = createHttpServer(async (req, res) => {
    try {
      const raw = await readReqBody(req);
      (req as any).body = raw ? JSON.parse(raw) : undefined;
      await mod.default(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  closers.push(() => {
    srv.close();
    srv.closeAllConnections();
  });
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
  return async (body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_DEADLINE_MS),
    });
    return parseBody(await res.text());
  };
}

function killProc(proc: ChildProcess) {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
}

let nextId = 100;

async function toolByDescription(rpc: Rpc, fragment: string): Promise<string> {
  const list = await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/list" });
  const tool = (list.result.tools as Array<{ name: string; description: string }>).find((t) =>
    t.description.includes(fragment),
  );
  if (!tool) throw new Error(`no tool described by ${fragment}`);
  return tool.name;
}

async function callTool(rpc: Rpc, name: string, args: Record<string, unknown> = {}) {
  const started = Date.now();
  const res = await rpc({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return {
    text: (res.result?.content?.[0]?.text ?? "") as string,
    isError: Boolean(res.result?.isError),
    ms: Date.now() - started,
  };
}

describe.each(VARIANTS)("outbound fetch: %s", (variant) => {
  let rpc: Rpc;
  let formRedirect = "";
  let formEndless = "";
  let formStall = "";

  beforeAll(async () => {
    rpc = await boot(variant);
    formRedirect = await toolByDescription(
      rpc,
      `Submit form: POST http://127.0.0.1:${portA}/redirect307`,
    );
    formEndless = await toolByDescription(
      rpc,
      `Submit form: POST http://127.0.0.1:${portA}/endless`,
    );
    formStall = await toolByDescription(rpc, `Submit form: POST http://127.0.0.1:${portA}/stall`);
  }, 60000);

  describe("redirects are reported, never followed", () => {
    const cases: Array<{ label: string; tool: () => string; status: number; args?: object }> = [
      { label: "OpenAPI GET 302", tool: () => "redir-get", status: 302 },
      { label: "OpenAPI POST 307", tool: () => "redir-post", status: 307, args: { note: "x" } },
      { label: "form POST 307", tool: () => formRedirect, status: 307, args: { note: "x" } },
    ];
    it("same-origin redirect is reported and the landing URL is never fetched", async () => {
      const r = await callTool(rpc, "redir-self");
      expect(r.text).toContain("Status: 302");
      expect(r.text).toContain(`http://127.0.0.1:${portA}/landedSelf`);
      expect(r.isError).toBe(false);
      await new Promise((res) => setTimeout(res, 150));
      expect(hitsA).toEqual(["GET /redirectSelf"]);
      expect(hitsB).toEqual([]);
    });
    it.each(cases)("$label", async ({ tool, status, args }) => {
      const r = await callTool(rpc, tool(), args as Record<string, unknown>);
      expect(r.text).toContain(`Status: ${status}`);
      expect(r.text).toContain(`http://127.0.0.1:${portB}/landed${status}`);
      expect(r.isError).toBe(false);
      await new Promise((res) => setTimeout(res, 150));
      expect(hitsA).toHaveLength(1);
      expect(hitsB).toEqual([]);
    });
  });

  describe("(b) path params cannot traverse", () => {
    it.each([["."], [".."]])("rejects %s without fetching", async (id) => {
      const r = await callTool(rpc, await toolByDescription(rpc, "trav-item"), { id });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/path segment|path parameter/i);
      expect(hitsA).toEqual([]);
    });

    it.each([
      ["%2e", "/items/%252e"],
      ["%2E%2e", "/items/%252E%252e"],
      ["abc", "/items/abc"],
    ])("sends %s as an encoded segment (not a dot segment)", async (id, wire) => {
      const r = await callTool(rpc, await toolByDescription(rpc, "trav-item"), { id });
      expect(r.isError).toBe(false);
      expect(hitsA).toEqual([`GET ${wire}`]);
    });

    it("rejects dot segments composed from adjacent placeholders", async () => {
      const tool = await toolByDescription(rpc, "trav-compose");
      const r = await callTool(rpc, tool, { a: ".", b: "." });
      expect(r.isError).toBe(true);
      expect(hitsA).toEqual([]);
    });

    it("rejects a dot segment completed by an empty value after a literal dot", async () => {
      const tool = await toolByDescription(rpc, "trav-literal");
      const r = await callTool(rpc, tool, { c: "" });
      expect(r.isError).toBe(true);
      expect(hitsA).toEqual([]);
    });

    it("allows a placeholder pair that does not form a dot segment", async () => {
      const tool = await toolByDescription(rpc, "trav-compose");
      const r = await callTool(rpc, tool, { a: ".", b: "x" });
      expect(r.isError).toBe(false);
      expect(hitsA).toEqual(["GET /files/.x"]);
    });
  });

  describe("(d) same-name params keep separate keys", () => {
    it("allocates distinct keys and routes each value to its own wire place", async () => {
      const list = await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/list" });
      const tool = (
        list.result.tools as Array<{
          description: string;
          name: string;
          inputSchema: { properties: Record<string, unknown>; required?: string[] };
        }>
      ).find((t) => t.description.includes("dup-params"));
      expect(tool).toBeTruthy();
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
        "id",
        "id_body",
        "id_query",
        "id_query_2",
      ]);
      expect([...(tool?.inputSchema.required ?? [])].sort()).toEqual(["id", "id_query_2"]);

      const r = await callTool(rpc, tool?.name ?? "", {
        id: "P",
        id_query_2: "Q1",
        id_query: "Q2",
        id_body: "B",
      });
      expect(r.isError).toBe(false);
      expect(hitsA).toEqual(["POST /dup/P?id=Q1&id_query=Q2"]);
      expect(JSON.parse(bodiesA[0])).toEqual({ id: "B" });
    });
  });

  describe("response bodies are bounded", () => {
    const cases: Array<{ label: string; tool: () => string; args?: object }> = [
      { label: "OpenAPI tool", tool: () => "endless-get" },
      { label: "form tool", tool: () => formEndless, args: { note: "x" } },
    ];
    it.each(cases)("$label stops at the byte cap and marks truncation", async ({ tool, args }) => {
      const r = await callTool(rpc, tool(), args as Record<string, unknown>);
      expect(r.isError).toBe(false);
      expect(r.text).toContain("Status: 200");
      expect(r.text).toContain("truncated");
      expect(r.ms).toBeLessThan(SHRUNK_TIMEOUT_MS * 4);
      await Promise.race([endlessClosed, new Promise((res) => setTimeout(res, 3000))]);
      expect(endlessWritten).toBeGreaterThanOrEqual(MAX_BYTES);
      expect(endlessWritten).toBeLessThan(MAX_BYTES * 3);
    });
  });

  describe("body of exactly the cap", () => {
    it("returns the bounded response without waiting for more bytes", async () => {
      const r = await callTool(rpc, "exact-cap");
      expect(r.isError).toBe(false);
      expect(r.text).toContain("Status: 200");
      expect(r.text).toContain("truncated");
      expect(r.ms).toBeLessThan(SHRUNK_TIMEOUT_MS * 0.8);
    });
  });

  describe("a __proto__ body property (input key is suffixed, wire name is not)", () => {
    it("is sent as an own JSON key", async () => {
      const r = await callTool(rpc, "proto-body", { __proto___body: "B" });
      expect(r.isError).toBe(false);
      expect(bodiesA).toEqual(['{"__proto__":"B"}']);
    });
  });

  describe("one deadline covers the body read", () => {
    const cases: Array<{ label: string; tool: () => string; args?: object }> = [
      { label: "OpenAPI tool", tool: () => "stall-get" },
      { label: "form tool", tool: () => formStall, args: { note: "x" } },
    ];
    it.each(cases)("$label aborts a stalled body", async ({ tool, args }) => {
      const r = await callTool(rpc, tool(), args as Record<string, unknown>);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Error:/);
      expect(r.ms).toBeLessThan(SHRUNK_TIMEOUT_MS * 8);
    });
  });
});

describe("generated Express server type-checks with same-name params", () => {
  it("tsc --noEmit passes", () => {
    expect(expressDir).not.toBe("");
    execFileSync(
      join(CORE_DIR, "node_modules/.bin/tsc"),
      ["--noEmit", "-p", join(expressDir, "tsconfig.json")],
      {
        stdio: "pipe",
      },
    );
  }, 60000);
});

describe("endpoint paths the URL parser would rewrite", () => {
  it.each(BAD_PATHS)("generation drops %j", (path) => {
    const files = generateMcpServer(buildCtx());
    const server = files.find((f) => f.filename.endsWith("server.ts"))?.content ?? "";
    const i = BAD_PATHS.indexOf(path);
    expect(server).not.toContain(`bad-path${i}`);
    expect(server).toContain("exact-cap");
  });

  it.each(BAD_PATHS)("runtime assertSafePath rejects a resolved dot segment in %j", async (tpl) => {
    const js = ts.transpileModule(`${OUTBOUND_HELPER_SOURCE}\nexport { assertSafePath };`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const { assertSafePath } = await import(
      /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(js)}`
    );
    expect(() => assertSafePath(tpl.replace("{a}", encodeURIComponent("..")))).toThrow(
      /path segment/,
    );
    expect(() => assertSafePath(tpl.replace("{a}", "abc"))).not.toThrow();
  });
});

describe("runtime assertSafePath on raw percent-encoded spec literals", () => {
  const load = async () => {
    const js = ts.transpileModule(`${OUTBOUND_HELPER_SOURCE}\nexport { assertSafePath };`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    return (await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(js)}`))
      .assertSafePath as (p: string) => void;
  };

  it.each([
    "/files/%2e",
    "/files/%2E%2e",
    "/files/.%2e",
    "/files/%2e./x",
  ])("rejects %s", async (p) => {
    const assertSafePath = await load();
    expect(() => assertSafePath(p)).toThrow(/path segment/);
  });

  it.each(["/files/%2ex", "/files/%252e"])("allows %s", async (p) => {
    const assertSafePath = await load();
    expect(() => assertSafePath(p)).not.toThrow();
  });
});

describe("static guard", () => {
  const FILES: Array<[string, Variant]> = [
    ["server.ts", "express"],
    ["worker.ts", "cf"],
    ["api/mcp.ts", "vercel"],
  ];
  it.each(FILES)("%s has no fetch() call outside the helper", (file, variant) => {
    const files = generateMcpServer(buildCtx(), variant === "express" ? undefined : variant);
    const f = files.find((x) => x.filename.endsWith(file));
    expect(f).toBeTruthy();
    const src = f?.content ?? "";
    expect(src).toContain(OUTBOUND_HELPER_SOURCE);
    expect(src).toContain("const OUTBOUND_TIMEOUT_MS = 10000;");
    const rest = src.replace(OUTBOUND_HELPER_SOURCE, "");
    const stray = rest
      .split("\n")
      .filter((l) => /(^|[^\w.])fetch\(/.test(l) && !/\basync fetch\(/.test(l));
    expect(stray).toEqual([]);
    expect(rest).not.toContain("_controller");
  });
});
