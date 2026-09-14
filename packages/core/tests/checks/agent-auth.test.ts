import { afterEach, describe, expect, it, vi } from "vitest";
import { agentAuthChecks } from "../../src/audit/checks/agent-auth.js";
import type { Check, CheckResult, FetchedPage, SiteMetadata } from "../../src/audit/types.js";

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

const basePage: FetchedPage = {
  url: "https://example.com",
  status: 200,
  html: "<html><body>Hello world</body></html>",
  headers: {},
  responseTime: 100,
};

function mockFetch(impl: (url: string) => Response | null) {
  return vi.fn().mockImplementation(async (url: string) => {
    const r = impl(url);
    if (!r) throw new Error("network error");
    return r;
  });
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResp(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function notFound(): Response {
  return new Response("", { status: 404 });
}

const originalFetch = globalThis.fetch;

// --- A1 public-api ---
describe("agent-auth: A1 public-api", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pass when /api/ returns JSON", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/")) return jsonResp({ ok: true });
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "public-api")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
    expect(result.score).toBe(100);
  });

  it("pass when api.<host> returns JSON", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.startsWith("https://api.example.com")) return jsonResp({ ok: true });
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "public-api")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
  });

  it("partial when 1-2 in-page API links found", async () => {
    globalThis.fetch = mockFetch(() => notFound());
    const check = agentAuthChecks.find((c) => c.id === "public-api")!;
    const page = { ...basePage, html: '<a href="/api/">API</a>' };
    const result = await check.run([page], baseMeta);
    expect(result.status).toBe("partial");
    expect(result.score).toBe(50);
  });

  it("fail when no API surface found", async () => {
    globalThis.fetch = mockFetch(() => notFound());
    const check = agentAuthChecks.find((c) => c.id === "public-api")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("fail");
    expect(result.score).toBe(0);
  });
});

// --- A2 openapi-spec ---
describe("agent-auth: A2 openapi-spec", () => {
  const check = agentAuthChecks.find((c) => c.id === "openapi-spec")!;

  it("pass when openapi has endpoints", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      openapi: {
        specUrl: "https://example.com/openapi.json",
        version: "3.0.0",
        endpoints: [{ path: "/users", method: "GET", parameters: [], requestBody: undefined }],
      },
    };
    const result = check.run([basePage], meta) as ReturnType<typeof check.run>;
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("partial when spec has 0 endpoints", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      openapi: { specUrl: "https://example.com/openapi.json", version: "3.0.0", endpoints: [] },
    };
    const result = check.run([basePage], meta) as ReturnType<typeof check.run>;
    expect(result).toMatchObject({ status: "partial", score: 50 });
  });

  it("fail when no openapi in metadata", () => {
    const result = check.run([basePage], baseMeta) as ReturnType<typeof check.run>;
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});

// --- A3 developer-portal ---
describe("agent-auth: A3 developer-portal", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pass when portal has >= 1000 chars of content", async () => {
    const bigContent = `Welcome to the API ${"x".repeat(1000)}`;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/api")) return htmlResp(`<html><body>${bigContent}</body></html>`);
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "developer-portal")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
  });

  it("partial when portal content < 1000 chars", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/api")) return htmlResp("<html><body>Short content</body></html>");
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "developer-portal")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("partial");
  });

  it("fail when all portal paths return 404", async () => {
    globalThis.fetch = mockFetch(() => notFound());
    const check = agentAuthChecks.find((c) => c.id === "developer-portal")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("fail");
  });
});

// --- A4 agent-auth-docs ---
describe("agent-auth: A4 agent-auth-docs", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pass when >= 3 keyword pairs found in portal", async () => {
    const text =
      "Use your API key with your bot agent. " +
      "OAuth scopes control bot permission. " +
      "Rate limit applies to AI bots.";
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/api")) return htmlResp(`<html><body>${text}</body></html>`);
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "agent-auth-docs")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
  });

  it("partial when 1-2 keyword pairs found", async () => {
    const text = "OAuth token scope is required for bot access.";
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/api")) return htmlResp(`<html><body>${text}</body></html>`);
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "agent-auth-docs")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("partial");
  });

  it("fail when no keyword pairs found", async () => {
    globalThis.fetch = mockFetch(() => notFound());
    const check = agentAuthChecks.find((c) => c.id === "agent-auth-docs")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("fail");
  });

  it("pass when /keys has auth docs content (Stripe-style content split)", async () => {
    const apiText = "Stripe API Reference. Endpoints: charges, customers, subscriptions.";
    const keysText = `Use API keys to authenticate API requests.
      API keys are tokens with full account access.
      Restricted API keys let you assign custom permissions for each scope.
      Rate limit applies per API key. Configure permissions per resource.`;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/api")) return htmlResp(`<html><body>${apiText}</body></html>`);
      if (url.endsWith("/keys")) return htmlResp(`<html><body>${keysText}</body></html>`);
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "agent-auth-docs")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
  });
});

// --- B4 scoped-permissions ---
describe("agent-auth: B4 scoped-permissions", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pass when >= 3 scope signals in portal", async () => {
    const text = "read:users write:posts admin:settings scope permission token";
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/api")) return htmlResp(`<html><body>${text}</body></html>`);
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "scoped-permissions")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
  });

  it("partial when 1-2 signals found", async () => {
    const text = "read:users is the scope for reading";
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/api")) return htmlResp(`<html><body>${text}</body></html>`);
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "scoped-permissions")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("partial");
  });

  it("fail when no portal found", async () => {
    globalThis.fetch = mockFetch(() => notFound());
    const check = agentAuthChecks.find((c) => c.id === "scoped-permissions")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("fail");
  });

  it("pass with Stripe-style restricted-keys vocabulary on /keys", async () => {
    const keysText = `Restricted API keys (RAKs) let you assign custom permissions to specific resources.
      You can grant read or write access for each resource. Limit access using granular permissions.`;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/api")) return htmlResp("<html><body>generic API reference</body></html>");
      if (url.endsWith("/keys")) return htmlResp(`<html><body>${keysText}</body></html>`);
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "scoped-permissions")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
  });

  it("pass with portal-only graduated-access vocabulary (read-only + custom permissions + limit access)", async () => {
    const text =
      "We support custom permissions including read-only access. Limit access via scoped tokens.";
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/api")) return htmlResp(`<html><body>${text}</body></html>`);
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "scoped-permissions")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
  });
});

// --- oauth-discovery / pkce-s256 / mcp-auth / cimd-support ---
type Route = (url: string) => Response | Promise<Response> | undefined;
let fetched: string[] = [];

function routeFetch(route: Route) {
  fetched = [];
  globalThis.fetch = vi.fn().mockImplementation(async (input: string) => {
    const url = String(input);
    fetched.push(url);
    return (await route(url)) ?? notFound();
  });
}

function unauthorized(wwwAuthenticate?: string): Response {
  return new Response('{"error":"unauthorized"}', {
    status: 401,
    headers: {
      "content-type": "application/json",
      ...(wwwAuthenticate ? { "www-authenticate": wwwAuthenticate } : {}),
    },
  });
}

const byId = (id: string) => agentAuthChecks.find((c) => c.id === id)!;

async function runChecks(ids: string[], meta: SiteMetadata, ctx?: Parameters<Check["run"]>[2]) {
  const pages = [basePage];
  const out: Record<string, CheckResult> = {};
  for (const id of ids) out[id] = await byId(id).run(pages, meta, ctx);
  return out;
}

const AUTH0 = "https://example.us.auth0.com/";
const AUTH0_PRM_URL = "https://example.com/.well-known/oauth-protected-resource/api";
const auth0As = {
  issuer: AUTH0,
  authorization_endpoint: `${AUTH0}authorize`,
  token_endpoint: `${AUTH0}oauth/token`,
  code_challenge_methods_supported: ["S256"],
};

function auth0Site(overrides: { prm?: unknown; as?: unknown } = {}): Route {
  return (url) => {
    if (url === "https://example.com/api/")
      return unauthorized(`Bearer resource_metadata="${AUTH0_PRM_URL}"`);
    if (url === AUTH0_PRM_URL)
      return jsonResp(
        overrides.prm ?? { resource: "https://example.com/api", authorization_servers: [AUTH0] },
      );
    if (url === `${AUTH0}.well-known/openid-configuration`)
      return jsonResp(overrides.as ?? auth0As);
    return undefined;
  };
}

describe("agent-auth: oauth-discovery", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("Auth0-hosted AS passes: API 401 → PRM → RFC 8414 404 → OIDC discovery with matching issuer", async () => {
    routeFetch(auth0Site());
    const r = await runChecks(["oauth-discovery", "pkce-s256"], baseMeta);
    expect(r["oauth-discovery"]).toMatchObject({ status: "pass", score: 100 });
    expect(r["oauth-discovery"].message).toContain(AUTH0);
    expect(r["pkce-s256"]).toMatchObject({ status: "pass", score: 100 });
    expect(fetched).toContain(`${AUTH0}.well-known/oauth-authorization-server`);
    expect(fetched.filter((u) => u === "https://example.com/api/")).toHaveLength(1);
  });

  it("Stripe-like: unquoted resource_metadata and an issuer with a path resolved by path insertion", async () => {
    const prmUrl = "https://api.example.com/.well-known/oauth-protected-resource";
    routeFetch((url) => {
      if (url === "https://api.example.com/")
        return unauthorized(`Bearer resource_metadata=${prmUrl}`);
      if (url === prmUrl)
        return jsonResp({
          resource: "https://api.example.com",
          authorization_servers: ["https://access.example.com/mcp"],
        });
      if (url === "https://access.example.com/.well-known/oauth-authorization-server/mcp")
        return jsonResp({
          issuer: "https://access.example.com/mcp",
          authorization_endpoint: "https://access.example.com/mcp/authorize",
          token_endpoint: "https://access.example.com/mcp/token",
        });
      return undefined;
    });
    const r = await runChecks(["oauth-discovery"], baseMeta);
    expect(r["oauth-discovery"]).toMatchObject({ status: "pass", score: 100 });
    expect(fetched.some((u) => u.includes("openid-configuration"))).toBe(false);
  });

  it.each([
    ["another origin", { resource: "https://other.example/api", authorization_servers: [AUTH0] }],
    ["a sibling path", { resource: "https://example.com/apiv2", authorization_servers: [AUTH0] }],
    [
      "empty authorization_servers",
      { resource: "https://example.com/api", authorization_servers: [] },
    ],
    ["no authorization_servers", { resource: "https://example.com/api" }],
  ])("a PRM for %s does not pass and names where the chain broke", async (_label, prm) => {
    routeFetch(auth0Site({ prm }));
    const r = await runChecks(["oauth-discovery"], baseMeta);
    expect(r["oauth-discovery"]).toMatchObject({ status: "fail", score: 0 });
    expect(r["oauth-discovery"].message).toContain(AUTH0_PRM_URL);
  });

  it("issuer mismatch on the AS metadata → partial 50, and PKCE is not read from the rejected document", async () => {
    routeFetch(auth0Site({ as: { ...auth0As, issuer: "https://attacker.example" } }));
    const r = await runChecks(["oauth-discovery", "pkce-s256"], baseMeta);
    expect(r["oauth-discovery"]).toMatchObject({ status: "partial", score: 50 });
    expect(r["oauth-discovery"].message).toContain("https://attacker.example");
    expect(r["pkce-s256"]).toMatchObject({ status: "fail", score: 0 });
  });

  it("AS metadata missing token_endpoint → partial 50", async () => {
    const { token_endpoint: _omit, ...noToken } = auth0As;
    routeFetch(auth0Site({ as: noToken }));
    const r = await runChecks(["oauth-discovery"], baseMeta);
    expect(r["oauth-discovery"]).toMatchObject({ status: "partial", score: 50 });
  });

  it("PKCE is not credited from an AS document oauth-discovery rejected as incomplete", async () => {
    routeFetch(auth0Site({ as: { issuer: AUTH0, code_challenge_methods_supported: ["S256"] } }));
    const r = await runChecks(["oauth-discovery", "pkce-s256"], baseMeta);
    expect(r["oauth-discovery"]).toMatchObject({ status: "partial", score: 50 });
    expect(r["pkce-s256"]).toMatchObject({ status: "fail", score: 0 });
  });

  it("an off-origin AS blocked by isAllowedTarget → partial, and the AS host is never requested", async () => {
    routeFetch(auth0Site());
    const ctx = { isAllowedTarget: (u: string) => !new URL(u).hostname.endsWith("auth0.com") };
    const r = await runChecks(["oauth-discovery"], baseMeta, ctx);
    expect(r["oauth-discovery"]).toMatchObject({ status: "partial", score: 50 });
    expect(fetched.some((u) => u.includes("auth0.com"))).toBe(false);
  });

  it("a multi-challenge header (Basic first) still resolves the Bearer resource_metadata", async () => {
    const site = auth0Site();
    routeFetch((url) =>
      url === "https://example.com/api/"
        ? unauthorized(
            `Basic realm="x", Bearer error="invalid_token", resource_metadata="${AUTH0_PRM_URL}"`,
          )
        : site(url),
    );
    const r = await runChecks(["oauth-discovery"], baseMeta);
    expect(r["oauth-discovery"]).toMatchObject({ status: "pass", score: 100 });
  });

  it("resource_metadata inside a non-Bearer challenge is ignored (well-known fallback is used instead)", async () => {
    const decoy = "https://decoy.example/.well-known/oauth-protected-resource";
    routeFetch((url) =>
      url === "https://example.com/api/"
        ? unauthorized(`Basic resource_metadata="${decoy}"`)
        : undefined,
    );
    const r = await runChecks(["oauth-discovery"], baseMeta);
    expect(r["oauth-discovery"].status).toBe("fail");
    expect(fetched).not.toContain(decoy);
    expect(fetched).toContain(AUTH0_PRM_URL);
  });

  it("root PRM from the crawler, valid for the site origin, seeds the chain without any 401", async () => {
    routeFetch((url) =>
      url === `${AUTH0}.well-known/oauth-authorization-server` ? jsonResp(auth0As) : undefined,
    );
    const meta: SiteMetadata = {
      ...baseMeta,
      wellKnown: {
        "oauth-protected-resource": JSON.stringify({
          resource: "https://example.com",
          authorization_servers: [AUTH0],
        }),
      },
    };
    const r = await runChecks(["oauth-discovery"], meta);
    expect(r["oauth-discovery"]).toMatchObject({ status: "pass", score: 100 });
  });

  it("a root PRM whose resource names a sub-path is not valid for the origin it was served from", async () => {
    routeFetch(() => undefined);
    const meta: SiteMetadata = {
      ...baseMeta,
      wellKnown: {
        "oauth-protected-resource": JSON.stringify({
          resource: "https://example.com/api",
          authorization_servers: [AUTH0],
        }),
      },
    };
    expect((await runChecks(["oauth-discovery"], meta))["oauth-discovery"].status).toBe("fail");
  });

  const rootAs = (issuer: string, extra: Record<string, unknown> = {}): SiteMetadata => ({
    ...baseMeta,
    wellKnown: {
      "oauth-authorization-server": JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...extra,
      }),
    },
  });

  it("no PRM anywhere but a valid root AS (site is its own AS) → partial 50; PKCE read from it", async () => {
    routeFetch(() => undefined);
    const r = await runChecks(
      ["oauth-discovery", "pkce-s256"],
      rootAs("https://example.com", { code_challenge_methods_supported: ["S256"] }),
    );
    expect(r["oauth-discovery"]).toMatchObject({ status: "partial", score: 50 });
    expect(r["pkce-s256"]).toMatchObject({ status: "pass", score: 100 });
  });

  it("a root AS document whose issuer is another host earns nothing", async () => {
    routeFetch(() => undefined);
    const r = await runChecks(
      ["oauth-discovery", "pkce-s256"],
      rootAs("https://auth.example.com", { code_challenge_methods_supported: ["S256"] }),
    );
    expect(r["oauth-discovery"]).toMatchObject({ status: "fail", score: 0 });
    expect(r["pkce-s256"]).toMatchObject({ status: "fail", score: 0 });
  });

  it("fail 0 when nothing is found", async () => {
    routeFetch(() => undefined);
    expect((await runChecks(["oauth-discovery"], baseMeta))["oauth-discovery"]).toMatchObject({
      status: "fail",
      score: 0,
    });
  });
});

describe("agent-auth: pkce-s256 docs fallback", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("partial when PKCE+S256 mentioned in docs only", async () => {
    routeFetch((url) =>
      url.endsWith("/api")
        ? htmlResp("<html><body>Use PKCE with S256 for security</body></html>")
        : undefined,
    );
    expect((await runChecks(["pkce-s256"], baseMeta))["pkce-s256"].status).toBe("partial");
  });

  it("fail when no PKCE support found", async () => {
    routeFetch(() => undefined);
    expect((await runChecks(["pkce-s256"], baseMeta))["pkce-s256"].status).toBe("fail");
  });

  it("a resolved AS without S256 falls through to the docs check", async () => {
    routeFetch(auth0Site({ as: { ...auth0As, code_challenge_methods_supported: ["plain"] } }));
    expect((await runChecks(["pkce-s256"], baseMeta))["pkce-s256"]).toMatchObject({
      status: "fail",
      score: 0,
    });
  });
});

describe("agent-auth: mcp-auth", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const STRIPE_PRM = "https://mcp.stripe.com/.well-known/oauth-protected-resource";
  const mcpMeta = (
    status: number,
    wwwAuthenticate?: string,
    endpoint = "https://mcp.stripe.com/",
  ) =>
    ({
      baseUrl: "https://stripe.com",
      wellKnown: {},
      mcpEndpoint: endpoint,
      mcpInit: {
        mcpEndpointUrl: endpoint,
        success: status === 200,
        status,
        rawHeaders: wwwAuthenticate ? { "www-authenticate": wwwAuthenticate } : {},
      },
    }) satisfies SiteMetadata;

  it("MCP-only site shaped like mcp.stripe.com: the MCP 401 seeds oauth-discovery, so the chain scores once there", async () => {
    routeFetch((url) => {
      if (url === STRIPE_PRM)
        return jsonResp({
          resource: "https://mcp.stripe.com",
          authorization_servers: ["https://access.stripe.com/mcp"],
        });
      if (url === "https://access.stripe.com/.well-known/oauth-authorization-server/mcp")
        return jsonResp({
          issuer: "https://access.stripe.com/mcp",
          authorization_endpoint: "https://access.stripe.com/mcp/oauth2/authorize",
          token_endpoint: "https://access.stripe.com/mcp/oauth2/token",
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
        });
      return undefined;
    });
    const r = await runChecks(
      ["oauth-discovery", "pkce-s256", "cimd-support", "mcp-auth"],
      mcpMeta(401, `Bearer resource_metadata=${STRIPE_PRM}`),
    );
    expect(r["oauth-discovery"]).toMatchObject({ status: "pass", score: 100 });
    expect(r["oauth-discovery"].message).toContain("https://mcp.stripe.com/");
    expect(r["pkce-s256"]).toMatchObject({ status: "pass", score: 100 });
    expect(r["cimd-support"]).toMatchObject({ status: "pass", score: 100 });
    expect(r["mcp-auth"]).toMatchObject({ status: "skip", score: 0 });
    expect(r["mcp-auth"].message).toContain("oauth-discovery");
  });

  it("skip names the endpoint when an MCP endpoint is known but no handshake response was recorded", async () => {
    routeFetch(() => undefined);
    const meta: SiteMetadata = { ...baseMeta, mcpEndpoint: "https://example.com/mcp" };
    const r = await runChecks(["mcp-auth"], meta);
    expect(r["mcp-auth"]).toMatchObject({ status: "skip", score: 0 });
    expect(r["mcp-auth"].message).toContain("https://example.com/mcp");
    expect(r["mcp-auth"].message).not.toContain("No MCP endpoint");
  });

  it("pass via the path-inserted well-known PRM when the Bearer challenge carries no resource_metadata", async () => {
    const pathInserted = "https://example.com/.well-known/oauth-protected-resource/mcp";
    const rootPrm = "https://example.com/.well-known/oauth-protected-resource";
    routeFetch((url) => {
      if (url === "https://example.com/api/")
        return unauthorized(`Bearer resource_metadata="${rootPrm}"`);
      if (url === rootPrm)
        return jsonResp({ resource: "https://example.com", authorization_servers: [AUTH0] });
      if (url === `${AUTH0}.well-known/oauth-authorization-server`) return jsonResp(auth0As);
      if (url === pathInserted)
        return jsonResp({ resource: "https://example.com/mcp", authorization_servers: [AUTH0] });
      return undefined;
    });
    const meta = {
      ...mcpMeta(401, 'Bearer realm="mcp"', "https://example.com/mcp"),
      baseUrl: "https://example.com",
    };
    expect((await runChecks(["mcp-auth"], meta))["mcp-auth"]).toMatchObject({ status: "pass" });
  });

  it("partial: 401 Bearer, but the linked PRM is missing", async () => {
    routeFetch(() => undefined);
    const r = await runChecks(["mcp-auth"], mcpMeta(401, `Bearer resource_metadata=${STRIPE_PRM}`));
    expect(r["mcp-auth"]).toMatchObject({ status: "partial", score: 50 });
  });

  it("partial: 401 Bearer, but the PRM is for another resource", async () => {
    routeFetch((url) =>
      url === STRIPE_PRM
        ? jsonResp({ resource: "https://api.stripe.com", authorization_servers: ["https://a"] })
        : undefined,
    );
    const r = await runChecks(["mcp-auth"], mcpMeta(401, `Bearer resource_metadata=${STRIPE_PRM}`));
    expect(r["mcp-auth"]).toMatchObject({ status: "partial", score: 50 });
  });

  it("fail: 401 without a Bearer challenge", async () => {
    routeFetch(() => undefined);
    const r = await runChecks(["mcp-auth"], mcpMeta(401, 'Basic realm="mcp"'));
    expect(r["mcp-auth"]).toMatchObject({ status: "fail", score: 0 });
  });

  it("skip (not a failure): an open MCP server that answers without requiring authorization", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    const r = await runChecks(["mcp-auth"], mcpMeta(200));
    expect(r["mcp-auth"]).toMatchObject({ status: "skip", score: 0 });
    expect(r["mcp-auth"].message).toMatch(/does not require authorization/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("NA when the MCP endpoint resolves to the same PRM document oauth-discovery already validated", async () => {
    const rootPrm = "https://example.com/.well-known/oauth-protected-resource";
    routeFetch((url) => {
      if (url === "https://example.com/api/")
        return unauthorized(`Bearer resource_metadata="${rootPrm}"`);
      if (url === rootPrm)
        return jsonResp({ resource: "https://example.com", authorization_servers: [AUTH0] });
      if (url === `${AUTH0}.well-known/oauth-authorization-server`) return jsonResp(auth0As);
      return undefined;
    });
    const meta = {
      ...mcpMeta(401, `Bearer resource_metadata="${rootPrm}"`, "https://example.com/mcp"),
      baseUrl: "https://example.com",
    };
    const r = await runChecks(["oauth-discovery", "mcp-auth"], meta);
    expect(r["oauth-discovery"].status).toBe("pass");
    expect(r["mcp-auth"]).toMatchObject({ status: "skip", score: 0 });
    expect(r["mcp-auth"].message).toContain("oauth-discovery");
    expect(fetched.filter((u) => u === rootPrm)).toHaveLength(1);
  });

  it("mcp-auth waits for the shared discovery and reuses its PRM fetch instead of resolving on its own first", async () => {
    const rootPrm = "https://example.com/.well-known/oauth-protected-resource";
    routeFetch((url) => {
      if (url === "https://example.com/api/")
        return unauthorized(`Bearer resource_metadata="${rootPrm}"`);
      if (url === rootPrm)
        return jsonResp({ resource: "https://example.com", authorization_servers: [AUTH0] });
      if (url === `${AUTH0}.well-known/oauth-authorization-server`) return jsonResp(auth0As);
      return undefined;
    });
    const meta = {
      ...mcpMeta(401, `Bearer resource_metadata="${rootPrm}"`, "https://example.com/mcp"),
      baseUrl: "https://example.com",
    };
    const r = await runChecks(["mcp-auth"], meta);
    expect(r["mcp-auth"]).toMatchObject({ status: "skip", score: 0 });
    expect(fetched.filter((u) => u === rootPrm)).toHaveLength(1);
    expect(fetched.indexOf("https://example.com/api/")).toBeLessThan(fetched.indexOf(rootPrm));
  });

  it("a root PRM the crawler already retrieved is not fetched again for mcp-auth", async () => {
    const rootPrm = "https://example.com/.well-known/oauth-protected-resource";
    const rootDoc = { resource: "https://example.com", authorization_servers: [AUTH0] };
    routeFetch((url) => {
      if (url === rootPrm) return jsonResp(rootDoc);
      if (url === `${AUTH0}.well-known/oauth-authorization-server`) return jsonResp(auth0As);
      return undefined;
    });
    const base = mcpMeta(401, `Bearer resource_metadata="${rootPrm}"`, "https://example.com/mcp");
    const meta = {
      ...base,
      baseUrl: "https://example.com",
      wellKnown: { "oauth-protected-resource": JSON.stringify(rootDoc) },
    };
    const r = await runChecks(["oauth-discovery", "mcp-auth"], meta);
    expect(r["oauth-discovery"].status).toBe("pass");
    expect(r["mcp-auth"]).toMatchObject({ status: "skip", score: 0 });
    expect(fetched).not.toContain(rootPrm);
  });

  it("scores separately when the MCP endpoint has its own PRM document", async () => {
    const rootPrm = "https://example.com/.well-known/oauth-protected-resource";
    const mcpPrm = "https://example.com/.well-known/oauth-protected-resource/mcp";
    routeFetch((url) => {
      if (url === "https://example.com/api/")
        return unauthorized(`Bearer resource_metadata="${rootPrm}"`);
      if (url === rootPrm)
        return jsonResp({ resource: "https://example.com", authorization_servers: [AUTH0] });
      if (url === mcpPrm)
        return jsonResp({ resource: "https://example.com/mcp", authorization_servers: [AUTH0] });
      if (url === `${AUTH0}.well-known/oauth-authorization-server`) return jsonResp(auth0As);
      return undefined;
    });
    const meta = {
      ...mcpMeta(401, `Bearer resource_metadata="${mcpPrm}"`, "https://example.com/mcp"),
      baseUrl: "https://example.com",
    };
    const r = await runChecks(["oauth-discovery", "mcp-auth"], meta);
    expect(r["oauth-discovery"]).toMatchObject({ status: "pass", score: 100 });
    expect(r["oauth-discovery"].message).toContain(rootPrm);
    expect(r["mcp-auth"]).toMatchObject({ status: "pass", score: 100 });
    expect(r["mcp-auth"].message).toContain(mcpPrm);
  });
});

describe("agent-auth: cimd-support (bonus)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pass only when the chain resolves and the AS advertises client_id_metadata_document_supported", async () => {
    routeFetch(auth0Site({ as: { ...auth0As, client_id_metadata_document_supported: true } }));
    expect((await runChecks(["cimd-support"], baseMeta))["cimd-support"]).toMatchObject({
      status: "pass",
      score: 100,
      weight: 0.5,
    });
  });

  it.each([
    [
      "the AS offers only a registration_endpoint",
      auth0Site({ as: { ...auth0As, registration_endpoint: `${AUTH0}register` } }),
    ],
    [
      "the chain is partial even though the AS advertises CIMD",
      auth0Site({
        as: { issuer: AUTH0, client_id_metadata_document_supported: true },
      }),
    ],
    ["there is no OAuth at all", () => undefined],
  ])("skip (never in the denominator) when %s", async (_label, route) => {
    routeFetch(route as Route);
    expect((await runChecks(["cimd-support"], baseMeta))["cimd-support"]).toMatchObject({
      status: "skip",
      score: 0,
    });
  });
});

// --- D1 agent-operator-signing (tracked) ---
// Observed live: GET https://chatgpt.com/.well-known/http-message-signatures-directory
const CHATGPT_SIGNING_DIRECTORY =
  '{"keys":[{"crv":"Ed25519","kty":"OKP","x":"7F_3jDlxaquwh291MiACkcS3Opq88NksyHiakzS-Y1g","kid":"otMqcjr17mGyruktGvJU8oojQTSMHlVm7uO-lrcqbdg","use":"sig","nbf":1735689600,"exp":1789960723}],"signature_agent":"https://chatgpt.com","purpose":"ai"}';

describe("agent-auth: D1 agent-operator-signing (tracked)", () => {
  const check = agentAuthChecks.find((c) => c.id === "agent-operator-signing")!;
  const withDir = (body: string, baseUrl = "https://chatgpt.com"): SiteMetadata => ({
    baseUrl,
    wellKnown: { "http-message-signatures-directory": body },
  });
  const chatgptWith = (patch: Record<string, unknown>) =>
    JSON.stringify({ ...JSON.parse(CHATGPT_SIGNING_DIRECTORY), ...patch });

  it("is tracked with weight 0 — the directory belongs to the bot operator, not the audited site", () => {
    expect(check).toMatchObject({ tracked: true, weight: 0, category: "agent-auth" });
    expect(agentAuthChecks.map((c) => c.id)).not.toContain("web-bot-auth-directory");
  });

  it("pass for ChatGPT's live directory audited at its own origin", () => {
    expect(check.run([basePage], withDir(CHATGPT_SIGNING_DIRECTORY))).toMatchObject({
      status: "pass",
      score: 100,
    });
  });

  it.each([
    "https://example.com",
    "https://www.chatgpt.com",
  ])("fail when signature_agent is another origin than the audited site (%s)", (baseUrl) => {
    expect(check.run([basePage], withDir(CHATGPT_SIGNING_DIRECTORY, baseUrl))).toMatchObject({
      status: "fail",
      score: 0,
    });
  });

  it.each([
    ["missing signature_agent", { signature_agent: undefined }],
    ["unparseable signature_agent", { signature_agent: "chatgpt" }],
    ["RSA key only", { keys: [{ kty: "RSA", n: "abc", e: "AQAB" }] }],
    ["OKP key without x", { keys: [{ kty: "OKP", crv: "Ed25519" }] }],
    ["X25519 key", { keys: [{ kty: "OKP", crv: "X25519", x: "abc" }] }],
    ["empty keys", { keys: [] }],
  ])("fail 0 on an incomplete directory: %s", (_label, patch) => {
    expect(check.run([basePage], withDir(chatgptWith(patch)))).toMatchObject({
      status: "fail",
      score: 0,
    });
  });

  it.each([
    "{}",
    '{"error":"not found","path":"/.well-known/http-message-signatures-directory"}',
    "[]",
  ])("fail 0 on a non-directory JSON body (%s)", (body) => {
    expect(check.run([basePage], withDir(body))).toMatchObject({ status: "fail", score: 0 });
  });

  it("skip (not reported as a failure) when the site publishes no directory", () => {
    expect(check.run([basePage], baseMeta)).toMatchObject({ status: "skip", score: 0 });
  });
});

// --- D2 api-catalog-rfc9727 ---
// Observed live: GET https://developers.cloudflare.com/.well-known/api-catalog
const CLOUDFLARE_API_CATALOG =
  '{"linkset":[{"anchor":"https://developers.cloudflare.com/api/","service-desc":[{"href":"https://developers.cloudflare.com/openapi.json","type":"application/json"}],"service-doc":[{"href":"https://developers.cloudflare.com/api/","type":"text/html"}],"status":[{"href":"https://www.cloudflarestatus.com/api/v2/status.json","type":"application/json"}]}]}';

describe("agent-auth: D2 api-catalog-rfc9727", () => {
  const check = agentAuthChecks.find((c) => c.id === "api-catalog-rfc9727")!;
  const withCatalog = (body: unknown): SiteMetadata => ({
    ...baseMeta,
    wellKnown: { "api-catalog": typeof body === "string" ? body : JSON.stringify(body) },
  });
  const entry = { anchor: "https://example.com/api/", item: [{ href: "https://example.com/v1" }] };

  it("pass for Cloudflare's live RFC 9727 linkset", () => {
    expect(check.run([basePage], withCatalog(CLOUDFLARE_API_CATALOG))).toMatchObject({
      status: "pass",
      score: 100,
    });
  });

  it("pass with one valid API entry even when a sibling link context carries no API relation", () => {
    const meta = withCatalog({
      linkset: [{ anchor: "https://example.com/", status: [{ href: "https://s.example" }] }, entry],
    });
    expect(check.run([basePage], meta)).toMatchObject({ status: "pass", score: 100 });
  });

  it.each([
    [
      "the invented apis[] format",
      { apis: [{ name: "Users API", url: "https://example.com/api" }] },
    ],
    ["an empty apis[]", { apis: [] }],
    ["no linkset", {}],
    ["a JSON catch-all body", { error: "not found", path: "/.well-known/api-catalog" }],
    ["linkset not an array", { linkset: entry }],
    ["an empty linkset", { linkset: [] }],
    ["an entry without anchor", { linkset: [{ item: [{ href: "https://example.com/v1" }] }] }],
    ["an entry with only an anchor", { linkset: [{ anchor: "https://example.com/api/" }] }],
    [
      "only non-API relations",
      { linkset: [{ anchor: "https://x/", status: [{ href: "https://s" }] }] },
    ],
    ["an item target without href", { linkset: [{ anchor: "https://x/", item: [{ type: "a" }] }] }],
    ["an empty service-desc", { linkset: [{ anchor: "https://x/", "service-desc": [] }] }],
  ])("fail 0 for %s", (_label, body) => {
    expect(check.run([basePage], withCatalog(body))).toMatchObject({ status: "fail", score: 0 });
  });

  it("fail when the crawler did not accept the file", () => {
    expect(check.run([basePage], baseMeta)).toMatchObject({ status: "fail", score: 0 });
  });

  it("messages describe the RFC 9727 linkset, not the invented apis[] format", () => {
    for (const meta of [baseMeta, withCatalog({ apis: [] }), withCatalog({ linkset: [] })]) {
      expect(check.run([basePage], meta).message).not.toMatch(/apis/);
    }
  });
});

// --- meta: check registry ---
describe("agent-auth: check registry", () => {
  const EXPECTED_IDS = [
    "public-api",
    "openapi-spec",
    "developer-portal",
    "agent-auth-docs",
    "oauth-discovery",
    "scoped-permissions",
    "pkce-s256",
    "mcp-auth",
    "cimd-support",
    "agent-operator-signing",
    "api-catalog-rfc9727",
  ];

  it("exports exactly the expected checks, with the six v2 OAuth/MCP-auth ids retired and mcp-server-card moved to agent-discovery", () => {
    expect(agentAuthChecks.map((c) => c.id).sort()).toEqual([...EXPECTED_IDS].sort());
    for (const retired of [
      "oauth-support",
      "oauth-protected-resource",
      "oauth-metadata-rfc9728",
      "mcp-auth-mechanism",
      "mcp-oauth-metadata",
      "mcp-pkce-s256",
    ]) {
      expect(agentAuthChecks.map((c) => c.id)).not.toContain(retired);
    }
  });

  it("all checks have category agent-auth", () => {
    for (const c of agentAuthChecks) {
      expect(c.category).toBe("agent-auth");
    }
  });

  it("scored weights (excluding the cimd-support bonus) sum to 16.5", () => {
    const weights = Object.fromEntries(agentAuthChecks.map((c) => [c.id, c.weight]));
    expect(weights).toMatchObject({
      "oauth-discovery": 3,
      "pkce-s256": 1.5,
      "mcp-auth": 1.5,
      "cimd-support": 0.5,
    });
    const sum = agentAuthChecks
      .filter((c) => !c.tracked && c.id !== "cimd-support")
      .reduce((total, c) => total + c.weight, 0);
    expect(sum).toBe(16.5);
  });
});
