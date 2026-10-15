import { afterEach, describe, expect, it, vi } from "vitest";
import { nextjsWellKnownCheck } from "../src/adapters/nextjs/checks.js";
import { allChecks } from "../src/audit/checks/index.js";
import { wellKnownUcp } from "../src/audit/checks/protocols.js";
import { probeSiteMetadata } from "../src/audit/crawler.js";
import { runAudit } from "../src/audit/engine.js";
import { isJsonContentType } from "../src/audit/shared/json.js";
import type {
  AuditOptions,
  AuditReport,
  Check,
  CheckResult,
  FetchedPage,
} from "../src/audit/types.js";
import { DEFAULT_OPTIONS } from "../src/audit/types.js";

const FIXED_UUID = "00000000-0000-4000-8000-000000000000";
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

const SITE = "https://example.com";
const CLOUDFLARE_API_CATALOG =
  '{"linkset":[{"anchor":"https://developers.cloudflare.com/api/","service-desc":[{"href":"https://developers.cloudflare.com/openapi.json","type":"application/json"}],"service-doc":[{"href":"https://developers.cloudflare.com/api/","type":"text/html"}],"status":[{"href":"https://www.cloudflarestatus.com/api/v2/status.json","type":"application/json"}]}]}';
const OPTIONS: Partial<AuditOptions> = { maxPages: 1, requestDelay: 0, timeout: 1000 };
const SPA_SHELL =
  '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

const WELL_KNOWN_CHECK_IDS = [
  "well-known-agent-card",
  "well-known-ucp",
  "mcp-discovery",
  "oauth-discovery",
  "api-catalog-rfc9727",
  "agent-operator-signing",
  "mcp-server-card",
  "agent-skills-index",
  "llms-txt-exists",
  "robots-txt-exists",
  "usage-preference-declared",
];

type Route = (url: URL) => Response;

function mockSite(route: Route) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const raw = input instanceof Request ? input.url : String(input);
    return route(new URL(raw));
  });
}

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function checksById(report: AuditReport): Map<string, CheckResult> {
  return new Map(report.categories.flatMap((c) => c.checks).map((r) => [r.id, r]));
}

const metaOptions = { ...DEFAULT_OPTIONS, ...OPTIONS };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("catch-all / soft-404 guard", () => {
  it("an SPA answering 200 text/html for every path passes zero well-known checks", async () => {
    mockSite(() => html(SPA_SHELL));

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    expect(Object.values(metadata.wellKnown).filter(Boolean)).toEqual([]);
    expect(metadata.robotsTxt).toBeUndefined();
    expect(metadata.llmsTxt).toBeUndefined();

    const report = await runAudit(SITE, OPTIONS, undefined, allChecks);
    const byId = checksById(report);
    for (const id of WELL_KNOWN_CHECK_IDS) {
      const r = byId.get(id);
      expect(r, id).toBeDefined();
      expect({ id, status: r?.status, score: r?.score }).toMatchObject({ id, score: 0 });
      expect(["fail", "skip"], id).toContain(r?.status);
    }
    // The engine gate skips UCP on non-ecommerce sites; run it directly so the body itself is judged.
    expect(await wellKnownUcp.run([], metadata)).toMatchObject({ status: "fail", score: 0 });

    const warning = report.warnings.find((w) => w.id === "catch-all-responses");
    expect(warning).toBeDefined();
    expect(warning?.message).toMatch(/do not exist|non-existent/i);
    expect(warning?.message).toMatch(/JSON/);
    expect(warning?.message).toMatch(/developer-portal/);
  });

  it("probes /.well-known/<uuid> and /<uuid> with node:crypto randomUUID (engines.node >=18 has no global crypto)", async () => {
    const fetchSpy = mockSite(() => html("nope", 404));
    await probeSiteMetadata(SITE, metaOptions);
    const urls = fetchSpy.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : String(input),
    );
    expect(urls).toContain(`${SITE}/${FIXED_UUID}`);
    expect(urls).toContain(`${SITE}/.well-known/${FIXED_UUID}`);
  });

  it("on an SPA catch-all, same-origin developer-portal and key-doc paths earn no credit", async () => {
    const longShell = `<!doctype html><html><body>${"api key oauth agent token scope permission read:users write:posts ".repeat(40)}</body></html>`;
    mockSite((url) => (url.hostname === "example.com" ? html(longShell) : html("nope", 404)));

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    const pages: FetchedPage[] = [];
    for (const id of ["developer-portal", "agent-auth-docs", "scoped-permissions", "pkce-s256"]) {
      const check = allChecks.find((c) => c.id === id) as Check;
      expect(await check.run(pages, metadata), id).toMatchObject({ status: "fail", score: 0 });
    }
  });

  it("on a catch-all site whose portal subdomains do not resolve, developer-portal fails rather than skipping as unreachable", async () => {
    vi.useFakeTimers();
    try {
      mockSite(() => {
        throw new TypeError("fetch failed");
      });
      const check = allChecks.find((c) => c.id === "developer-portal") as Check;
      const pending = check.run([], { baseUrl: SITE, wellKnown: {}, catchAll: true });
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ status: "fail", score: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("on a catch-all site, a real portal on the docs.<host> subdomain is still found", async () => {
    const portal = `<html><body>${"Developer portal: API reference and guides. ".repeat(40)}</body></html>`;
    mockSite((url) => {
      if (url.hostname === "docs.example.com" && url.pathname === "/") return html(portal);
      if (url.hostname === "example.com") return html(SPA_SHELL);
      return html("nope", 404);
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    const check = allChecks.find((c) => c.id === "developer-portal") as Check;
    const result = await check.run([], metadata);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("docs.example.com");
  });

  it("a path-echoing JSON catch-all (different body per path) passes no schema-checked well-known check", async () => {
    mockSite((url) => json({ error: "not found", path: url.pathname }));

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    expect(metadata.wellKnown["agent-card.json"]).toBeDefined();
    expect(metadata.wellKnown["api-catalog"]).toBeUndefined();

    const report = await runAudit(SITE, OPTIONS, undefined, allChecks);
    const byId = checksById(report);
    for (const id of [
      "well-known-agent-card",
      "well-known-ucp",
      "oauth-discovery",
      "pkce-s256",
      "agent-operator-signing",
      "api-catalog-rfc9727",
      "mcp-server-card",
      "agent-skills-index",
    ]) {
      expect(byId.get(id)?.score, id).toBe(0);
    }
    // The engine gate skips UCP on non-ecommerce sites; run it directly so the body itself is judged.
    expect(await wellKnownUcp.run([], metadata)).toMatchObject({ status: "fail", score: 0 });
    expect(await nextjsWellKnownCheck.run([], metadata)).toMatchObject({
      status: "fail",
      score: 0,
    });
  });

  it("well-known files not served with a JSON content-type are not counted, even when bodies differ per path", async () => {
    mockSite((url) => {
      if (url.pathname === "/.well-known/agent-card.json") {
        return new Response('{"name":"Example"}', { headers: { "content-type": "text/plain" } });
      }
      return html(`<p>No page at ${url.pathname}</p>`);
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    expect(Object.values(metadata.wellKnown).filter(Boolean)).toEqual([]);
  });

  it("a site that 404s unknown paths and serves real JSON well-known files keeps its passes", async () => {
    mockSite((url) => {
      switch (url.pathname) {
        case "/":
          return html(SPA_SHELL);
        case "/api/":
          return json({ ok: true });
        case "/.well-known/agent-card.json":
          return json({
            name: "Example",
            description: "Example agent",
            supportedInterfaces: [
              { url: `${SITE}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
            ],
            version: "1.0.0",
            capabilities: {},
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills: [],
          });
        case "/.well-known/oauth-protected-resource":
          return json({ resource: SITE, authorization_servers: [SITE] });
        case "/.well-known/oauth-authorization-server":
          return json({
            issuer: SITE,
            authorization_endpoint: `${SITE}/authorize`,
            token_endpoint: `${SITE}/token`,
          });
        default:
          return html("<h1>Not found</h1>", 404);
      }
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(false);

    const report = await runAudit(SITE, OPTIONS, undefined, allChecks);
    const byId = checksById(report);
    expect(byId.get("well-known-agent-card")).toMatchObject({ status: "pass", score: 100 });
    expect(byId.get("oauth-discovery")).toMatchObject({ status: "pass", score: 100 });
    expect(report.warnings.find((w) => w.id === "catch-all-responses")).toBeUndefined();
  });

  it("a JSON catch-all does not count well-known bodies identical to its soft-404 body", async () => {
    const realPrm = { resource: SITE, authorization_servers: [SITE] };
    mockSite((url) => {
      if (url.pathname === "/.well-known/oauth-protected-resource") return json(realPrm);
      return json({});
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    expect(metadata.wellKnown["agent-card.json"]).toBeUndefined();
    expect(metadata.wellKnown.ucp).toBeUndefined();
    expect(metadata.wellKnown.mcp).toBeUndefined();
    expect(metadata.wellKnown["oauth-authorization-server"]).toBeUndefined();
    expect(metadata.wellKnown["oauth-protected-resource"]).toBe(JSON.stringify(realPrm));
    for (const path of [
      "http-message-signatures-directory",
      "api-catalog",
      "ai-catalog.json",
      "mcp/server-card.json",
      "agent-skills/index.json",
    ]) {
      expect(metadata.wellKnown[path], path).toBeUndefined();
    }

    const report = await runAudit(SITE, OPTIONS, undefined, allChecks);
    const byId = checksById(report);
    for (const id of [
      "well-known-agent-card",
      "well-known-ucp",
      "mcp-discovery",
      "agent-operator-signing",
      "api-catalog-rfc9727",
      "mcp-server-card",
      "agent-skills-index",
    ]) {
      expect(byId.get(id)?.score, id).toBe(0);
    }
    // The engine gate skips UCP on non-ecommerce sites; run it directly so the body itself is judged.
    expect(await wellKnownUcp.run([], metadata)).toMatchObject({ status: "fail", score: 0 });
    // The real PRM still counts, but the {} soft-404 served at the AS metadata path has no issuer.
    expect(byId.get("oauth-discovery")).toMatchObject({ status: "partial", score: 50 });
    expect(report.warnings.some((w) => w.id === "catch-all-responses")).toBe(true);
  });

  it("ai-catalog.json is kept under application/ai-catalog+json and dropped when served as HTML", async () => {
    const catalog = JSON.stringify({
      specVersion: "1.0",
      entries: [
        {
          identifier: "urn:air:github.com:mcp:github-mcp-server",
          type: "application/mcp-server-card+json",
          url: "https://api.githubcopilot.com/mcp/server-card",
        },
      ],
    });
    for (const [type, expected] of [
      ["application/ai-catalog+json", catalog],
      ["text/html", undefined],
    ] as const) {
      mockSite((url) =>
        url.pathname === "/.well-known/ai-catalog.json"
          ? new Response(catalog, { headers: { "content-type": type } })
          : html("nope", 404),
      );
      const metadata = await probeSiteMetadata(SITE, metaOptions);
      expect(metadata.wellKnown["ai-catalog.json"], type).toBe(expected);
      vi.restoreAllMocks();
    }
  });

  it("the retired /.well-known/mcp.json is no longer probed", async () => {
    const fetchSpy = mockSite(() => html("nope", 404));
    await probeSiteMetadata(SITE, metaOptions);
    const urls = fetchSpy.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : String(input),
    );
    expect(urls).not.toContain(`${SITE}/.well-known/mcp.json`);
    expect(urls).toContain(`${SITE}/.well-known/ai-catalog.json`);
    expect(urls).toContain(`${SITE}/.well-known/mcp/server-card.json`);
  });

  it("robots.txt and llms.txt HTML shells are absent; the llms.txt subdomain fallback skips shells too", async () => {
    mockSite((url) => {
      if (url.hostname === "docs.example.com" && url.pathname === "/llms.txt")
        return html(SPA_SHELL);
      if (url.hostname === "developers.example.com" && url.pathname === "/llms.txt") {
        return html("# Docs\n");
      }
      if (url.pathname === "/robots.txt" || url.pathname === "/llms.txt") return html(SPA_SHELL);
      return html("nope", 404);
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.robotsTxt).toBeUndefined();
    expect(metadata.llmsTxt).toBe("# Docs\n");
  });

  it.each([
    "",
    "  \n",
  ])("an apex llms.txt served as empty text/html (%j) does not block the docs. subdomain fallback", async (apexBody) => {
    mockSite((url) => {
      if (url.hostname === "docs.example.com" && url.pathname === "/llms.txt") {
        return new Response("# Docs\n", { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/llms.txt") return html(apexBody);
      return html("nope", 404);
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.llmsTxt).toBe("# Docs\n");
  });

  it("a connection reset mid-body on one well-known path does not abort the metadata probe", async () => {
    mockSite((url) => {
      if (url.pathname === "/.well-known/mcp/server-card.json") {
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) return controller.error(new TypeError("terminated: ECONNRESET"));
            sent = true;
            controller.enqueue(new TextEncoder().encode('{"name":'));
          },
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/.well-known/agent-card.json") return json({ name: "Example" });
      if (url.pathname === "/.well-known/api-catalog") {
        return new Response(CLOUDFLARE_API_CATALOG, {
          headers: { "content-type": "application/linkset+json" },
        });
      }
      return html("nope", 404);
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.wellKnown["mcp/server-card.json"]).toBeUndefined();
    expect(metadata.wellKnown["agent-card.json"]).toBe(JSON.stringify({ name: "Example" }));
    expect(metadata.wellKnown["api-catalog"]).toBeDefined();
  });

  it("robots.txt and llms.txt with real content are kept even when mislabelled text/html", async () => {
    const robots = "User-agent: *\nDisallow: /admin\n";
    const llms = "# Example\n\n> Docs index\n";
    mockSite((url) => {
      if (url.pathname === "/robots.txt") return html(robots);
      if (url.pathname === "/llms.txt") return html(llms);
      return html("nope", 404);
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.robotsTxt).toBe(robots);
    expect(metadata.llmsTxt).toBe(llms);
  });
});

describe("crawler gate covers the signatures directory, api-catalog and the legacy MCP server card", () => {
  const PATHS = ["http-message-signatures-directory", "api-catalog", "mcp/server-card.json"];
  const SIGNING_TYPE = "application/http-message-signatures-directory+json";
  const LINKSET_TYPE =
    'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
  const BODIES: Record<string, string> = {
    "http-message-signatures-directory": JSON.stringify({
      keys: [{ kty: "OKP", crv: "Ed25519", x: "abc" }],
      signature_agent: SITE,
    }),
    "api-catalog": CLOUDFLARE_API_CATALOG,
    "mcp/server-card.json": JSON.stringify({
      name: "MCP",
      version: "1.0.0",
      description: "Example MCP server",
    }),
  };
  const SPEC_TYPES: Record<string, string> = {
    "http-message-signatures-directory": SIGNING_TYPE,
    "api-catalog": LINKSET_TYPE,
    "mcp/server-card.json": "application/mcp-server-card+json",
  };
  const serve = (make: (path: string, body: string) => Response) =>
    mockSite((url) => {
      const path = url.pathname.replace("/.well-known/", "");
      if (url.pathname.startsWith("/.well-known/") && path in BODIES)
        return make(path, BODIES[path]);
      return html("nope", 404);
    });
  const withType =
    (status: number, type: (path: string) => string) => (path: string, body: string) =>
      new Response(body, { status, headers: { "content-type": type(path) } });

  it("accepts each path under its spec media type and the checks pass without fetching", async () => {
    serve(withType(200, (path) => SPEC_TYPES[path]));
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    vi.restoreAllMocks();
    const fetchSpy = mockSite(() => {
      throw new Error("d1/d2/d4 must read crawler metadata, not fetch");
    });
    for (const id of ["agent-operator-signing", "api-catalog-rfc9727", "mcp-server-card"]) {
      const check = allChecks.find((c) => c.id === id) as Check;
      expect(await check.run([], metadata), id).toMatchObject({ status: "pass", score: 100 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["206 under the spec media type", withType(206, (path) => SPEC_TYPES[path])],
    ["200 text/html", withType(200, () => "text/html")],
  ])("rejects %s", async (_label, make) => {
    serve(make);
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    for (const path of PATHS) expect(metadata.wellKnown[path], path).toBeUndefined();
  });

  it("rejects api-catalog and the signing directory served as plain application/json, still accepts the server card", async () => {
    serve(withType(200, () => "application/json; charset=utf-8"));
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.wellKnown["api-catalog"]).toBeUndefined();
    expect(metadata.wellKnown["http-message-signatures-directory"]).toBeUndefined();
    expect(metadata.wellKnown["mcp/server-card.json"]).toBe(BODIES["mcp/server-card.json"]);

    const report = await runAudit(SITE, OPTIONS, undefined, allChecks);
    const byId = checksById(report);
    expect(byId.get("agent-operator-signing")).toMatchObject({ status: "skip", score: 0 });
    expect(byId.get("api-catalog-rfc9727")?.score).toBe(0);
  });

  it("accepts /.well-known/tdmrep.json and usage-preference-declared reads it", async () => {
    const tdmrep = JSON.stringify([{ location: "/", "tdm-reservation": 1 }]);
    mockSite((url) =>
      url.pathname === "/.well-known/tdmrep.json" ? json(JSON.parse(tdmrep)) : html("nope", 404),
    );
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(false);
    expect(metadata.wellKnown["tdmrep.json"]).toBe(tdmrep);

    const check = allChecks.find((c) => c.id === "usage-preference-declared") as Check;
    expect(await check.run([], metadata)).toMatchObject({
      status: "pass",
      message: "Training opt-out declared (TDMRep)",
    });
  });

  it("a full audit reports the Cloudflare managed robots.txt as a tracked pass (§5 row 4 proof)", async () => {
    // Abridged from a live capture of https://www.crawlstop.com/robots.txt
    // (2026-09-15, UA w2agent/0.1), the worked example in Cloudflare's own docs.
    const managedRobots = [
      "# As a condition of accessing this website, you agree to abide by the",
      "# following content signals:",
      "# ai-train: training or fine-tuning AI models.",
      "",
      "# BEGIN Cloudflare Managed content",
      "",
      "User-agent: *",
      "Content-Signal: search=yes,ai-train=no,use=reference",
      "Allow: /",
      "",
      "# END Cloudflare Managed Content",
      "",
      "User-agent: *",
      "Disallow: /lp",
      "",
    ].join("\n");
    mockSite((url) =>
      url.pathname === "/robots.txt"
        ? new Response(managedRobots, { headers: { "content-type": "text/plain; charset=utf-8" } })
        : html("<html><body><h1>Example</h1></body></html>"),
    );

    const report = await runAudit(SITE, OPTIONS, undefined, allChecks);
    expect(checksById(report).get("usage-preference-declared")).toMatchObject({
      status: "pass",
      tracked: true,
      weight: 0,
      message: "Training opt-out declared (Content-Signal, CDN-managed default)",
    });
  });

  it("a JSON catch-all makes tdmrep.json absent, so usage-preference-declared skips", async () => {
    mockSite(() => json([{ location: "/", "tdm-reservation": 1 }]));
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    expect(metadata.wellKnown["tdmrep.json"]).toBeUndefined();

    const check = allChecks.find((c) => c.id === "usage-preference-declared") as Check;
    expect(await check.run([], metadata)).toMatchObject({ status: "skip", score: 0 });
  });

  it("rejects tdmrep.json served as text/html", async () => {
    mockSite((url) =>
      url.pathname === "/.well-known/tdmrep.json"
        ? html(JSON.stringify([{ location: "/", "tdm-reservation": 1 }]))
        : html("nope", 404),
    );
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.wellKnown["tdmrep.json"]).toBeUndefined();
  });

  it("api-catalog served as application/json by default and linkset+json only on Accept (RFC 9727 §4.2 negotiation) → accepted, pass", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/.well-known/api-catalog") return html("nope", 404);
      const accept = new Headers(init?.headers).get("accept") ?? "";
      return accept.includes("application/linkset+json")
        ? new Response(CLOUDFLARE_API_CATALOG, { headers: { "content-type": LINKSET_TYPE } })
        : json({ apis: [{ name: "Example API", url: "https://example.com/api" }] });
    });
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.wellKnown["api-catalog"]).toBe(CLOUDFLARE_API_CATALOG);
    const check = allChecks.find((c) => c.id === "api-catalog-rfc9727") as Check;
    expect(await check.run([], metadata)).toMatchObject({ status: "pass", score: 100 });
  });

  it("a catch-all serving HTML by default but the same linkset+json body for every path on Accept → api-catalog not accepted, fail", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const accept = new Headers(init?.headers).get("accept") ?? "";
      return accept.includes("application/linkset+json")
        ? new Response(CLOUDFLARE_API_CATALOG, { headers: { "content-type": LINKSET_TYPE } })
        : html(SPA_SHELL);
    });
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.wellKnown["api-catalog"]).toBeUndefined();
    const check = allChecks.find((c) => c.id === "api-catalog-rfc9727") as Check;
    expect(await check.run([], metadata)).toMatchObject({ status: "fail", score: 0 });
  });

  it("rejects each path's spec media type on the other path", async () => {
    serve(
      withType(200, (path) =>
        path === "api-catalog"
          ? SIGNING_TYPE
          : path === "mcp/server-card.json"
            ? "application/json"
            : LINKSET_TYPE,
      ),
    );
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.wellKnown["api-catalog"]).toBeUndefined();
    expect(metadata.wellKnown["http-message-signatures-directory"]).toBeUndefined();
  });

  it.each([
    ["api-catalog", CLOUDFLARE_API_CATALOG, LINKSET_TYPE],
    [
      "http-message-signatures-directory",
      BODIES["http-message-signatures-directory"],
      SIGNING_TYPE,
    ],
  ])("a catch-all echoing a valid %s body under its spec media type for every path earns nothing", async (path, body, type) => {
    mockSite(() => new Response(body, { headers: { "content-type": type } }));
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    expect(metadata.wellKnown[path]).toBeUndefined();

    const report = await runAudit(SITE, OPTIONS, undefined, allChecks);
    const byId = checksById(report);
    expect(byId.get("api-catalog-rfc9727")?.score).toBe(0);
    expect(byId.get("agent-operator-signing")?.status).not.toBe("pass");
  });
});

describe("isJsonContentType", () => {
  it.each([
    "application/json",
    "application/json; charset=utf-8",
    " Application/JSON ",
    "application/linkset+json",
    "application/http-message-signatures-directory+json; charset=utf-8",
    "application/ai-catalog+json",
    "application/mcp-server-card+json",
  ])("accepts %s", (ct) => {
    expect(isJsonContentType(ct)).toBe(true);
  });

  it.each([
    "",
    "text/plain",
    'text/plain; profile="json"',
    "text/html; charset=json",
    "application/jsonp",
    "application/json-seq",
    "application/x-json-stream",
  ])("rejects %j", (ct) => {
    expect(isJsonContentType(ct)).toBe(false);
  });
});

describe("agent-skills-index catch-all handling", () => {
  it("a catch-all serving the same JSON body for the index path is absent, so the check skips", async () => {
    mockSite(() => json({ error: "not found" }));
    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    expect(metadata.wellKnown["agent-skills/index.json"]).toBeUndefined();
    const check = allChecks.find((c) => c.id === "agent-skills-index") as Check;
    expect(await check.run([], metadata)).toMatchObject({ status: "skip", score: 0 });
  });
});
