import type { ChildProcess } from "node:child_process";
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
  req.resume();
  res.setHeader("connection", "close");
  if (path.startsWith("/redirect302")) {
    res.writeHead(302, { Location: `http://127.0.0.1:${portB}/landed302` });
    res.end();
  } else if (path.startsWith("/redirect307")) {
    res.writeHead(307, { Location: `http://127.0.0.1:${portB}/landed307` });
    res.end();
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
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      );
      return JSON.parse(await res.text());
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
