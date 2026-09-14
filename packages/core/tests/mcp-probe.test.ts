import { afterEach, describe, expect, it, vi } from "vitest";
import { allChecks } from "../src/audit/checks/index.js";
import { mcpDiscovery } from "../src/audit/checks/protocols.js";
import { probeSiteMetadata } from "../src/audit/crawler.js";
import { runAudit } from "../src/audit/engine.js";
import {
  buildMcpCandidates,
  MCP_CANDIDATE_CAP,
  probeMcpEndpoint,
} from "../src/audit/shared/mcp-probe.js";
import type { AuditOptions, AuditReport, CheckResult, SiteMetadata } from "../src/audit/types.js";
import { DEFAULT_OPTIONS } from "../src/audit/types.js";

type Call = { url: string; method: string; headers: Headers; body?: string };
type Route = (url: URL, call: Call, init?: RequestInit) => Response | Promise<Response>;

const OPTIONS: Partial<AuditOptions> = { maxPages: 1, requestDelay: 0, timeout: 1000 };
const metaOptions = { ...DEFAULT_OPTIONS, ...OPTIONS };
const SPA_SHELL = '<!doctype html><html><body><div id="root"></div></body></html>';

let calls: Call[] = [];

function mockSite(route: Route) {
  calls = [];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return route(new URL(url), call, init);
  });
}

const rpcMethod = (call: Call) => (call.body ? JSON.parse(call.body).method : undefined);
const posts = (url: string) => calls.filter((c) => c.url === url && c.method === "POST");

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
/** An SSE response whose stream never closes: reading it to the end would hang. */
function openSse(text: string, status = 200) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

function checksById(report: AuditReport): Map<string, CheckResult> {
  return new Map(report.categories.flatMap((c) => c.checks).map((r) => [r.id, r]));
}

const DISCOVER_RESULT = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: {} },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-mcp", version: "2.0.0" } },
  },
};
const INIT_RESULT = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    serverInfo: { name: "legacy-mcp", version: "1.0.0" },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MCP discovery against observed real-world and catch-all sites", () => {
  it("Stripe: stripe.com/mcp 404 html, mcp.stripe.com/mcp 404 JSON, mcp.stripe.com/ 401 Bearer → auth-gated endpoint, pass 75, C1 not cascaded", async () => {
    const SITE = "https://stripe.com";
    mockSite((url, call) => {
      if (url.href === "https://mcp.stripe.com/mcp" && call.method === "POST") {
        return json(
          {
            error: {
              message:
                "Unrecognized request URL (POST: /mcp). Please see https://stripe.com/docs or we can help at https://support.stripe.com/.",
              type: "invalid_request_error",
            },
          },
          404,
        );
      }
      if (url.href === "https://mcp.stripe.com/" && call.method === "POST") {
        return json(
          { error: "Unauthorized. See https://docs.stripe.com/mcp for usage instructions." },
          401,
          {
            "www-authenticate":
              "Bearer resource_metadata=https://mcp.stripe.com/.well-known/oauth-protected-resource",
          },
        );
      }
      if (url.hostname === "stripe.com" && url.pathname === "/") return html("<html>Stripe</html>");
      return html("<html>Not found</html>", 404);
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.mcpEndpoint).toBe("https://mcp.stripe.com/");
    expect(metadata.mcpInit?.status).toBe(401);
    // The loop continued past both 404s, and a 401 stops the candidate (no initialize follow-up).
    expect(posts("https://stripe.com/mcp").length).toBeGreaterThan(0);
    expect(posts("https://mcp.stripe.com/mcp").length).toBeGreaterThan(0);
    expect(posts("https://mcp.stripe.com/").map(rpcMethod)).toEqual(["server/discover"]);
    expect(calls.some((c) => c.url.endsWith("/.well-known/mcp"))).toBe(false);

    const byId = checksById(await runAudit(SITE, OPTIONS, undefined, allChecks));
    expect(byId.get("mcp-discovery")).toMatchObject({ status: "pass", score: 75 });
    expect(byId.get("mcp-discovery")?.details).toContain("https://mcp.stripe.com/");
    expect(metadata.mcpInit?.oauthResourceMetadataUrl).toBe(
      "https://mcp.stripe.com/.well-known/oauth-protected-resource",
    );
    expect(byId.get("mcp-auth")).toMatchObject({ status: "partial", score: 50 });
  });

  it("SPA catch-all (200 text/html for every path and method) → no endpoint, fail, and mcp-auth skip", async () => {
    const SITE = "https://spa.example";
    mockSite(() => html(SPA_SHELL));

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.mcpEndpoint).toBeUndefined();
    expect(metadata.mcpInit).toBeUndefined();

    const byId = checksById(await runAudit(SITE, OPTIONS, undefined, allChecks));
    expect(byId.get("mcp-discovery")).toMatchObject({ status: "fail", score: 0 });
    for (const id of ["mcp-auth", "mcp-server-card"]) {
      expect({ id, status: byId.get(id)?.status, score: byId.get(id)?.score }).toEqual({
        id,
        status: "skip",
        score: 0,
      });
    }
  });

  it("path-echoing JSON catch-all (200 application/json {path} for every path and method) → no endpoint, fail", async () => {
    const SITE = "https://echo.example";
    mockSite((url) => json({ path: url.pathname }));

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.mcpEndpoint).toBeUndefined();
    expect(metadata.mcpInit).toBeUndefined();
    expect(mcpDiscovery.run([], metadata)).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("probeMcpEndpoint protocol handling", () => {
  const SITE = "https://example.com";
  const ENDPOINT = `${SITE}/mcp`;

  async function probeAndScore() {
    const found = await probeMcpEndpoint(SITE, "", metaOptions);
    const metadata: SiteMetadata = {
      baseUrl: SITE,
      wellKnown: {},
      mcpInit: found,
      mcpEndpoint: found?.mcpEndpointUrl,
    };
    return { found, check: await mcpDiscovery.run([], metadata) };
  }

  it("modern server: server/discover DiscoverResult → pass 100, sent with 2026-07-28 headers and no Mcp-Name", async () => {
    mockSite((url, call) =>
      url.href === ENDPOINT && call.method === "POST" ? json(DISCOVER_RESULT) : html("", 404),
    );
    const { found, check } = await probeAndScore();
    expect(found).toMatchObject({ mcpEndpointUrl: ENDPOINT, success: true });
    expect(found?.serverInfo?.name).toBe("modern-mcp");
    expect(check).toMatchObject({ status: "pass", score: 100 });

    const [discover] = posts(ENDPOINT);
    expect(rpcMethod(discover)).toBe("server/discover");
    expect(discover.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(discover.headers.get("mcp-method")).toBe("server/discover");
    expect(discover.headers.get("mcp-name")).toBeNull();
    expect(discover.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(JSON.parse(discover.body ?? "").params._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "w2agent-audit", version: "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    });
    expect(posts(ENDPOINT)).toHaveLength(1);
  });

  it("modern server answering over a text/event-stream that stays open → pass 100 without waiting for the stream to end", async () => {
    mockSite((url, call) =>
      url.href === ENDPOINT && call.method === "POST"
        ? openSse(`: keepalive\n\nevent: message\ndata: ${JSON.stringify(DISCOVER_RESULT)}\n\n`)
        : html("", 404),
    );
    const { found, check } = await probeAndScore();
    expect(found?.mcpEndpointUrl).toBe(ENDPOINT);
    expect(check).toMatchObject({ status: "pass", score: 100 });
  });

  it.each([
    [-32020, "HeaderMismatch"],
    [-32021, "MissingRequiredClientCapability"],
    [-32022, "UnsupportedProtocolVersion"],
  ])("modern server returning HTTP 400 with error %i (%s) → confirmed, pass 100, no initialize fallback", async (code, message) => {
    mockSite((url, call) =>
      url.href === ENDPOINT && call.method === "POST"
        ? json(
            {
              jsonrpc: "2.0",
              id: 1,
              error: { code, message, data: { supported: ["2027-01-01"] } },
            },
            400,
          )
        : html("", 404),
    );
    const { found, check } = await probeAndScore();
    expect(found?.mcpEndpointUrl).toBe(ENDPOINT);
    expect(check).toMatchObject({ status: "pass", score: 100 });
    expect(posts(ENDPOINT).map(rpcMethod)).toEqual(["server/discover"]);
  });

  it.each([
    [
      "400 non-modern JSON-RPC error",
      400,
      { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Server not initialized" } },
    ],
    [
      "404 -32601 method not found",
      404,
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
    ],
  ])("legacy 2025-11-25 server: discover → %s → initialize ok → pass 100, success", async (_label, status, discoverBody) => {
    mockSite((url, call) => {
      if (url.href !== ENDPOINT || call.method !== "POST") return html("", 404);
      return rpcMethod(call) === "initialize" ? json(INIT_RESULT) : json(discoverBody, status);
    });
    const { found, check } = await probeAndScore();
    expect(found).toMatchObject({ success: true, serverInfo: { name: "legacy-mcp" } });
    expect(check).toMatchObject({ status: "pass", score: 100 });

    const [, init] = posts(ENDPOINT);
    expect(rpcMethod(init)).toBe("initialize");
    expect(JSON.parse(init.body ?? "").params.protocolVersion).toBe("2025-11-25");
    // A legacy server rejects an unknown MCP-Protocol-Version header, so the fallback must not send it.
    expect(init.headers.get("mcp-protocol-version")).toBeNull();
  });

  it("initialize ignores capabilities.auth (no MCP schema defines it)", async () => {
    mockSite((url, call) => {
      if (url.href !== ENDPOINT || call.method !== "POST") return html("", 404);
      if (rpcMethod(call) !== "initialize") return json({ error: "bad" }, 400);
      return json({
        ...INIT_RESULT,
        result: { ...INIT_RESULT.result, capabilities: { auth: { type: "oauth2" } } },
      });
    });
    const found = await probeMcpEndpoint(SITE, "", metaOptions);
    expect(found?.serverInfo).toEqual({
      name: "legacy-mcp",
      version: INIT_RESULT.result.serverInfo.version,
    });
    expect(found).not.toHaveProperty("linkHeader");
  });

  it.each([
    ["Basic first", 'Basic realm="x", Bearer resource_metadata="https://example.com/prm"'],
    [
      "error param first",
      'Bearer error="invalid_token", resource_metadata="https://example.com/prm"',
    ],
    ["second Bearer challenge", "Bearer realm=a, Bearer resource_metadata=https://example.com/prm"],
  ])("a 401 whose Bearer challenge carries resource_metadata confirms the endpoint (%s)", async (_label, header) => {
    mockSite((url, call) =>
      url.href === ENDPOINT && call.method === "POST"
        ? new Response("", { status: 401, headers: { "www-authenticate": header } })
        : html("", 404),
    );
    const found = await probeMcpEndpoint(SITE, "", metaOptions);
    expect(found).toMatchObject({
      status: 401,
      oauthResourceMetadataUrl: "https://example.com/prm",
    });
  });

  it.each([
    'Basic resource_metadata="https://example.com/prm"',
    'Basic realm="x", Digest resource_metadata="https://example.com/prm"',
    'Bearer realm="x", Basic resource_metadata="https://example.com/prm"',
  ])("resource_metadata outside a Bearer challenge does not confirm an endpoint (%s)", async (header) => {
    mockSite((url, call) =>
      url.href === ENDPOINT && call.method === "POST"
        ? new Response("", { status: 401, headers: { "www-authenticate": header } })
        : html("", 404),
    );
    expect(await probeMcpEndpoint(SITE, "", metaOptions)).toBeUndefined();
  });

  it("JSON without the jsonrpc 2.0 envelope is not credited, even when it carries MCP-shaped fields", async () => {
    mockSite((_url, call) => {
      if (call.method !== "POST") return html("", 404);
      return rpcMethod(call) === "initialize"
        ? json({ id: 1, result: INIT_RESULT.result })
        : json({ id: 1, result: DISCOVER_RESULT.result });
    });
    expect(await probeMcpEndpoint(SITE, "", metaOptions)).toBeUndefined();
  });

  it("legacy HTTP+SSE: POST 405, GET text/event-stream whose first event is endpoint → partial 50", async () => {
    mockSite((url, call) => {
      if (url.href !== ENDPOINT) return html("", 404);
      if (call.method === "POST") return new Response("Method Not Allowed", { status: 405 });
      expect(call.headers.get("accept")).toBe("text/event-stream");
      return openSse("event: endpoint\ndata: /messages?sessionId=abc\n\n");
    });
    const { found, check } = await probeAndScore();
    expect(found).toMatchObject({
      mcpEndpointUrl: ENDPOINT,
      transport: "http+sse",
      success: false,
    });
    expect(check).toMatchObject({ status: "partial", score: 50 });
    expect(check.message).toMatch(/deprecated/i);
  });

  it("a GET event stream whose first event is not `endpoint` is not an MCP endpoint", async () => {
    mockSite((url, call) => {
      if (url.href !== ENDPOINT) return html("", 404);
      if (call.method === "POST") return new Response("", { status: 405 });
      return openSse("event: message\ndata: hello\n\nevent: endpoint\ndata: /x\n\n");
    });
    expect(await probeMcpEndpoint(SITE, "", metaOptions)).toBeUndefined();
  });

  it("legacy GET-only HTTP+SSE server: POST 404 on a homepage /sse link, GET text/event-stream endpoint → partial 50", async () => {
    const SSE = `${SITE}/sse`;
    mockSite((url, call) => {
      if (url.href !== SSE) return html("", 404);
      if (call.method === "POST") return html("Cannot POST /sse", 404);
      return openSse("event: endpoint\ndata: /messages?sessionId=abc\n\n");
    });
    const found = await probeMcpEndpoint(SITE, '<a href="/sse">MCP</a>', metaOptions);
    expect(found).toMatchObject({ mcpEndpointUrl: SSE, transport: "http+sse" });
    const metadata: SiteMetadata = {
      baseUrl: SITE,
      wellKnown: {},
      mcpInit: found,
      mcpEndpoint: SSE,
    };
    expect(mcpDiscovery.run([], metadata)).toMatchObject({ status: "partial", score: 50 });
  });

  it("POST 404 then a GET answering non-event-stream HTML → not found, and the HTML body is never read", async () => {
    let bodyRead = false;
    mockSite((_url, call) => {
      if (call.method === "POST") return html("", 404);
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            bodyRead = true;
            controller.enqueue(new TextEncoder().encode("<html>big page</html>"));
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 404, headers: { "content-type": "text/html" } });
    });
    expect(await probeMcpEndpoint(SITE, "", metaOptions)).toBeUndefined();
    expect(calls.some((c) => c.method === "GET")).toBe(true);
    expect(bodyRead).toBe(false);
  });

  it("legacy SSE GET whose stream opens with a data-less `retry:` block before the endpoint event → partial 50", async () => {
    mockSite((url, call) => {
      if (url.href !== ENDPOINT) return html("", 404);
      if (call.method === "POST") return new Response("", { status: 405 });
      return openSse("retry: 3000\n\nevent: endpoint\ndata: /messages?session=1\n\n");
    });
    const { found, check } = await probeAndScore();
    expect(found).toMatchObject({ mcpEndpointUrl: ENDPOINT, transport: "http+sse" });
    expect(check).toMatchObject({ status: "partial", score: 50 });
  });

  it("modern server answering over SSE with a `retry:` prelude still parses the DiscoverResult → pass 100", async () => {
    mockSite((url, call) =>
      url.href === ENDPOINT && call.method === "POST"
        ? openSse(`retry: 3000\n\nevent: message\ndata: ${JSON.stringify(DISCOVER_RESULT)}\n\n`)
        : html("", 404),
    );
    const { check } = await probeAndScore();
    expect(check).toMatchObject({ status: "pass", score: 100 });
  });

  it.each([
    ["a 500 status", () => openSse("event: endpoint\ndata: /messages\n\n", 500)],
    [
      "an endpoint event with no data",
      () => openSse("event: endpoint\n\nevent: message\ndata: x\n\n"),
    ],
    ["an endpoint event with empty data", () => openSse("event: endpoint\ndata:\n\n")],
  ])("legacy SSE GET with %s is not an MCP endpoint", async (_label, respond) => {
    mockSite((url, call) => {
      if (url.href !== ENDPOINT) return html("", 404);
      if (call.method === "POST") return new Response("", { status: 405 });
      return respond();
    });
    expect(await probeMcpEndpoint(SITE, "", metaOptions)).toBeUndefined();
  });

  it.each([
    ["no WWW-Authenticate", {}],
    ["a Basic challenge", { "www-authenticate": 'Basic realm="admin"' }],
    ["a Bearer challenge without resource_metadata", { "www-authenticate": 'bearer realm="x"' }],
  ])("401 with %s is not an MCP endpoint (login walls and API gateways are not MCP servers)", async (_label, headers) => {
    mockSite(() => new Response("login", { status: 401, headers }));
    expect(await probeMcpEndpoint(SITE, "", metaOptions)).toBeUndefined();
  });

  it("whole-origin API gateway answering every path 401 Bearer realm=api → no endpoint, fail 0", async () => {
    const GATEWAY = "https://api-gateway.example";
    mockSite(
      () =>
        new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="api"' },
        }),
    );
    const metadata = await probeSiteMetadata(GATEWAY, metaOptions);
    expect(metadata.mcpEndpoint).toBeUndefined();
    expect(mcpDiscovery.run([], metadata)).toMatchObject({ status: "fail", score: 0 });
  });

  it("401 Bearer with resource_metadata on the legacy SSE GET → auth-gated HTTP+SSE endpoint, partial 50", async () => {
    mockSite((url, call) => {
      if (url.href !== ENDPOINT) return html("", 404);
      if (call.method === "POST") return new Response("", { status: 405 });
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="x", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
        },
      });
    });
    const { found, check } = await probeAndScore();
    expect(found).toMatchObject({ status: 401, transport: "http+sse" });
    expect(check).toMatchObject({ status: "partial", score: 50 });
  });

  describe("redirects (probe hook set, as the platform runs it)", () => {
    const hooked = { ...metaOptions, isAllowedTarget: (u: string) => !u.includes("/internal/") };
    const redirect = (status: number, location: string) =>
      new Response(null, { status, headers: { location } });

    it("POST /mcp → 302 to a static DiscoverResult JSON (POST rewritten to GET) is not credited", async () => {
      mockSite((url, call) => {
        if (url.href === ENDPOINT && call.method === "POST") return redirect(302, "/static.json");
        if (url.pathname === "/static.json") return json(DISCOVER_RESULT);
        return html("", 404);
      });
      expect(await probeMcpEndpoint(SITE, "", hooked)).toBeUndefined();
      expect(calls.some((c) => c.url.endsWith("/static.json"))).toBe(false);
    });

    it("307 /mcp → /mcp/ re-sends the same POST and records the final URL", async () => {
      mockSite((url, call) => {
        if (url.href === ENDPOINT && call.method === "POST") return redirect(307, "/mcp/");
        if (url.href === `${ENDPOINT}/` && call.method === "POST") return json(DISCOVER_RESULT);
        return html("", 404);
      });
      const found = await probeMcpEndpoint(SITE, "", hooked);
      expect(found).toMatchObject({ mcpEndpointUrl: `${ENDPOINT}/`, success: true });
      const [hop] = posts(`${ENDPOINT}/`);
      expect(rpcMethod(hop)).toBe("server/discover");
      expect(hop.headers.get("mcp-method")).toBe("server/discover");
    });

    it("307 to a third-party host is not followed", async () => {
      mockSite((url, call) => {
        if (url.href === ENDPOINT && call.method === "POST") {
          return redirect(307, "https://thirdparty.dev/mcp");
        }
        if (url.hostname === "thirdparty.dev") return json(DISCOVER_RESULT);
        return html("", 404);
      });
      expect(await probeMcpEndpoint(SITE, "", hooked)).toBeUndefined();
      expect(calls.some((c) => c.url.includes("thirdparty.dev"))).toBe(false);
    });

    it("a redirect hop refused by isAllowedTarget is never fetched", async () => {
      mockSite((url, call) => {
        if (url.href === ENDPOINT && call.method === "POST") return redirect(308, "/internal/mcp");
        if (url.pathname === "/internal/mcp") return json(DISCOVER_RESULT);
        return html("", 404);
      });
      expect(await probeMcpEndpoint(SITE, "", hooked)).toBeUndefined();
      expect(calls.some((c) => c.url.includes("/internal/"))).toBe(false);
    });

    it("stops after 3 hops", async () => {
      mockSite((url, call) => {
        const n = Number(url.pathname.match(/^\/r(\d+)$/)?.[1] ?? -1);
        if (url.href === ENDPOINT && call.method === "POST") return redirect(307, "/r1");
        if (n > 0 && call.method === "POST") return redirect(307, `/r${n + 1}`);
        if (n > 0) return json(DISCOVER_RESULT);
        return html("", 404);
      });
      expect(await probeMcpEndpoint(SITE, "", hooked)).toBeUndefined();
      expect(calls.some((c) => c.url.endsWith("/r4"))).toBe(false);
      expect(posts(`${SITE}/r3`)).toHaveLength(1);
    });
  });

  it("uses a same-site homepage href and never fetches a third-party MCP server", async () => {
    const homepage =
      '<a href="https://thirdparty.dev/mcp">Their MCP</a><a href="https://mcp.example.com/sse">Our MCP</a>';
    mockSite((url, call) => {
      if (url.href !== "https://mcp.example.com/sse") return html("", 404);
      if (call.method === "POST") return new Response("", { status: 405 });
      return openSse("event: endpoint\ndata: /messages\n\n");
    });
    const found = await probeMcpEndpoint(SITE, homepage, metaOptions);
    expect(found?.mcpEndpointUrl).toBe("https://mcp.example.com/sse");
    expect(calls.some((c) => c.url.includes("thirdparty.dev"))).toBe(false);
    // Homepage candidates come first: no fixed candidate was probed before it.
    expect(calls.every((c) => c.url === "https://mcp.example.com/sse")).toBe(true);
  });

  it("network errors on every candidate yield no endpoint and do not throw", async () => {
    mockSite(() => {
      throw new TypeError("fetch failed");
    });
    await expect(probeMcpEndpoint(SITE, "", metaOptions)).resolves.toBeUndefined();
  });
});

describe("probeMcpEndpoint wall-clock budget", () => {
  const SITE = "https://example.com";
  const hang = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  it("hanging candidates stop at the budget (3× the per-request timeout), not after every candidate", async () => {
    mockSite((_url, _call, init) => hang(init));
    const homepage = '<a href="/x/mcp">x</a><a href="/y/mcp">y</a>';
    const start = Date.now();
    const found = await probeMcpEndpoint(SITE, homepage, { timeout: 100 });
    const elapsed = Date.now() - start;
    expect(found).toBeUndefined();
    // 5 candidates × 100 ms would take 500 ms; the 300 ms budget cuts the pass short.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);
    expect(calls.some((c) => c.url === "https://mcp.example.com/")).toBe(false);
  });

  it("a hanging first candidate times out and a later candidate is still found", async () => {
    mockSite((url, call, init) => {
      if (url.href === `${SITE}/mcp`) return hang(init);
      if (url.href === "https://mcp.example.com/mcp" && call.method === "POST") {
        return json(DISCOVER_RESULT);
      }
      return html("", 404);
    });
    const found = await probeMcpEndpoint(SITE, "", { timeout: 100 });
    expect(found?.mcpEndpointUrl).toBe("https://mcp.example.com/mcp");
  });
});

describe("buildMcpCandidates", () => {
  it("orders same-site homepage hrefs first, then /mcp, mcp.<apex>/mcp, mcp.<apex>/ — deduped", () => {
    const homepage = `
      <link rel="mcp" href="/api/mcp">
      <a href="https://www.example.com/mcp#top">dup of /mcp after hash strip</a>
      <a href="https://docs.example.com/guide">not MCP-looking</a>
      <a href="https://evil-example.com/mcp">lookalike apex</a>
      <a href="mailto:mcp@example.com">mail</a>`;
    expect(buildMcpCandidates("https://www.example.com", homepage)).toEqual([
      "https://www.example.com/api/mcp",
      "https://www.example.com/mcp",
      "https://mcp.example.com/mcp",
      "https://mcp.example.com/",
    ]);
  });

  it(`caps at ${MCP_CANDIDATE_CAP} and keeps the fixed candidates when the homepage has many MCP links`, () => {
    const homepage = ["/a/mcp", "/b/mcp", "/c/mcp", "/d/sse", "/e/mcp"]
      .map((h) => `<a href="${h}">x</a>`)
      .join("");
    const candidates = buildMcpCandidates("https://example.com", homepage);
    expect(candidates).toHaveLength(MCP_CANDIDATE_CAP);
    expect(candidates.slice(-3)).toEqual([
      "https://example.com/mcp",
      "https://mcp.example.com/mcp",
      "https://mcp.example.com/",
    ]);
  });

  it("auditing an mcp.<domain> host directly probes its own / (and never mcp.mcp.<domain>)", async () => {
    expect(buildMcpCandidates("https://mcp.stripe.com", "")).toEqual([
      "https://mcp.stripe.com/mcp",
      "https://mcp.stripe.com/",
    ]);
    mockSite((url, call) =>
      url.href === "https://mcp.stripe.com/" && call.method === "POST"
        ? json({}, 401, {
            "www-authenticate":
              "Bearer resource_metadata=https://mcp.stripe.com/.well-known/oauth-protected-resource",
          })
        : html("", 404),
    );
    const found = await probeMcpEndpoint("https://mcp.stripe.com", "", metaOptions);
    expect(found).toMatchObject({ mcpEndpointUrl: "https://mcp.stripe.com/", status: 401 });
  });

  it("does not invent mcp.<host> candidates for localhost or IP literals", () => {
    expect(buildMcpCandidates("http://localhost:3000", "")).toEqual(["http://localhost:3000/mcp"]);
    expect(buildMcpCandidates("http://127.0.0.1:8080", "")).toEqual(["http://127.0.0.1:8080/mcp"]);
  });
});
