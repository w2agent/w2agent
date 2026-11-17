import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { shopifyAdapter } from "../src/adapters/shopify/index.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";

const SECRET = "test-client-secret-0123456789";
const TOKEN = "w2a_test-token-abcdef";
const RELAY_PATH = "/webhooks/shopify";

// Topics copied from https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic
const DOC_TOPICS = [
  "products/create",
  "products/update",
  "products/delete",
  "collections/create",
  "collections/update",
  "collections/delete",
];
const NOT_TOPICS = ["pages/create", "pages/update", "pages/delete"];

function notes(): string {
  const ctx: GenerateContext = {
    pages: [],
    rawPages: [],
    metadata: {} as unknown as GenerateContext["metadata"],
    baseUrl: "https://shop.example",
  };
  const core: GeneratedFile[] = [
    { filename: "llms.txt", content: "# Shop\n", size: 7 },
    { filename: "mcp-server/server.ts", content: "// server", size: 9 },
  ];
  const f = shopifyAdapter
    .generateIntegration(ctx, core)
    .find((x) => x.filename === "shopify/W2AGENT-MCP-WEBHOOK.md");
  if (!f) throw new Error("webhook notes not emitted");
  return f.content;
}

function jsBlocks(md: string): string[] {
  return [...md.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
}

function sign(body: Buffer | string, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

interface Recorded {
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe("emitted Shopify webhook notes", () => {
  const md = notes();

  it("says the relay must be reachable over HTTPS, not that it serves HTTPS itself", () => {
    expect(md).toContain("reachable over HTTPS");
    expect(md).not.toContain("in front of HTTPS");
  });

  it("names only topics from the WebhookSubscriptionTopic doc and no stale advice", () => {
    const named = new Set<string>();
    for (const m of md.matchAll(/\b(?:products|collections|pages|articles|blogs)\/[a-z_]+/g)) {
      named.add(m[0]);
    }
    expect([...named].sort()).toEqual([...DOC_TOPICS].sort());
    const toml = md.match(/```toml\n([\s\S]*?)```/)?.[1] ?? "";
    const tomlTopics = [...toml.matchAll(/"([a-z]+\/[a-z]+)"/g)]
      .map((m) => m[1])
      .filter((t) => !t.startsWith("https"));
    expect(tomlTopics.sort()).toEqual([...DOC_TOPICS].sort());
    expect(toml).toContain('api_version = "2026-10"');
    expect(toml).toContain("[[webhooks.subscriptions]]");
    for (const t of NOT_TOPICS) expect(md).not.toContain(t);
    expect(md).not.toContain("pages/");
    expect(md).not.toContain("webhook register");
    expect(md).not.toContain("2024-01");
  });

  it("has exactly one js block and does not tell Shopify to call the hosted endpoint", () => {
    expect(jsBlocks(md)).toHaveLength(1);
    expect(md).toContain("shopify app webhook trigger");
    expect(md).toContain("--client-secret");
    expect(md).toContain("w2agent agent update YOUR_SLUG");
    expect(md).toContain("Do not subscribe Shopify webhooks straight to");
    expect(md).not.toMatch(/uri = "https:\/\/w2agent\.dev/);
  });
});

describe("emitted Shopify webhook relay (child process)", () => {
  let dir: string;
  let fake: http.Server;
  let fakeUrl: string;
  let fakeStatus = 200;
  let fakeLocation: string | undefined;
  let redirectTarget: http.Server;
  let redirectHits: http.IncomingHttpHeaders[] = [];
  let received: Recorded[] = [];
  let child: ChildProcess | undefined;
  let relayPort = 0;
  let relayFile: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "w2agent-relay-"));
    relayFile = path.join(dir, "w2agent-relay.cjs");
    fs.writeFileSync(relayFile, jsBlocks(notes())[0]);
    fake = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(fakeStatus, fakeLocation ? { Location: fakeLocation } : {});
        res.end("{}");
      });
    });
    redirectTarget = http.createServer((req, res) => {
      redirectHits.push(req.headers);
      req.resume();
      res.writeHead(200);
      res.end("{}");
    });
    await new Promise<void>((r) => redirectTarget.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    fakeUrl = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}/api/agent/webhook/slug`;
  });

  afterEach(async () => {
    if (child?.pid && child.exitCode === null) {
      const exited = new Promise((r) => child?.once("exit", r));
      process.kill(child.pid);
      await exited;
    }
    child = undefined;
    received = [];
    redirectHits = [];
    fakeStatus = 200;
    fakeLocation = undefined;
  });

  afterAll(async () => {
    await new Promise((r) => fake.close(r));
    await new Promise((r) => redirectTarget.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(env: Record<string, string | undefined> = {}): Promise<void> {
    relayPort = await freePort();
    const full: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      PORT: String(relayPort),
      SHOPIFY_CLIENT_SECRET: SECRET,
      W2AGENT_WEBHOOK_URL: fakeUrl,
      W2AGENT_WEBHOOK_TOKEN: TOKEN,
      ...env,
    };
    for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
    child = spawn(process.execPath, [relayFile], { env: full as NodeJS.ProcessEnv });
    const c = child;
    await new Promise<void>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("relay did not start")), 5000);
      c.stdout?.on("data", (d) => {
        out += d;
        if (out.includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      c.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("relay exited early"));
      });
    });
  }

  function call(opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  }): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: relayPort,
          method: opts.method ?? "POST",
          path: opts.path ?? RELAY_PATH,
          headers: opts.headers,
          agent: false,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(opts.body);
    });
  }

  const signed = (topic: string, body = '{"id":1}') => ({
    method: "POST",
    body,
    headers: { "X-Shopify-Hmac-SHA256": sign(body), "X-Shopify-Topic": topic },
  });

  async function stillAlive(): Promise<void> {
    expect(child?.exitCode).toBeNull();
    expect(await call(signed("products/update"))).toBe(200);
  }

  it("forwards a valid products/update once with the Bearer token and a JSON body", async () => {
    await start();
    expect(await call(signed("products/update"))).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(received[0].headers["content-type"]).toContain("application/json");
    expect(JSON.parse(received[0].body)).toEqual({ trigger: "shopify", topic: "products/update" });
  });

  it("forwards every allowlisted topic", async () => {
    await start();
    for (const t of DOC_TOPICS) expect(await call(signed(t))).toBe(200);
    expect(received.map((r) => JSON.parse(r.body).topic)).toEqual(DOC_TOPICS);
  });

  it("verifies against the raw bytes, not a re-serialized body", async () => {
    await start();
    expect(await call(signed("products/update", '{ "a" :  1,\n"b":"é" }'))).toBe(200);
    expect(received).toHaveLength(1);
  });

  const body = '{"id":1}';
  const badSignatures: Array<[string, Record<string, string>]> = [
    ["wrong signature", { "X-Shopify-Hmac-SHA256": sign(body, "other-secret") }],
    ["missing header", {}],
    ["empty header", { "X-Shopify-Hmac-SHA256": "" }],
    ["44 chars decoding to 33 bytes", { "X-Shopify-Hmac-SHA256": "A".repeat(44) }],
    ["only padding", { "X-Shopify-Hmac-SHA256": "====" }],
    ["too short", { "X-Shopify-Hmac-SHA256": sign(body).slice(0, 20) }],
    ["unpadded 43 chars", { "X-Shopify-Hmac-SHA256": sign(body).slice(0, 43) }],
    ["url-safe alphabet", { "X-Shopify-Hmac-SHA256": `${"-".repeat(43)}=` }],
    ["valid digest plus a trailing char", { "X-Shopify-Hmac-SHA256": `${sign(body)}A` }],
  ];
  for (const [name, headers] of badSignatures) {
    it(`answers 401, forwards nothing and stays up: ${name}`, async () => {
      await start();
      const status = await call({
        method: "POST",
        body,
        headers: { ...headers, "X-Shopify-Topic": "products/update" },
      });
      expect(status).toBe(401);
      expect(received).toHaveLength(0);
      await stillAlive();
      expect(received).toHaveLength(1);
    });
  }

  it("answers 401 when the body is changed after signing", async () => {
    await start();
    const status = await call({
      method: "POST",
      body: '{"id":2}',
      headers: { "X-Shopify-Hmac-SHA256": sign(body), "X-Shopify-Topic": "products/update" },
    });
    expect(status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("answers 200 and forwards nothing for a signed topic outside the allowlist", async () => {
    await start();
    expect(await call(signed("orders/create"))).toBe(200);
    expect(await call(signed("pages/update"))).toBe(200);
    expect(received).toHaveLength(0);
  });

  it("answers 401 (not 200) for an unsigned request with a non-allowlisted topic", async () => {
    await start();
    expect(
      await call({ method: "POST", body, headers: { "X-Shopify-Topic": "orders/create" } }),
    ).toBe(401);
  });

  it("answers 405 for GET and 404 for another path", async () => {
    await start();
    expect(await call({ method: "GET" })).toBe(405);
    expect(await call({ method: "POST", path: "/other", ...signed("products/update") })).toBe(404);
    expect(received).toHaveLength(0);
  });

  it("answers 413 for a body over the cap and forwards nothing", async () => {
    await start();
    const big = Buffer.alloc(1024 * 1024 + 10, 97);
    let status = 0;
    try {
      status = await call({
        method: "POST",
        body: big,
        headers: { "X-Shopify-Hmac-SHA256": sign(big), "X-Shopify-Topic": "products/update" },
      });
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toMatch(/ECONNRESET|EPIPE/);
    }
    if (status) expect(status).toBe(413);
    expect(received).toHaveLength(0);
    await stillAlive();
  });

  it("survives a client that aborts mid-body", async () => {
    await start();
    await new Promise<void>((resolve) => {
      const s = net.connect(relayPort, "127.0.0.1", () => {
        s.write(
          `POST ${RELAY_PATH} HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\nX-Shopify-Topic: products/update\r\n\r\nabc`,
        );
        setTimeout(() => {
          s.destroy();
          resolve();
        }, 50);
      });
    });
    expect(received).toHaveLength(0);
    await stillAlive();
  });

  it("answers 503 when the w2agent endpoint fails, so Shopify retries", async () => {
    await start();
    fakeStatus = 500;
    expect(await call(signed("products/update"))).toBe(503);
    expect(received).toHaveLength(1);
  });

  it("does not follow redirects from the w2agent endpoint", async () => {
    await start();
    fakeStatus = 302;
    fakeLocation = `http://127.0.0.1:${(redirectTarget.address() as net.AddressInfo).port}/leak`;
    expect(await call(signed("products/update"))).toBe(503);
    expect(received).toHaveLength(1);
    expect(redirectHits).toHaveLength(0);
  });

  it("answers 503 when the w2agent endpoint is unreachable", async () => {
    await start({ W2AGENT_WEBHOOK_URL: `http://127.0.0.1:${await freePort()}/x` });
    expect(await call(signed("products/update"))).toBe(503);
  });

  async function exitOf(env: Record<string, string | undefined>) {
    const full: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      PORT: String(await freePort()),
      SHOPIFY_CLIENT_SECRET: SECRET,
      W2AGENT_WEBHOOK_URL: fakeUrl,
      W2AGENT_WEBHOOK_TOKEN: TOKEN,
      ...env,
    };
    for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
    child = spawn(process.execPath, [relayFile], { env: full as NodeJS.ProcessEnv });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d;
    });
    child.stderr?.on("data", (d) => {
      out += d;
    });
    const code = await new Promise<number | null>((r) => child?.once("exit", r));
    return { code, out };
  }

  for (const name of ["SHOPIFY_CLIENT_SECRET", "W2AGENT_WEBHOOK_URL", "W2AGENT_WEBHOOK_TOKEN"]) {
    it(`exits non-zero with a message when ${name} is missing`, async () => {
      const { code, out } = await exitOf({ [name]: undefined });
      expect(code).not.toBe(0);
      expect(out).toContain(name);
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(TOKEN);
    });
  }

  it("refuses a plain-http URL on a non-loopback host", async () => {
    const { code, out } = await exitOf({ W2AGENT_WEBHOOK_URL: "http://example.com/hook" });
    expect(code).not.toBe(0);
    expect(out).toContain("https");
    expect(out).not.toContain(TOKEN);
  });

  it("never logs the token or secret while handling requests", async () => {
    await start();
    let out = "";
    child?.stdout?.on("data", (d) => {
      out += d;
    });
    child?.stderr?.on("data", (d) => {
      out += d;
    });
    await call(signed("products/update"));
    fakeStatus = 500;
    await call(signed("products/update"));
    await call({ method: "POST", body, headers: {} });
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(TOKEN);
  });
});
