import { parseJsonObject } from "./json.js";

export interface ParsedOAuthMetadata {
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  responseTypesSupported?: string[];
  raw: Record<string, unknown>;
}

export function parseOAuthMetadata(json: string | undefined): ParsedOAuthMetadata | null {
  const o = parseJsonObject(json);
  if (!o || typeof o.issuer !== "string") return null;
  return {
    issuer: o.issuer,
    authorizationEndpoint:
      typeof o.authorization_endpoint === "string" ? o.authorization_endpoint : undefined,
    tokenEndpoint: typeof o.token_endpoint === "string" ? o.token_endpoint : undefined,
    scopesSupported: Array.isArray(o.scopes_supported)
      ? o.scopes_supported.filter((x): x is string => typeof x === "string")
      : undefined,
    codeChallengeMethodsSupported: Array.isArray(o.code_challenge_methods_supported)
      ? o.code_challenge_methods_supported.filter((x): x is string => typeof x === "string")
      : undefined,
    responseTypesSupported: Array.isArray(o.response_types_supported)
      ? o.response_types_supported.filter((x): x is string => typeof x === "string")
      : undefined,
    raw: o,
  };
}

export function parseProtectedResourceMetadata(
  json: string | undefined,
): Record<string, unknown> | null {
  const o = parseJsonObject(json);
  return o && typeof o.resource === "string" ? o : null;
}

export interface ParsedMcpResourceLink {
  resourceMetadataUrl?: string;
  rels: { url: string; rel: string }[];
}

export function parseMcpResourceLink(linkHeader: string | undefined): ParsedMcpResourceLink {
  if (!linkHeader) return { rels: [] };
  // RFC 8288: <url>; rel="x", <url2>; rel="y"
  const rels: { url: string; rel: string }[] = [];
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (m) rels.push({ url: m[1].trim(), rel: m[2].trim() });
  }
  const resourceMetadata = rels.find(
    (r) =>
      r.rel === "resource_metadata" ||
      r.rel === "https://datatracker.ietf.org/doc/html/rfc9728#name-link-header-field",
  );
  return { resourceMetadataUrl: resourceMetadata?.url, rels };
}
