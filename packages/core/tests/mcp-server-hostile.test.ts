import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
} from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateMcpServer } from "../src/generate/mcp-server.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";

const CORE_DIR = resolve(__dirname, "..");

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
            parameters: [],
          },
        ],
      },
    },
    baseUrl: "https://example.com",
    allowedOffOriginHosts: ["forms.example.net"],
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
];

let tmpRoot = "";
let echoServer: HttpServer | null = null;
let echoPort = 0;
const echoHits: Array<{ method: string; url: string; body: string }> = [];

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => res(port));
    });
  });
}

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
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
    fileName: file,
  });
  writeFileSync(file.replace(/\.ts$/, ".mjs"), out.outputText);
}

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

function expectEchoed() {
  const get = echoHits.find((h) => h.method === "GET" && h.url.includes("/v1/users/42/items"));
  expect(get).toBeTruthy();
  expect(get?.url).toContain("page-size=7");
  expect(get?.url).toContain("api-key=k1");
  const post = echoHits.find((h) => h.method === "POST" && h.url === "/v1/things");
  expect(post).toBeTruthy();
  expect(JSON.parse(post?.body ?? "{}")["body-field"]).toBe("bf");
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

afterAll(() => {
  echoServer?.close();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("hostile crawl data: Express server", () => {
  let dir = "";
  let child: ChildProcess | null = null;
  let output = "";
  let baseUrl = "";

  async function rpc(body: unknown) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    return parseBody(await res.text());
  }

  beforeAll(async () => {
    const root = join(tmpRoot, "express");
    writeFiles(generateMcpServer(buildCtx()), root);
    dir = join(root, "mcp-server");
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(join(CORE_DIR, "node_modules/.bin/tsx"), ["server.ts"], {
      cwd: dir,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const proc = child;
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`server did not start:\n${output}`)), 20000);
      const onData = (d: Buffer) => {
        output += d.toString();
        if (output.includes("running at")) {
          clearTimeout(timer);
          res();
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", (d: Buffer) => {
        output += d.toString();
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        rej(new Error(`server exited early (${code}):\n${output}`));
      });
    });
  }, 40000);

  afterAll(() => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  });

  it("type-checks", () => {
    execFileSync(
      join(CORE_DIR, "node_modules/.bin/tsc"),
      ["--noEmit", "-p", join(dir, "tsconfig.json")],
      {
        stdio: "pipe",
      },
    );
  }, 60000);

  it("boots without executing crawled text and lists deduped tools", async () => {
    expect(output).not.toContain(MARKER);
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
    expect(new Set(names).size).toBe(names.length);
    expect(output).not.toContain(MARKER);
  });

  it("OpenAPI tools with hyphenated and hostile param names build requests", async () => {
    const before = echoHits.length;
    const get = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: TOOL_CALLS.hyphenPath,
    });
    expect(get.result.content[0].text).toContain("Status: 200");
    const post = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: TOOL_CALLS.body,
    });
    expect(post.result.content[0].text).toContain("Status: 200");
    expect(echoHits.length).toBeGreaterThanOrEqual(before + 2);
    expectEchoed();
    expect(output).not.toContain(MARKER);
  });
});

describe("hostile crawl data: Cloudflare worker", () => {
  let worker: { fetch: (req: Request, env: unknown) => Promise<Response> };
  let env: unknown;

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

  beforeAll(async () => {
    const root = join(tmpRoot, "cf");
    writeFiles(generateMcpServer(buildCtx(), "cf"), root);
    const dir = join(root, "mcp-server");
    transpile(join(dir, "worker.ts"));
    const data: Record<string, string> = {};
    for (const k of ["pages", "faq", "products", "business"]) {
      const p = join(dir, "data", `${k}.json`);
      if (existsSync(p)) data[k] = readFileSync(p, "utf-8");
    }
    env = { MCP_DATA: { get: async (k: string) => data[k] ?? null } };
    worker = (await import(/* @vite-ignore */ pathToFileURL(join(dir, "worker.mjs")).href)).default;
  });

  it("tools/list succeeds and dedupes OpenAPI names against built-in and form tools", async () => {
    const list = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
    expect(new Set(names).size).toBe(names.length);
    const info = await worker.fetch(new Request("http://127.0.0.1/mcp"), env);
    const advertised: string[] = JSON.parse(await info.text()).tools;
    expect(advertised).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
    expect(new Set(advertised).size).toBe(advertised.length);
    expect((globalThis as any).__INJECTED).toBeUndefined();
  });

  it("OpenAPI tools with hyphenated and hostile param names build requests", async () => {
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

describe("hostile crawl data: Vercel handler", () => {
  let server: HttpServer;
  let url = "";

  const call = async (body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    return parseBody(await res.text());
  };

  beforeAll(async () => {
    const root = join(tmpRoot, "vercel");
    writeFiles(generateMcpServer(buildCtx(), "vercel"), root);
    const dir = join(root, "mcp-server");
    transpile(join(dir, "api/mcp.ts"));
    const mod = await import(/* @vite-ignore */ pathToFileURL(join(dir, "api/mcp.mjs")).href);
    server = createHttpServer((req, res) => {
      mod.default(req, res).catch((e: unknown) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  });

  afterAll(() => {
    server?.close();
  });

  it("tools/list succeeds, dedupes names, and OpenAPI hyphen params work", async () => {
    const list = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
    expect(new Set(names).size).toBe(names.length);
    const get = await call({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: TOOL_CALLS.hyphenPath,
    });
    expect(get.result.content[0].text).toContain("Status: 200");
    expect((globalThis as any).__INJECTED).toBeUndefined();
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
