import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asMetadataUrls,
  discoverOAuth,
  resolveProtectedResource,
  resourceMatches,
  sameIssuer,
  wellKnownPrmUrls,
} from "../../src/audit/shared/oauth-discovery.js";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let urls: string[] = [];
function mockFetch(route: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  urls = [];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    return route(url, init);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resourceMatches (MCP SDK checkResourceAllowed)", () => {
  it.each([
    ["https://mcp.stripe.com/", "https://mcp.stripe.com"],
    ["https://example.com/api/", "https://example.com/api"],
    ["https://example.com/api/v1", "https://example.com/api"],
    ["https://example.com/mcp", "https://example.com/"],
  ])("%s is covered by resource %s", (requested, configured) => {
    expect(resourceMatches(requested, configured)).toBe(true);
  });

  it.each([
    ["https://example.com/api/", "https://other.example/api", "another origin"],
    ["https://example.com/api/", "http://example.com/api", "another scheme"],
    ["https://example.com/api/", "https://example.com:8443/api", "another port"],
    ["https://example.com/api/", "https://example.com/apiv2", "a sibling path sharing a prefix"],
    ["https://example.com/api123", "https://example.com/api", "a longer sibling segment"],
    ["https://example.com/", "https://example.com/api", "a narrower configured path"],
    [
      "https://example.com/api",
      "https://example.com/api/",
      "a configured path longer than the request",
    ],
    ["https://example.com/api/", "not a url", "an unparseable resource"],
  ])("%s is not covered by %s (%s)", (requested, configured) => {
    expect(resourceMatches(requested, configured)).toBe(false);
  });
});

describe("sameIssuer", () => {
  it("treats an origin with and without the trailing slash as the same identifier", () => {
    expect(sameIssuer("https://tenant.auth0.com", "https://tenant.auth0.com/")).toBe(true);
  });

  it.each([
    ["https://access.stripe.com/mcp", "https://access.stripe.com/mcp/"],
    ["https://idp.example:443/tenant", "https://idp.example/tenant"],
    ["https://idp.example:443", "https://idp.example/"],
    ["https://IDP.example/tenant", "https://idp.example/tenant"],
    ["HTTPS://idp.example", "https://idp.example"],
    ["https://honest.example", "https://attacker.example"],
    ["https://as.example/tenant1", "https://as.example/tenant2"],
    ["https://as.example", "not a url"],
  ])("%s and %s differ", (a, b) => {
    expect(sameIssuer(a, b)).toBe(false);
  });
});

describe("well-known URL construction", () => {
  it("PRM: path-inserted first, then root; root only for a path-less resource", () => {
    expect(wellKnownPrmUrls("https://example.com/public/mcp")).toEqual([
      "https://example.com/.well-known/oauth-protected-resource/public/mcp",
      "https://example.com/.well-known/oauth-protected-resource",
    ]);
    expect(wellKnownPrmUrls("https://example.com/api/")).toEqual([
      "https://example.com/.well-known/oauth-protected-resource/api",
      "https://example.com/.well-known/oauth-protected-resource",
    ]);
    expect(wellKnownPrmUrls("https://mcp.stripe.com/")).toEqual([
      "https://mcp.stripe.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("AS metadata for an issuer with a path: RFC 8414 insertion, OIDC insertion, OIDC appending", () => {
    expect(asMetadataUrls("https://auth.example.com/tenant1")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
  });

  it.each([
    "https://example.us.auth0.com",
    "https://example.us.auth0.com/",
  ])("AS metadata for a path-less issuer (%s): RFC 8414 then OIDC", (issuer) => {
    expect(asMetadataUrls(issuer)).toEqual([
      "https://example.us.auth0.com/.well-known/oauth-authorization-server",
      "https://example.us.auth0.com/.well-known/openid-configuration",
    ]);
  });
});

const PRM_URL = "https://example.com/.well-known/oauth-protected-resource/api";
const AS = "https://login.example-idp.com/";
const API = { url: "https://example.com/api/", status: 401 };
const challenge = { ...API, wwwAuthenticate: `Bearer resource_metadata="${PRM_URL}"` };
const prm = { resource: "https://example.com/api", authorization_servers: [AS] };
const asMeta = {
  issuer: AS,
  authorization_endpoint: `${AS}authorize`,
  token_endpoint: `${AS}token`,
};

describe("discoverOAuth chain", () => {
  it("follows the Bearer resource_metadata link and does not probe well-known PRM paths", async () => {
    mockFetch((url) => {
      if (url === PRM_URL) return json(prm);
      if (url === `${AS}.well-known/oauth-authorization-server`) return json(asMeta);
      return json({}, 404);
    });
    const d = await discoverOAuth({ baseUrl: "https://example.com", resourceProbes: [challenge] });
    expect(d).toMatchObject({ outcome: "full", prmUrl: PRM_URL, as: { issuer: AS } });
    expect(urls).toEqual([PRM_URL, `${AS}.well-known/oauth-authorization-server`]);
  });

  it("401 without resource_metadata falls back to the path-inserted then root well-known PRM", async () => {
    const root = "https://example.com/.well-known/oauth-protected-resource";
    mockFetch((url) => {
      if (url === root)
        return json({ resource: "https://example.com", authorization_servers: [AS] });
      if (url === `${AS}.well-known/oauth-authorization-server`) return json(asMeta);
      return json({}, 404);
    });
    const d = await discoverOAuth({
      baseUrl: "https://example.com",
      resourceProbes: [{ ...API, wwwAuthenticate: 'Basic realm="api"' }],
    });
    expect(d).toMatchObject({ outcome: "full", prmUrl: root });
    expect(urls.slice(0, 2)).toEqual([PRM_URL, root]);
  });

  it("an API response that is not a 401 starts no chain", async () => {
    const spy = mockFetch(() => json(prm));
    const d = await discoverOAuth({
      baseUrl: "https://example.com",
      resourceProbes: [{ ...challenge, status: 200 }],
    });
    expect(d.outcome).toBe("none");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a PRM served without a JSON content-type is not retrieved", async () => {
    mockFetch((url) =>
      url === PRM_URL
        ? new Response(JSON.stringify(prm), { headers: { "content-type": "text/html" } })
        : json({}, 404),
    );
    const d = await discoverOAuth({ baseUrl: "https://example.com", resourceProbes: [challenge] });
    expect(d.outcome).toBe("none");
    expect(d.problems.join(" ")).toContain("could not be retrieved");
  });

  it("an issuer mismatch is not used, even when the document is otherwise complete", async () => {
    mockFetch((url) => {
      if (url === PRM_URL) return json(prm);
      if (url.startsWith(AS)) return json({ ...asMeta, issuer: "https://honest.example" });
      return json({}, 404);
    });
    const d = await discoverOAuth({ baseUrl: "https://example.com", resourceProbes: [challenge] });
    expect(d.outcome).toBe("prm-only");
    expect(d.as).toBeUndefined();
    expect(d.problems.join(" ")).toContain("expected https://login.example-idp.com/");
  });

  it("an issuer-matched AS without both endpoints is not exposed as the resolved AS", async () => {
    mockFetch((url) => {
      if (url === PRM_URL) return json(prm);
      if (url === `${AS}.well-known/oauth-authorization-server`)
        return json({ issuer: AS, code_challenge_methods_supported: ["S256"] });
      return json({}, 404);
    });
    const d = await discoverOAuth({ baseUrl: "https://example.com", resourceProbes: [challenge] });
    expect(d.outcome).toBe("prm-only");
    expect(d.as).toBeUndefined();
  });

  it("an incomplete RFC 8414 document does not stop the walk: a complete openid-configuration is used", async () => {
    mockFetch((url) => {
      if (url === PRM_URL) return json(prm);
      if (url === `${AS}.well-known/oauth-authorization-server`) return json({ issuer: AS });
      if (url === `${AS}.well-known/openid-configuration`) return json(asMeta);
      return json({}, 404);
    });
    const d = await discoverOAuth({ baseUrl: "https://example.com", resourceProbes: [challenge] });
    expect(d).toMatchObject({
      outcome: "full",
      as: { tokenEndpoint: asMeta.token_endpoint },
      asMetadataUrl: `${AS}.well-known/openid-configuration`,
    });
  });

  it("a PRM rejected for one resource is still validated for a later resource it covers", async () => {
    const shared = "https://example.com/.well-known/oauth-protected-resource/mcp";
    mockFetch((url) => {
      if (url === shared)
        return json({ resource: "https://example.com/mcp", authorization_servers: [AS] });
      if (url === `${AS}.well-known/oauth-authorization-server`) return json(asMeta);
      return json({}, 404);
    });
    const header = `Bearer resource_metadata="${shared}"`;
    const d = await discoverOAuth({
      baseUrl: "https://example.com",
      resourceProbes: [
        { ...API, wwwAuthenticate: header },
        { url: "https://example.com/mcp", status: 401, wwwAuthenticate: header },
      ],
    });
    expect(d).toMatchObject({
      outcome: "full",
      prmUrl: shared,
      resourceUrl: "https://example.com/mcp",
    });
    expect(urls.filter((u) => u === shared)).toHaveLength(1);
  });

  it("a later resource probe that resolves fully wins over an earlier partial one", async () => {
    const mcpPrm = "https://mcp.example.com/.well-known/oauth-protected-resource";
    const good = "https://as.good.example";
    mockFetch((url) => {
      if (url === PRM_URL) return json(prm);
      if (url === mcpPrm)
        return json({ resource: "https://mcp.example.com", authorization_servers: [good] });
      if (url === `${good}/.well-known/oauth-authorization-server`)
        return json({ ...asMeta, issuer: good });
      return json({}, 404);
    });
    const d = await discoverOAuth({
      baseUrl: "https://example.com",
      resourceProbes: [
        challenge,
        {
          url: "https://mcp.example.com/",
          status: 401,
          wwwAuthenticate: `Bearer resource_metadata="${mcpPrm}"`,
        },
      ],
    });
    expect(d).toMatchObject({
      outcome: "full",
      prmUrl: mcpPrm,
      resourceUrl: "https://mcp.example.com/",
    });
  });

  it("tries the next authorization server when the first does not resolve", async () => {
    const second = "https://as2.example.com";
    mockFetch((url) => {
      if (url === PRM_URL) return json({ ...prm, authorization_servers: [AS, second] });
      if (url === `${second}/.well-known/oauth-authorization-server`)
        return json({ ...asMeta, issuer: second });
      return json({}, 404);
    });
    const d = await discoverOAuth({ baseUrl: "https://example.com", resourceProbes: [challenge] });
    expect(d).toMatchObject({ outcome: "full", as: { issuer: second } });
  });

  it("an off-origin authorization server refused by isAllowedTarget is unresolved and never fetched", async () => {
    mockFetch((url) => (url === PRM_URL ? json(prm) : json(asMeta)));
    const d = await discoverOAuth(
      { baseUrl: "https://example.com", resourceProbes: [challenge] },
      (url) => new URL(url).hostname === "example.com",
    );
    expect(d.outcome).toBe("prm-only");
    expect(urls).toEqual([PRM_URL]);
  });

  it("an off-origin resource_metadata URL refused by isAllowedTarget is never fetched", async () => {
    const offOrigin = "http://169.254.169.254/latest/meta-data";
    mockFetch(() => json(prm));
    const d = await discoverOAuth(
      {
        baseUrl: "https://example.com",
        resourceProbes: [{ ...API, wwwAuthenticate: `Bearer resource_metadata="${offOrigin}"` }],
      },
      (url) => new URL(url).hostname === "example.com",
    );
    expect(d.outcome).toBe("none");
    expect(urls).toEqual([]);
  });

  it("a non-http resource_metadata URL is never fetched", async () => {
    const spy = mockFetch(() => json(prm));
    await discoverOAuth({
      baseUrl: "https://example.com",
      resourceProbes: [
        { ...API, wwwAuthenticate: 'Bearer resource_metadata="file:///etc/passwd"' },
      ],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a hanging authorization server cannot hold the chain past its budget", async () => {
    mockFetch((url) => (url === PRM_URL ? json(prm) : new Promise<Response>(() => {})));
    const started = Date.now();
    const d = await discoverOAuth(
      { baseUrl: "https://example.com", resourceProbes: [challenge] },
      undefined,
      100,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(d).toMatchObject({ outcome: "prm-only", prmUrl: PRM_URL });
  });

  it("each fetch is cut off at the remaining budget, so no request is issued after it is spent", async () => {
    mockFetch((url, init) => {
      if (url === PRM_URL) return json(prm);
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(json({}, 404)), 150);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      });
    });
    const d = await discoverOAuth(
      { baseUrl: "https://example.com", resourceProbes: [challenge] },
      undefined,
      100,
    );
    expect(d.outcome).toBe("prm-only");
    const reported = [...d.problems];
    await new Promise((r) => setTimeout(r, 250));
    expect(urls).toEqual([PRM_URL, `${AS}.well-known/oauth-authorization-server`]);
    expect(d.problems).toEqual(reported);
  });

  it("resolveProtectedResource is bounded by its budget too", async () => {
    mockFetch(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const r = await resolveProtectedResource("https://mcp.example.com/", "Bearer", undefined, 100);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.prm).toBeUndefined();
  });
});
