import { describe, expect, it } from "vitest";
import { parseMcpResourceLink, parseOAuthMetadata } from "../../src/audit/shared/oauth-parser.js";

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

  it("returns object with undefined fields when optional fields are missing", () => {
    const result = parseOAuthMetadata("{}");
    expect(result).not.toBeNull();
    expect(result?.issuer).toBeUndefined();
    expect(result?.authorizationEndpoint).toBeUndefined();
    expect(result?.raw).toEqual({});
  });

  it("filters non-string entries from array fields", () => {
    const json = JSON.stringify({
      scopes_supported: ["openid", 42, null, "profile"],
      code_challenge_methods_supported: [true, "S256"],
    });
    const result = parseOAuthMetadata(json);
    expect(result?.scopesSupported).toEqual(["openid", "profile"]);
    expect(result?.codeChallengeMethodsSupported).toEqual(["S256"]);
  });
});

describe("parseMcpResourceLink", () => {
  it("returns empty rels for undefined input", () => {
    expect(parseMcpResourceLink(undefined)).toEqual({ rels: [] });
  });

  it("parses single rel=resource_metadata and sets resourceMetadataUrl", () => {
    const header =
      '<https://example.com/.well-known/oauth-protected-resource>; rel="resource_metadata"';
    const result = parseMcpResourceLink(header);
    expect(result.resourceMetadataUrl).toBe(
      "https://example.com/.well-known/oauth-protected-resource",
    );
    expect(result.rels).toHaveLength(1);
  });

  it("parses multiple comma-separated rels", () => {
    const header =
      '<https://example.com/.well-known/oauth-protected-resource>; rel="resource_metadata", <https://example.com/other>; rel="related"';
    const result = parseMcpResourceLink(header);
    expect(result.rels).toHaveLength(2);
    expect(result.resourceMetadataUrl).toBe(
      "https://example.com/.well-known/oauth-protected-resource",
    );
  });

  it("returns undefined resourceMetadataUrl when no resource_metadata rel present", () => {
    const header = '<https://example.com/other>; rel="related"';
    const result = parseMcpResourceLink(header);
    expect(result.resourceMetadataUrl).toBeUndefined();
    expect(result.rels).toHaveLength(1);
  });
});
