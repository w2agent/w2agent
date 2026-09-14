import { parseJsonObject } from "./json.js";

export interface ParsedOAuthMetadata {
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  responseTypesSupported?: string[];
  clientIdMetadataDocumentSupported: boolean;
  raw: Record<string, unknown>;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : undefined;
}

export function parseOAuthMetadata(json: string | undefined): ParsedOAuthMetadata | null {
  const o = parseJsonObject(json);
  if (!o || typeof o.issuer !== "string") return null;
  return {
    issuer: o.issuer,
    authorizationEndpoint:
      typeof o.authorization_endpoint === "string" ? o.authorization_endpoint : undefined,
    tokenEndpoint: typeof o.token_endpoint === "string" ? o.token_endpoint : undefined,
    registrationEndpoint:
      typeof o.registration_endpoint === "string" ? o.registration_endpoint : undefined,
    scopesSupported: stringArray(o.scopes_supported),
    codeChallengeMethodsSupported: stringArray(o.code_challenge_methods_supported),
    responseTypesSupported: stringArray(o.response_types_supported),
    clientIdMetadataDocumentSupported: o.client_id_metadata_document_supported === true,
    raw: o,
  };
}

export interface ParsedProtectedResourceMetadata {
  resource: string;
  /** Present only when `authorization_servers` is an array made entirely of strings. */
  authorizationServers?: string[];
  raw: Record<string, unknown>;
}

export function parseProtectedResourceMetadata(
  json: string | undefined,
): ParsedProtectedResourceMetadata | null {
  const o = parseJsonObject(json);
  if (!o || typeof o.resource !== "string") return null;
  const servers = o.authorization_servers;
  return {
    resource: o.resource,
    authorizationServers:
      Array.isArray(servers) && servers.every((s) => typeof s === "string")
        ? (servers as string[])
        : undefined,
    raw: o,
  };
}

export interface AuthChallenge {
  scheme: string;
  params: Record<string, string>;
}

const SEPARATOR = /[\s,]/;

/**
 * RFC 9110 §11.6.1 WWW-Authenticate: one or more comma-separated challenges, each a scheme
 * followed by a token68 or auth-params. Lenient on unquoted values that contain non-tchar
 * characters (real servers send `resource_metadata=https://...` unquoted).
 */
export function parseWwwAuthenticate(header: string | undefined): AuthChallenge[] {
  const challenges: AuthChallenge[] = [];
  if (!header) return challenges;
  const h = header;
  let current: AuthChallenge | undefined;
  let token68Allowed = false;
  let i = 0;
  const n = h.length;
  const skipSpace = () => {
    while (i < n && (h[i] === " " || h[i] === "\t")) i++;
  };

  while (i < n) {
    const ch = h[i];
    if (ch === ",") {
      token68Allowed = false;
      i++;
      continue;
    }
    if (SEPARATOR.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      readQuoted();
      continue;
    }

    const start = i;
    while (i < n && !SEPARATOR.test(h[i]) && h[i] !== "=" && h[i] !== '"') i++;
    const token = h.slice(start, i);
    const afterToken = i;
    skipSpace();

    if (h[i] === "=") {
      let j = i;
      while (j < n && h[j] === "=") j++;
      let k = j;
      while (k < n && (h[k] === " " || h[k] === "\t")) k++;
      const isToken68 = j - i > 1 || k >= n || h[k] === ",";
      if (isToken68 || token === "") {
        i = k;
        token68Allowed = false;
        continue;
      }
      i = k;
      const value = h[i] === '"' ? readQuoted() : readUnquoted();
      const name = token.toLowerCase();
      if (current && !(name in current.params)) current.params[name] = value;
      token68Allowed = false;
      continue;
    }

    if (token68Allowed) {
      token68Allowed = false;
      continue;
    }
    i = afterToken;
    current = { scheme: token, params: {} };
    challenges.push(current);
    token68Allowed = true;
  }
  return challenges;

  function readQuoted(): string {
    i++;
    let out = "";
    while (i < n && h[i] !== '"') {
      if (h[i] === "\\" && i + 1 < n) i++;
      out += h[i];
      i++;
    }
    i++;
    return out;
  }

  function readUnquoted(): string {
    const start = i;
    while (i < n && !SEPARATOR.test(h[i])) i++;
    return h.slice(start, i);
  }
}

export function bearerChallenge(header: string | undefined): AuthChallenge | undefined {
  return parseWwwAuthenticate(header).find((c) => c.scheme.toLowerCase() === "bearer");
}

export function bearerResourceMetadata(header: string | undefined): string | undefined {
  const value = bearerChallenge(header)?.params.resource_metadata;
  return value ? value : undefined;
}
