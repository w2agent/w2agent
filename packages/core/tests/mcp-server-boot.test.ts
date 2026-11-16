import { type ChildProcess, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateMcpServer } from "../src/generate/mcp-server.js";
import type { GenerateContext } from "../src/generate/types.js";
import {
  CORE_DIR,
  freePort,
  killTracked,
  spawnServer,
  waitForRunning,
} from "./helpers/mcp-harness.js";

const PAGE_URL = "https://example.com/about";

const HOLD_URL = "https://hold.example.net/hold";

function buildCtx(): GenerateContext {
  return {
    pages: [
      {
        url: "https://example.com/",
        title: "Home",
        description: "Welcome",
        markdown: "Welcome home",
      },
      { url: PAGE_URL, title: "About", description: "About us", markdown: "We sell widgets" },
      {
        url: "https://example.com/hold",
        title: "Hold",
        description: "",
        markdown: "Hold page",
        forms: [
          {
            action: HOLD_URL,
            method: "POST",
            fields: [{ name: "email", type: "email", required: true }],
          },
        ],
      },
    ],
    rawPages: [],
    metadata: { baseUrl: "https://example.com", wellKnown: {} },
    baseUrl: "https://example.com",
    allowedOffOriginHosts: ["hold.example.net"],
  };
}

let tmpRoot = "";
let serverDir = "";
let child: ChildProcess | null = null;
let baseUrl = "";
let getOutput: () => string = () => "";
let holdServer: HttpServer | null = null;
let holdHits = 0;
const heldResponses: ServerResponse[] = [];

function parseBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = trimmed.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`Unparseable response: ${text}`);
  return JSON.parse(dataLine.slice(5).trim());
}

async function rpc(body: unknown, init: { raw?: string } = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: init.raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? safeParse(text) : null };
}

function safeParse(text: string): any {
  try {
    return parseBody(text);
  } catch {
    return null;
  }
}

function alive(): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null;
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(CORE_DIR, ".tmp-mcp-boot-"));
  holdServer = createHttpServer((_req, res) => {
    holdHits++;
    heldResponses.push(res);
  });
  await new Promise<void>((res) => holdServer?.listen(0, "127.0.0.1", () => res()));
  const holdPort = (holdServer.address() as { port: number }).port;
  const files = generateMcpServer(buildCtx());
  for (const f of files) {
    const target = join(tmpRoot, f.filename);
    mkdirSync(dirname(target), { recursive: true });
    // The SSRF policy rejects loopback form targets, so point the public placeholder at the local listener.
    const content = f.content.replaceAll(HOLD_URL, `http://127.0.0.1:${holdPort}/hold`);
    writeFileSync(target, content);
  }
  serverDir = join(tmpRoot, "mcp-server");

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const started = spawnServer(serverDir, port);
  child = started.proc;
  getOutput = started.output;
  await waitForRunning(child, getOutput);
}, 30000);

afterAll(() => {
  for (const r of heldResponses) r.destroy();
  holdServer?.close();
  killTracked();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "boot-test", version: "1.0.0" },
  },
};

describe("generated standalone MCP server (boot and drive)", () => {
  it("type-checks with the generated tsconfig", () => {
    execFileSync(
      join(CORE_DIR, "node_modules/.bin/tsc"),
      ["--noEmit", "-p", join(serverDir, "tsconfig.json")],
      { stdio: "pipe" },
    );
  }, 60000);

  it("initialize succeeds and notifications/initialized is accepted", async () => {
    const init = await rpc(initializeBody);
    expect(init.status).toBe(200);
    expect(init.json?.result?.serverInfo?.name).toBeTruthy();

    const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
  });

  it("tools/list returns the expected tools and tools/call returns content", async () => {
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list-pages", "get-page", "search-site"]));

    const call = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get-page", arguments: { url: "about" } },
    });
    expect(call.json?.result?.content?.[0]?.text).toContain("We sell widgets");
  });

  it("resources/list includes a page URL and resources/read returns markdown", async () => {
    const list = await rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    const uris = (list.json?.result?.resources ?? []).map((r: { uri: string }) => r.uri);
    expect(uris).toContain(PAGE_URL);

    const read = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "resources/read",
      params: { uri: PAGE_URL },
    });
    expect(read.json?.result?.contents?.[0]?.text).toBe("We sell widgets");
  });

  it("survives two requests concurrently in flight on the server", async () => {
    const start = holdHits;
    const call = (id: number) =>
      rpc({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "submit-hold", arguments: { email: "a@example.com" } },
      });
    const both = Promise.all([call(10), call(10)]);
    const deadline = Date.now() + 5000;
    while (holdHits - start < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(holdHits - start).toBe(2);
    expect(alive()).toBe(true);
    for (const r of heldResponses.splice(0)) r.end("ok");
    const results = await both;
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.json?.result?.content?.[0]?.text).toContain("Status: 200");
    }
    const after = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/list" });
    expect(after.status).toBe(200);
  });

  it("serves requests while another request is held open", async () => {
    const holdStart = holdHits;
    const held = rpc({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "submit-hold", arguments: { email: "a@example.com" } },
    });
    const deadline = Date.now() + 5000;
    while (holdHits === holdStart && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(holdHits).toBeGreaterThan(holdStart);

    const during = await Promise.all([
      rpc({ jsonrpc: "2.0", id: 21, method: "tools/list" }),
      rpc({ jsonrpc: "2.0", id: 21, method: "tools/list" }),
      rpc({
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "list-pages", arguments: {} },
      }),
    ]);
    for (const r of during) expect(r.status).toBe(200);
    expect(alive()).toBe(true);

    for (const r of heldResponses.splice(0)) r.end("ok");
    const done = await held;
    expect(done.status).toBe(200);
    expect(done.json?.result?.content?.[0]?.text).toContain("Status: 200");
    expect(alive()).toBe(true);
  });

  it("returns 405 for GET and DELETE on /mcp", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${baseUrl}/mcp`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      const body = parseBody(await res.text());
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error).toBeTruthy();
    }
    expect(alive()).toBe(true);
  });

  it("returns 400 with -32700 for malformed JSON and stays alive", async () => {
    const res = await rpc(null, { raw: '{"jsonrpc": "2.0", "id": 1,' });
    expect(res.status).toBe(400);
    expect(res.json?.error?.code).toBe(-32700);
    expect(res.text).not.toContain("<html");
    expect(alive()).toBe(true);
    const after = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(after.status).toBe(200);
  });

  it("maps body-parser client errors to their 4xx status with a JSON-RPC body", async () => {
    const big = await rpc(null, { raw: JSON.stringify({ pad: "x".repeat(200_000) }) });
    expect(big.status).toBe(413);
    expect(big.json?.error?.code).toBe(-32600);

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=latin1",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initializeBody),
    });
    expect(res.status).toBe(415);
    expect(parseBody(await res.text()).error.code).toBe(-32600);
    expect(getOutput()).not.toContain("UnsupportedMediaTypeError");
    expect(alive()).toBe(true);
  });

  it("exits at startup when the data set cannot be registered", async () => {
    const dupDir = join(tmpRoot, "dup-server");
    cpSync(serverDir, dupDir, { recursive: true });
    const pagesPath = join(dupDir, "data/pages.json");
    const data = JSON.parse(readFileSync(pagesPath, "utf-8"));
    writeFileSync(pagesPath, JSON.stringify([...data, data[0]]));
    const port = await freePort();
    const { proc, output: dupOutput } = spawnServer(dupDir, port);
    const code = await new Promise<number | null>((res) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        res(null);
      }, 20000);
      proc.once("exit", (c) => {
        clearTimeout(timer);
        res(c);
      });
    });
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(dupOutput()).not.toContain("running at");
    expect(dupOutput()).toContain("already registered");
  }, 30000);

  it("keeps the /.well-known/mcp redirect", async () => {
    const res = await fetch(`${baseUrl}/.well-known/mcp`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/mcp");
  });
});
