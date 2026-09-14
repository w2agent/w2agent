import { afterEach, describe, expect, it, vi } from "vitest";
import { agentAuthChecks } from "../../src/audit/checks/agent-auth.js";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";

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

// --- B1 oauth-support ---
describe("agent-auth: B1 oauth-support", () => {
  const check = agentAuthChecks.find((c) => c.id === "oauth-support")!;

  it("pass when metadata has issuer + endpoints", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      wellKnown: {
        "oauth-authorization-server": JSON.stringify({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        }),
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "pass" });
  });

  it("partial when metadata is present but missing token_endpoint", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      wellKnown: {
        "oauth-authorization-server": JSON.stringify({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
        }),
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "partial" });
  });

  it("fail when no oauth-authorization-server wellKnown", () => {
    expect(check.run([basePage], baseMeta)).toMatchObject({ status: "fail", score: 0 });
  });
});

// --- B2 oauth-protected-resource ---
describe("agent-auth: B2 oauth-protected-resource", () => {
  const check = agentAuthChecks.find((c) => c.id === "oauth-protected-resource")!;

  it("pass when valid JSON object present", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      wellKnown: { "oauth-protected-resource": '{"resource": "https://example.com"}' },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "pass" });
  });

  it.each([
    "{not valid json",
    "[]",
    "null",
    '"string"',
    "{}",
    '{"resource":42}',
    '{"error":"not found","path":"/.well-known/oauth-protected-resource"}',
  ])("fail when the body is not an object with a string resource (%s) — a catch-all must not earn credit", (body) => {
    const meta: SiteMetadata = {
      ...baseMeta,
      wellKnown: { "oauth-protected-resource": body },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "fail", score: 0 });
  });

  it("fail when wellKnown entry is undefined", () => {
    expect(check.run([basePage], baseMeta)).toMatchObject({ status: "fail" });
  });
});

// --- B3 oauth-metadata-rfc9728 ---
describe("agent-auth: B3 oauth-metadata-rfc9728", () => {
  const check = agentAuthChecks.find((c) => c.id === "oauth-metadata-rfc9728")!;

  it("pass when linkHeader + oauthResourceMetadataUrl + wellKnown all set", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: false,
        status: 401,
        linkHeader:
          '<https://example.com/.well-known/oauth-protected-resource>; rel="resource_metadata"',
        oauthResourceMetadataUrl: "https://example.com/.well-known/oauth-protected-resource",
      },
      wellKnown: { "oauth-protected-resource": '{"resource": "x"}' },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "pass" });
  });

  it("partial when linkHeader present but no target in wellKnown", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: false,
        status: 401,
        linkHeader:
          '<https://example.com/.well-known/oauth-protected-resource>; rel="resource_metadata"',
        oauthResourceMetadataUrl: "https://example.com/.well-known/oauth-protected-resource",
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "partial" });
  });

  it("fail when no linkHeader", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: true,
        status: 200,
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "fail" });
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

// --- B5 pkce-s256 ---
describe("agent-auth: B5 pkce-s256", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pass when S256 in oauth metadata", async () => {
    const check = agentAuthChecks.find((c) => c.id === "pkce-s256")!;
    const meta: SiteMetadata = {
      ...baseMeta,
      wellKnown: {
        "oauth-authorization-server": JSON.stringify({
          issuer: "https://auth.example.com",
          code_challenge_methods_supported: ["S256", "plain"],
        }),
      },
    };
    globalThis.fetch = mockFetch(() => notFound());
    const result = await check.run([basePage], meta);
    expect(result.status).toBe("pass");
  });

  it("partial when PKCE+S256 mentioned in docs only", async () => {
    const check = agentAuthChecks.find((c) => c.id === "pkce-s256")!;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/api"))
        return htmlResp("<html><body>Use PKCE with S256 for security</body></html>");
      return notFound();
    });
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("partial");
  });

  it("fail when no PKCE support found", async () => {
    const check = agentAuthChecks.find((c) => c.id === "pkce-s256")!;
    globalThis.fetch = mockFetch(() => notFound());
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("fail");
  });
});

// --- C1 mcp-auth-mechanism ---
describe("agent-auth: C1 mcp-auth-mechanism", () => {
  const check = agentAuthChecks.find((c) => c.id === "mcp-auth-mechanism")!;

  it("pass when authMechanism declared in serverInfo", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: true,
        serverInfo: { name: "test", authMechanism: "OAuth2" },
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "pass" });
  });

  it("pass when 401 + WWW-Authenticate present", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: false,
        status: 401,
        rawHeaders: { "www-authenticate": "Bearer realm=example" },
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "pass" });
  });

  it("partial when 401 but no WWW-Authenticate", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: false,
        status: 401,
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "partial" });
  });

  it("fail when no auth signals and mcpInit success", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: true,
        status: 200,
        serverInfo: { name: "test" },
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "fail" });
  });
});

// --- C2 mcp-oauth-metadata ---
describe("agent-auth: C2 mcp-oauth-metadata", () => {
  const check = agentAuthChecks.find((c) => c.id === "mcp-oauth-metadata")!;

  it("pass when linkHeader + resourceMetadataUrl + wellKnown set", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: false,
        status: 401,
        linkHeader:
          '<https://example.com/.well-known/oauth-protected-resource>; rel="resource_metadata"',
      },
      wellKnown: { "oauth-protected-resource": '{"resource": "x"}' },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "pass" });
  });

  it("partial when linkHeader present but target missing from wellKnown", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: false,
        status: 401,
        linkHeader:
          '<https://example.com/.well-known/oauth-protected-resource>; rel="resource_metadata"',
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "partial" });
  });

  it("fail when no linkHeader", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: true,
        status: 200,
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "fail" });
  });
});

// --- C3 mcp-pkce-s256 ---
describe("agent-auth: C3 mcp-pkce-s256", () => {
  const check = agentAuthChecks.find((c) => c.id === "mcp-pkce-s256")!;

  it("pass when C2 link present + S256 in oauth metadata", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: false,
        status: 401,
        linkHeader:
          '<https://example.com/.well-known/oauth-protected-resource>; rel="resource_metadata"',
      },
      wellKnown: {
        "oauth-authorization-server": JSON.stringify({
          issuer: "https://auth.example.com",
          code_challenge_methods_supported: ["S256"],
        }),
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "pass" });
  });

  it("fail when C2 link present but no S256 in oauth metadata", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: false,
        status: 401,
        linkHeader:
          '<https://example.com/.well-known/oauth-protected-resource>; rel="resource_metadata"',
      },
      wellKnown: {
        "oauth-authorization-server": JSON.stringify({
          issuer: "https://auth.example.com",
          code_challenge_methods_supported: ["plain"],
        }),
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "fail" });
  });

  it("fail when no MCP resource metadata link", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      mcpInit: {
        mcpEndpointUrl: "https://example.com/.well-known/mcp",
        success: true,
        status: 200,
      },
    };
    expect(check.run([basePage], meta)).toMatchObject({ status: "fail" });
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

// --- D3 agent-allowlist ---
describe("agent-auth: D3 agent-allowlist", () => {
  const check = agentAuthChecks.find((c) => c.id === "agent-allowlist")!;

  const robotsWithAllows = `
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: *
Disallow:
`.trim();

  const robotsBlock = `
User-agent: *
Disallow: /
`.trim();

  it("pass when >= 3 AI bots explicitly allowed", () => {
    const meta: SiteMetadata = { ...baseMeta, robotsTxt: robotsWithAllows };
    expect(check.run([basePage], meta)).toMatchObject({ status: "pass" });
  });

  it("partial when 1-2 AI bots allowed", () => {
    const robots = "User-agent: GPTBot\nAllow: /\n\nUser-agent: *\nDisallow:";
    const meta: SiteMetadata = { ...baseMeta, robotsTxt: robots };
    expect(check.run([basePage], meta)).toMatchObject({ status: "partial" });
  });

  it("fail when catch-all blocks all bots", () => {
    const meta: SiteMetadata = { ...baseMeta, robotsTxt: robotsBlock };
    expect(check.run([basePage], meta)).toMatchObject({ status: "fail" });
  });

  it("fail when no robots.txt", () => {
    expect(check.run([basePage], baseMeta)).toMatchObject({ status: "fail" });
  });
});

// --- D4 mcp-server-card ---
describe("agent-auth: D4 mcp-server-card", () => {
  const check = agentAuthChecks.find((c) => c.id === "mcp-server-card")!;
  const withCard = (body: unknown): SiteMetadata => ({
    ...baseMeta,
    wellKnown: { "mcp.json": JSON.stringify(body) },
  });

  it("pass when mcp.json has name+version+capabilities", () => {
    const meta = withCard({ name: "MyMCP", version: "1.0.0", capabilities: { tools: true } });
    expect(check.run([basePage], meta)).toMatchObject({ status: "pass", score: 100 });
  });

  it("partial when mcp.json has name+version but no capabilities", () => {
    const meta = withCard({ name: "MyMCP", version: "1.0.0" });
    expect(check.run([basePage], meta)).toMatchObject({ status: "partial", score: 50 });
  });

  it.each([
    {},
    { error: "not found", path: "/.well-known/mcp.json" },
    { name: "MyMCP", capabilities: { tools: true } },
    { version: "1.0.0", capabilities: { tools: true } },
  ])("fail 0 without both name and version (%j) — not partial", (body) => {
    expect(check.run([basePage], withCard(body))).toMatchObject({ status: "fail", score: 0 });
  });

  it("fail when the crawler did not accept the file", () => {
    expect(check.run([basePage], baseMeta)).toMatchObject({ status: "fail", score: 0 });
  });
});

// --- meta: all 16 check IDs exported ---
describe("agent-auth: check registry", () => {
  const EXPECTED_IDS = [
    "public-api",
    "openapi-spec",
    "developer-portal",
    "agent-auth-docs",
    "oauth-support",
    "oauth-protected-resource",
    "oauth-metadata-rfc9728",
    "scoped-permissions",
    "pkce-s256",
    "mcp-auth-mechanism",
    "mcp-oauth-metadata",
    "mcp-pkce-s256",
    "agent-operator-signing",
    "api-catalog-rfc9727",
    "agent-allowlist",
    "mcp-server-card",
  ];

  it("exports all 16 checks", () => {
    expect(agentAuthChecks).toHaveLength(16);
  });

  it("all checks have category agent-auth", () => {
    for (const c of agentAuthChecks) {
      expect(c.category).toBe("agent-auth");
    }
  });

  it("all 16 spec IDs are present", () => {
    const ids = agentAuthChecks.map((c) => c.id);
    for (const expected of EXPECTED_IDS) {
      expect(ids).toContain(expected);
    }
  });
});
