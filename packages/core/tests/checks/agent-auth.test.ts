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
  ])("fail when the body is not a JSON object (%s) — a catch-all must not earn credit", (body) => {
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

// --- D1 web-bot-auth-directory ---
describe("agent-auth: D1 web-bot-auth-directory", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pass when valid JSON directory found", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("http-message-signatures-directory"))
        return jsonResp({ algorithms: ["rsa-pss-sha512"] });
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "web-bot-auth-directory")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
  });

  it("fail when 200 but not JSON (soft-404 page)", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("http-message-signatures-directory"))
        return new Response("not json", { status: 200 });
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "web-bot-auth-directory")!;
    const result = await check.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });

  it("fail when 404", async () => {
    globalThis.fetch = mockFetch(() => notFound());
    const check = agentAuthChecks.find((c) => c.id === "web-bot-auth-directory")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("fail");
  });
});

// --- D2 api-catalog-rfc9727 ---
describe("agent-auth: D2 api-catalog-rfc9727", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pass when apis array with name+url entries", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("api-catalog"))
        return jsonResp({ apis: [{ name: "Users API", url: "https://example.com/api/users" }] });
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "api-catalog-rfc9727")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
    expect(result.score).toBe(100);
  });

  it("partial when catalog present but missing required fields", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("api-catalog")) return jsonResp({ apis: [{ name: "Users API" }] });
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "api-catalog-rfc9727")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("partial");
  });

  it("fail when 404", async () => {
    globalThis.fetch = mockFetch(() => notFound());
    const check = agentAuthChecks.find((c) => c.id === "api-catalog-rfc9727")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("fail");
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
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("pass when mcp.json has name+version+capabilities", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("mcp.json"))
        return jsonResp({ name: "MyMCP", version: "1.0.0", capabilities: { tools: true } });
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "mcp-server-card")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("pass");
  });

  it("partial when mcp.json missing capabilities", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("mcp.json")) return jsonResp({ name: "MyMCP", version: "1.0.0" });
      return notFound();
    });
    const check = agentAuthChecks.find((c) => c.id === "mcp-server-card")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("partial");
  });

  it("fail when 404", async () => {
    globalThis.fetch = mockFetch(() => notFound());
    const check = agentAuthChecks.find((c) => c.id === "mcp-server-card")!;
    const result = await check.run([basePage], baseMeta);
    expect(result.status).toBe("fail");
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
    "web-bot-auth-directory",
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
