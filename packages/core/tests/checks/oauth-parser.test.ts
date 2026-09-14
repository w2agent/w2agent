import { describe, expect, it } from "vitest";
import {
  bearerChallenge,
  bearerResourceMetadata,
  parseOAuthMetadata,
  parseProtectedResourceMetadata,
  parseWwwAuthenticate,
} from "../../src/audit/shared/oauth-parser.js";

describe("parseOAuthMetadata", () => {
  it("extracts known fields from valid JSON", () => {
    const json = JSON.stringify({
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      scopes_supported: ["openid", "profile"],
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    });
    const result = parseOAuthMetadata(json);
    expect(result).not.toBeNull();
    expect(result?.issuer).toBe("https://auth.example.com");
    expect(result?.authorizationEndpoint).toBe("https://auth.example.com/authorize");
    expect(result?.tokenEndpoint).toBe("https://auth.example.com/token");
    expect(result?.scopesSupported).toEqual(["openid", "profile"]);
    expect(result?.codeChallengeMethodsSupported).toEqual(["S256"]);
    expect(result?.responseTypesSupported).toEqual(["code"]);
    expect(result?.raw).toBeTruthy();
  });

  it("returns null for undefined input", () => {
    expect(parseOAuthMetadata(undefined)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseOAuthMetadata("{not valid")).toBeNull();
  });

  it.each([
    "[]",
    "42",
    '"issuer"',
    "null",
  ])("returns null for JSON that is not an object (%s) so it cannot score partial", (body) => {
    expect(parseOAuthMetadata(body)).toBeNull();
  });

  it("returns object with undefined fields when optional fields are missing", () => {
    const result = parseOAuthMetadata('{"issuer":"https://auth.example.com"}');
    expect(result).not.toBeNull();
    expect(result?.authorizationEndpoint).toBeUndefined();
    expect(result?.raw).toEqual({ issuer: "https://auth.example.com" });
  });

  it.each([
    "{}",
    '{"issuer":42}',
    '{"error":"not found","path":"/.well-known/oauth-authorization-server"}',
  ])("returns null without a string issuer (%s) so a JSON catch-all cannot score partial", (body) => {
    expect(parseOAuthMetadata(body)).toBeNull();
  });

  it("filters non-string entries from array fields", () => {
    const json = JSON.stringify({
      issuer: "https://auth.example.com",
      scopes_supported: ["openid", 42, null, "profile"],
      code_challenge_methods_supported: [true, "S256"],
    });
    const result = parseOAuthMetadata(json);
    expect(result?.scopesSupported).toEqual(["openid", "profile"]);
    expect(result?.codeChallengeMethodsSupported).toEqual(["S256"]);
  });
});

describe("parseOAuthMetadata client registration fields", () => {
  it("exposes CIMD support only for a literal true, and the DCR registration_endpoint", () => {
    const on = parseOAuthMetadata(
      JSON.stringify({
        issuer: "https://as.example",
        client_id_metadata_document_supported: true,
        registration_endpoint: "https://as.example/register",
      }),
    );
    expect(on).toMatchObject({
      clientIdMetadataDocumentSupported: true,
      registrationEndpoint: "https://as.example/register",
    });
    const truthy = parseOAuthMetadata(
      JSON.stringify({
        issuer: "https://as.example",
        client_id_metadata_document_supported: "true",
      }),
    );
    expect(truthy?.clientIdMetadataDocumentSupported).toBe(false);
  });
});

describe("parseProtectedResourceMetadata", () => {
  it("exposes authorization_servers when it is an array of strings", () => {
    const prm = parseProtectedResourceMetadata(
      JSON.stringify({ resource: "https://example.com", authorization_servers: ["https://as"] }),
    );
    expect(prm).toMatchObject({
      resource: "https://example.com",
      authorizationServers: ["https://as"],
    });
  });

  it.each([
    [{ resource: "https://example.com" }],
    [{ resource: "https://example.com", authorization_servers: "https://as" }],
    [{ resource: "https://example.com", authorization_servers: ["https://as", 42] }],
  ])("leaves authorizationServers undefined when not a string array (%j)", (body) => {
    expect(
      parseProtectedResourceMetadata(JSON.stringify(body))?.authorizationServers,
    ).toBeUndefined();
  });

  it.each([
    "{}",
    '{"resource":42}',
    "[]",
    "{bad",
  ])("returns null without a string resource (%s)", (body) => {
    expect(parseProtectedResourceMetadata(body)).toBeNull();
  });
});

describe("parseWwwAuthenticate (RFC 9110 §11.6.1)", () => {
  const PRM = "https://mcp.stripe.com/.well-known/oauth-protected-resource";

  it("reads an unquoted URL value, as mcp.stripe.com sends it", () => {
    expect(bearerResourceMetadata(`Bearer resource_metadata=${PRM}`)).toBe(PRM);
  });

  it("takes resource_metadata from the first Bearer challenge that carries it, not only the first Bearer", () => {
    expect(
      bearerResourceMetadata("Bearer realm=a, Bearer resource_metadata=https://example.com/prm"),
    ).toBe("https://example.com/prm");
  });

  it("reads quoted values with escapes and several params in one challenge", () => {
    const header = `Bearer error="invalid_token", error_description="say \\"hi\\"", resource_metadata="${PRM}"`;
    expect(parseWwwAuthenticate(header)).toEqual([
      {
        scheme: "Bearer",
        params: { error: "invalid_token", error_description: 'say "hi"', resource_metadata: PRM },
      },
    ]);
  });

  it("splits multiple challenges and finds Bearer after another scheme", () => {
    const header = `Basic realm="x", Bearer resource_metadata="${PRM}", scope="read"`;
    const challenges = parseWwwAuthenticate(header);
    expect(challenges.map((c) => c.scheme)).toEqual(["Basic", "Bearer"]);
    expect(challenges[1].params).toEqual({ resource_metadata: PRM, scope: "read" });
    expect(bearerResourceMetadata(header)).toBe(PRM);
  });

  it("matches the scheme case-insensitively and param names case-insensitively", () => {
    expect(bearerResourceMetadata(`bEaReR Resource_Metadata = "${PRM}"`)).toBe(PRM);
  });

  it("skips token68 credentials without inventing challenges", () => {
    const header = `Negotiate dXNlcg==, Basic abc123, Bearer resource_metadata="${PRM}"`;
    expect(parseWwwAuthenticate(header).map((c) => c.scheme)).toEqual([
      "Negotiate",
      "Basic",
      "Bearer",
    ]);
    expect(bearerResourceMetadata(header)).toBe(PRM);
  });

  it("a Basic-only 401 has no Bearer challenge", () => {
    expect(bearerChallenge('Basic realm="api"')).toBeUndefined();
    expect(bearerResourceMetadata('Basic realm="api"')).toBeUndefined();
  });

  it.each([
    `Basic resource_metadata="${PRM}", Bearer realm="api"`,
    `Digest realm="x", resource_metadata="${PRM}"`,
    `BearerX resource_metadata="${PRM}"`,
  ])("ignores resource_metadata carried by a non-Bearer challenge (%s)", (header) => {
    expect(bearerResourceMetadata(header)).toBeUndefined();
  });

  it("a Bearer challenge without resource_metadata is still a Bearer challenge", () => {
    expect(bearerChallenge('Bearer realm="api"')).toEqual({
      scheme: "Bearer",
      params: { realm: "api" },
    });
    expect(bearerResourceMetadata('Bearer realm="api"')).toBeUndefined();
  });

  it.each([
    undefined,
    "",
    "   ",
    ",,,",
    '"unterminated',
    "==",
  ])("tolerates malformed input (%j)", (header) => {
    expect(() => parseWwwAuthenticate(header)).not.toThrow();
    expect(bearerResourceMetadata(header)).toBeUndefined();
  });
});
