import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { generateMcpServer } from "../../src/generate/mcp-server.js";
import type { GenerateContext } from "../../src/generate/types.js";
import { freePort, spawnServer, waitForRunning } from "./mcp-harness.js";

export type Variant = "express" | "cf" | "vercel";
export const VARIANTS: Variant[] = ["express", "cf", "vercel"];

export type Rpc = (body: unknown) => Promise<any>;

export interface Booted {
  rpc: Rpc;
  dir: string;
  close: () => void;
}

function parseBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = trimmed.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`Unparseable response: ${text}`);
  return JSON.parse(dataLine.slice(5).trim());
}

function transpile(file: string): void {
  const out = ts.transpileModule(readFileSync(file, "utf-8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: file,
  });
  writeFileSync(file.replace(/\.ts$/, ".mjs"), out.outputText);
}

async function readBody(req: AsyncIterable<Buffer | string>): Promise<string> {
  let data = "";
  for await (const c of req) data += c;
  return data;
}

// Generate one variant into root, point crawled hosts at loopback fixtures, and serve it.
export async function bootGenerated(
  variant: Variant,
  ctx: GenerateContext,
  root: string,
  hostMap: Array<[string, string]>,
): Promise<Booted> {
  const files = generateMcpServer(ctx, variant === "express" ? undefined : variant);
  for (const f of files) {
    const target = join(root, f.filename);
    mkdirSync(dirname(target), { recursive: true });
    let content = f.content;
    for (const [from, to] of hostMap) content = content.replaceAll(from, to);
    writeFileSync(target, content);
  }
  const dir = join(root, "mcp-server");
  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, {
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

  if (variant === "express") {
    const port = await freePort();
    const { proc, output } = spawnServer(dir, port);
    await waitForRunning(proc, output);
    return {
      rpc: (body) => post(`http://127.0.0.1:${port}/mcp`, body),
      dir,
      close: () => killProc(proc),
    };
  }

  if (variant === "cf") {
    transpile(join(dir, "worker.ts"));
    const data: Record<string, string> = {};
    for (const k of ["pages", "faq", "products", "business"]) {
      const p = join(dir, "data", `${k}.json`);
      if (existsSync(p)) data[k] = readFileSync(p, "utf-8");
    }
    const env = { MCP_DATA: { get: async (k: string) => data[k] ?? null } };
    const worker = (await import(/* @vite-ignore */ pathToFileURL(join(dir, "worker.mjs")).href))
      .default as { fetch: (req: Request, env: unknown) => Promise<Response> };
    return {
      rpc: async (body) => {
        const res = await worker.fetch(
          new Request("http://127.0.0.1/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
          env,
        );
        return JSON.parse(await res.text());
      },
      dir,
      close: () => {},
    };
  }

  transpile(join(dir, "api/mcp.ts"));
  const mod = await import(/* @vite-ignore */ pathToFileURL(join(dir, "api/mcp.mjs")).href);
  const srv = createHttpServer(async (req, res) => {
    try {
      const raw = await readBody(req);
      (req as any).body = raw ? JSON.parse(raw) : undefined;
      await mod.default(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
  return {
    rpc: (body) => post(url, body),
    dir,
    close: () => {
      srv.close();
      srv.closeAllConnections();
    },
  };
}

function killProc(proc: ChildProcess) {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
}

let nextId = 1000;

export async function listTools(rpc: Rpc): Promise<any[]> {
  const res = await rpc({ jsonrpc: "2.0", id: nextId++, method: "tools/list" });
  return res.result.tools;
}

export async function callTool(rpc: Rpc, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return {
    text: (res.result?.content?.[0]?.text ?? "") as string,
    isError: Boolean(res.result?.isError),
    error: res.error as { message: string } | undefined,
  };
}
