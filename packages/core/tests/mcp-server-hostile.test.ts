import { type ChildProcess, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
} from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EcommerceArtifacts } from "../src/generate/ecommerce.js";
import type { LocalBusinessArtifacts } from "../src/generate/local-business.js";
import { detectTools, generateMcpServer } from "../src/generate/mcp-server.js";
import { generateSkillMd } from "../src/generate/skill-md.js";
import { generateOpenClawSkillMd } from "../src/generate/skill-md-openclaw.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";
import { parseOpenAPISpec } from "../src/shared/openapi.js";
import {
  CORE_DIR,
  freePort,
  killTracked,
  spawnServer,
  waitForRunning,
} from "./helpers/mcp-harness.js";

const MARKER = "INJECTED_CODE_RAN";
const PAYLOAD = `(globalThis.__INJECTED = 1, globalThis.process.stdout.write("INJECTED_" + "CODE_RAN "))`;
const HOSTILE_TITLE = `Acme \`tick\` \${${PAYLOAD}} </script> "dq" 'sq' back\\slash\nnewline sep -->`;
const FORM_ID = `hostile\`\${${PAYLOAD}}"`;

const API_HOST = "https://api.example.net";
const FORM_URL = "https://forms.example.net/post";

function buildCtx(): GenerateContext {
  return {
    pages: [
      {
        url: "https://example.com/",
        title: HOSTILE_TITLE,
        description: `desc \`\${${PAYLOAD}}\``,
        markdown: "Welcome home",
      },
      {
        url: "https://example.com/contact",
        title: "Contact",
        description: "",
        markdown: "Contact page",
        forms: [
          {
            id: FORM_ID,
            action: FORM_URL,
            method: "POST",
            fields: [
              {
                name: `em-ail\`\${${PAYLOAD}}`,
                type: "email",
                required: true,
                label: `Label \`\${${PAYLOAD}}\n"x"`,
              },
            ],
          },
          {
            id: "hostile",
            action: FORM_URL,
            method: "POST",
            fields: [{ name: "note", type: "text", required: false }],
          },
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
        serverUrl: `${API_HOST}/v1`,
        endpoints: [
          {
            path: "/users/{user-id}/items",
            method: "get",
            operationId: "getPage",
            summary: `Items \`\${${PAYLOAD}}\`\nline2`,
            parameters: [
              { name: "user-id", in: "path", type: "string", required: true },
              { name: `q=${PAYLOAD}`, in: "query", type: "string", required: false },
              { name: "page-size", in: "query", type: "integer", required: false },
              { name: "api-key", in: "query", type: "string", required: true },
            ],
          },
          {
            path: "/things",
            method: "post",
            operationId: "searchSite",
            parameters: [],
            requestBody: {
              contentType: "application/json",
              required: true,
              properties: {
                "body-field": { type: "string" },
                [`b;${PAYLOAD};//`]: { type: "string" },
              },
            },
          },
          {
            path: "/other",
            method: "get",
            operationId: "submit\nHostile",
            parameters: [],
          },
          {
            path: "/last",
            method: "get",
            operationId: "listPages",
            parameters: [{ name: "__proto__", in: "query", type: "string", required: false }],
          },
          { path: "/ctor", method: "get", operationId: "constructor", parameters: [] },
          { path: "/ctor2", method: "get", operationId: "toString", parameters: [] },
        ],
      },
    },
    baseUrl: "https://example.com",
    allowedOffOriginHosts: ["forms.example.net", "api.example.net"],
  };
}

const EXPECTED_TOOLS = [
  "list-pages",
  "get-page",
  "search-site",
  "get-page-2",
  "search-site-2",
  "list-pages-2",
  "submit-hostile",
  "submit-hostile-2",
  "constructor-2",
  "to-string",
];

const TOOL_CALLS = {
  hyphenPath: {
    name: "get-page-2",
    arguments: { "user-id": "42", "api-key": "k1", "page-size": 7, [`q=${PAYLOAD}`]: "v" },
  },
  body: {
    name: "search-site-2",
    arguments: { "body-field": "bf", [`b;${PAYLOAD};//`]: "bp" },
  },
};

let tmpRoot = "";
let echoServer: HttpServer | null = null;
let echoPort = 0;
let echoHits: Array<{ method: string; url: string; body: string }> = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => res(data));
  });
}

function parseBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = trimmed.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`Unparseable response: ${text}`);
  return JSON.parse(dataLine.slice(5).trim());
}

function writeFiles(files: GeneratedFile[], root: string): void {
  for (const f of files) {
    const target = join(root, f.filename);
    mkdirSync(dirname(target), { recursive: true });
    const content = f.content
      .replaceAll(API_HOST, `http://127.0.0.1:${echoPort}`)
      .replaceAll(FORM_URL, `http://127.0.0.1:${echoPort}/post`);
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

function expectEchoed() {
  expect(echoHits).toHaveLength(2);
  const get = echoHits.find((h) => h.method === "GET");
  const post = echoHits.find((h) => h.method === "POST");
  const getUrl = new URL(get?.url ?? "", "http://x");
  expect(getUrl.pathname).toBe("/v1/users/42/items");
  expect(Object.fromEntries(getUrl.searchParams)).toEqual({
    "api-key": "k1",
    "page-size": "7",
    [`q=${PAYLOAD}`]: "v",
  });
  expect(post?.url).toBe("/v1/things");
  expect(JSON.parse(post?.body ?? "null")).toEqual({
    "body-field": "bf",
    [`b;${PAYLOAD};//`]: "bp",
  });
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(CORE_DIR, ".tmp-mcp-hostile-"));
  echoServer = createHttpServer(async (req, res) => {
    const body = await readBody(req);
    echoHits.push({ method: req.method ?? "", url: req.url ?? "", body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ echoed: req.url }));
  });
  await new Promise<void>((res) => echoServer?.listen(0, "127.0.0.1", () => res()));
  echoPort = (echoServer.address() as { port: number }).port;
});

beforeEach(() => {
  echoHits = [];
});

afterAll(() => {
  killTracked();
  echoServer?.close();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

interface ExpressHandle {
  dir: string;
  proc: ChildProcess;
  output: () => string;
  rpc: (body: unknown) => Promise<any>;
}

async function startExpress(
  name: string,
  ctx: GenerateContext,
  artifacts?: EcommerceArtifacts | null,
  lb?: LocalBusinessArtifacts | null,
): Promise<ExpressHandle> {
  const root = join(tmpRoot, name);
  writeFiles(generateMcpServer(ctx, undefined, artifacts, lb), root);
  const dir = join(root, "mcp-server");
  const port = await freePort();
  const { proc, output } = spawnServer(dir, port);
  await waitForRunning(proc, output);
  const rpc = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return parseBody(await res.text());
  };
  return { dir, proc, output, rpc };
}

async function loadWorker(name: string, ctx: GenerateContext) {
  const root = join(tmpRoot, name);
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
  const call = async (body: unknown) => {
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
  const info = async () =>
    JSON.parse(await (await worker.fetch(new Request("http://127.0.0.1/mcp"), env)).text());
  return { call, info };
}

describe("hostile crawl data: Express server", () => {
  let h: ExpressHandle;

  beforeAll(async () => {
    h = await startExpress("express", buildCtx());
  }, 40000);

  it("type-checks", () => {
    execFileSync(
      join(CORE_DIR, "node_modules/.bin/tsc"),
      ["--noEmit", "-p", join(h.dir, "tsconfig.json")],
      { stdio: "pipe" },
    );
  }, 60000);

  it("boots without executing crawled text and lists deduped tools", async () => {
    expect(h.output()).not.toContain(MARKER);
    const list = await h.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
    expect(new Set(names).size).toBe(names.length);
    expect(h.output()).not.toContain(MARKER);
  });

  it("OpenAPI tools with hyphenated and hostile param names build the exact requests", async () => {
    const get = await h.rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: TOOL_CALLS.hyphenPath,
    });
    expect(get.result.content[0].text).toContain("Status: 200");
    const post = await h.rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: TOOL_CALLS.body,
    });
    expect(post.result.content[0].text).toContain("Status: 200");
    expectEchoed();
    expect(h.output()).not.toContain(MARKER);
  });
});

describe("hostile crawl data: Cloudflare worker", () => {
  let call: Awaited<ReturnType<typeof loadWorker>>["call"];
  let info: Awaited<ReturnType<typeof loadWorker>>["info"];

  beforeAll(async () => {
    ({ call, info } = await loadWorker("cf", buildCtx()));
  });

  it("tools/list succeeds and dedupes OpenAPI names against built-in and form tools", async () => {
    const list = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = list.result.tools as Array<{ name: string; inputSchema: any }>;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
    expect(new Set(names).size).toBe(names.length);
    const advertised: string[] = (await info()).tools;
    expect(advertised).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
    expect(new Set(advertised).size).toBe(advertised.length);
    const listPages2 = tools.find((t) => t.name === "list-pages-2");
    expect(Object.hasOwn(listPages2?.inputSchema.properties, "__proto__")).toBe(true);
    expect((globalThis as any).__INJECTED).toBeUndefined();
  });

  it("OpenAPI tools with hyphenated and hostile param names build the exact requests", async () => {
    const get = await call({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: TOOL_CALLS.hyphenPath,
    });
    expect(get.result?.content?.[0]?.text).toContain("Status: 200");
    const post = await call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: TOOL_CALLS.body,
    });
    expect(post.result?.content?.[0]?.text).toContain("Status: 200");
    expectEchoed();
    expect((globalThis as any).__INJECTED).toBeUndefined();
  });
});

describe("hostile crawl data: Vercel handler behind a body-consuming shim", () => {
  let server: HttpServer;
  let url = "";

  // Mimics @vercel/node: the request stream is consumed before the handler
  // runs and the parsed body is exposed as req.body.
  const call = async (body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    return parseBody(await res.text());
  };

  beforeAll(async () => {
    const root = join(tmpRoot, "vercel");
    writeFiles(generateMcpServer(buildCtx(), "vercel"), root);
    const dir = join(root, "mcp-server");
    transpile(join(dir, "api/mcp.ts"));
    const mod = await import(/* @vite-ignore */ pathToFileURL(join(dir, "api/mcp.mjs")).href);
    server = createHttpServer(async (req, res) => {
      try {
        const raw = await readBody(req);
        (req as any).body = raw ? JSON.parse(raw) : undefined;
        await mod.default(req, res);
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  });

  afterAll(() => {
    server?.close();
  });

  it("initialize and tools/list succeed with a pre-consumed request body", async () => {
    const init = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(init.result.serverInfo).toBeTruthy();
    const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
    expect(new Set(names).size).toBe(names.length);
  }, 15000);

  it("OpenAPI tools build the exact requests", async () => {
    const get = await call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: TOOL_CALLS.hyphenPath,
    });
    expect(get.result.content[0].text).toContain("Status: 200");
    const post = await call({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: TOOL_CALLS.body,
    });
    expect(post.result.content[0].text).toContain("Status: 200");
    expectEchoed();
    expect((globalThis as any).__INJECTED).toBeUndefined();
  }, 15000);
});

describe("built-in tool names are reserved by origin, not by presence", () => {
  const business = {
    name: "Shop",
    type: "Restaurant",
    url: "https://example.com",
    hours: [{ days: ["Mon"], opens: "09:00", closes: "17:00" }],
    source: "json-ld" as const,
  };
  const lb: LocalBusinessArtifacts = { business };
  const artifacts: EcommerceArtifacts = {
    products: [
      {
        productId: "p1",
        name: "Widget",
        url: "https://example.com/w",
        price: 5,
        source: "json-ld",
      },
    ],
  };
  const op = (operationId: string, path: string, summary: string, method = "get") => ({
    path,
    method,
    operationId,
    summary,
    parameters: [],
  });
  const ctx = (): GenerateContext => ({
    pages: [{ url: "https://example.com/", title: "Shop", description: "", markdown: "hi" }],
    rawPages: [],
    metadata: {
      baseUrl: "https://example.com",
      wellKnown: {},
      openapi: {
        specUrl: `${API_HOST}/openapi.json`,
        version: "3.0.0",
        serverUrl: `${API_HOST}/v1`,
        endpoints: [
          op("getMenu", "/menu", "Api menu"),
          op("getServices", "/services", "Api services"),
          op("bookAppointment", "/book", "Api book", "post"),
          op("getProduct", "/orders", "Create order", "post"),
        ],
      },
    },
    baseUrl: "https://example.com",
    allowedOffOriginHosts: ["api.example.net"],
  });
  let h: ExpressHandle;
  let serverNames: string[] = [];

  beforeAll(async () => {
    h = await startExpress("builtins", ctx(), artifacts, lb);
    const list = await h.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    serverNames = list.result.tools.map((t: { name: string }) => t.name);
  }, 40000);

  it("boots and keeps built-in handlers separate from same-named OpenAPI tools", async () => {
    expect(new Set(serverNames).size).toBe(serverNames.length);
    expect(serverNames).toEqual(
      expect.arrayContaining([
        "get-hours",
        "get-product",
        "get-menu-2",
        "get-services-2",
        "book-appointment-2",
        "get-product-2",
      ]),
    );
    expect(serverNames).not.toContain("get-menu");
    const lookup = await h.rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get-product", arguments: { productId: "p1" } },
    });
    expect(lookup.result.content[0].text).toContain("Widget");
  });

  it("SKILL.md generators list exactly the tools the server registers", () => {
    const skillNames = (md: string) => [...md.matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]);
    const opts = { artifacts, localBusinessArtifacts: lb };
    const a = skillNames(generateSkillMd(ctx(), opts));
    expect(a.slice().sort()).toEqual(serverNames.slice().sort());
    const b = skillNames(generateOpenClawSkillMd(ctx(), opts));
    expect(b.slice().sort()).toEqual(serverNames.slice().sort());
    const detected = detectTools(ctx(), artifacts, lb).tools.map((t) => t.name);
    expect(detected.slice().sort()).toEqual(serverNames.slice().sort());
  });
});

describe("OpenAPI server URL is resolved and validated before it reaches generated code", () => {
  const spec = (url: string) => ({
    openapi: "3.0.0",
    servers: [{ url }],
    paths: { "/ping": { get: { operationId: "ping" } } },
  });
  const bypasses = [" http://169.254.169.254", "http:\\\\169.254.169.254", "http:169.254.169.254"];

  it.each(bypasses)("rejects %j at parse time and at generation time", (raw) => {
    expect(
      parseOpenAPISpec(spec(raw), "https://site.example/openapi.json", {
        baseUrl: "https://site.example",
      }),
    ).toBeNull();
    const ctx: GenerateContext = {
      pages: [{ url: "https://site.example/", title: "S", description: "", markdown: "m" }],
      rawPages: [],
      metadata: {
        baseUrl: "https://site.example",
        wellKnown: {},
        openapi: {
          specUrl: "https://site.example/openapi.json",
          version: "3.0.0",
          serverUrl: raw,
          endpoints: [{ path: "/ping", method: "get", operationId: "ping", parameters: [] }],
        },
      },
      baseUrl: "https://site.example",
    };
    expect(detectTools(ctx).hasOpenapi).toBe(false);
    for (const variant of [undefined, "cf", "vercel"] as const) {
      for (const f of generateMcpServer(ctx, variant)) {
        if (/\.(ts|json)$/.test(f.filename) && !f.filename.endsWith("openapi.json")) {
          expect(f.content).not.toContain("169.254.169.254");
        }
      }
    }
  });

  it("a relative server URL resolves against the site origin in the executed Worker", async () => {
    const ctx: GenerateContext = {
      pages: [{ url: "https://site.example/", title: "S", description: "", markdown: "m" }],
      rawPages: [],
      metadata: {
        baseUrl: "https://site.example",
        wellKnown: {},
        openapi: {
          specUrl: "https://site.example/openapi.json",
          version: "3.0.0",
          serverUrl: "/v2",
          endpoints: [{ path: "/ping", method: "get", operationId: "ping", parameters: [] }],
        },
      },
      baseUrl: "https://site.example",
    };
    const { call } = await loadWorker("relative", ctx);
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      urls.push(typeof input === "string" ? input : input.url);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const res = await call({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ping", arguments: {} },
      });
      expect(res.result.content[0].text).toContain("Status: 200");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls).toEqual(["https://site.example/v2/ping"]);
  });
});

describe("hostile crawl data: README and package.json", () => {
  it("keeps the README heading and tool bullets on one line and package name safe", () => {
    for (const variant of [undefined, "cf", "vercel"] as const) {
      const files = generateMcpServer(buildCtx(), variant);
      const readme = files.find((f) => f.filename.endsWith("README.md"))?.content ?? "";
      const lines = readme.split("\n");
      expect(lines[0]).toMatch(/^# .* Agent Server$/);
      expect(lines.filter((l) => l.startsWith("#") && !l.startsWith("##"))).toHaveLength(1);
      const bullets = lines.filter((l) => l.startsWith("- **"));
      expect(bullets.length).toBeGreaterThanOrEqual(EXPECTED_TOOLS.length);
      expect(readme).not.toMatch(/^```.*\$\{/m);
      const pkg = JSON.parse(files.find((f) => f.filename.endsWith("package.json"))?.content ?? "");
      expect(pkg.name).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
