import { guardedFetch, type IsAllowedTarget, TargetNotAllowedError } from "../../shared/fetcher.js";
import { parseJsonObject } from "../shared/json.js";
import {
  discoverOAuth,
  type OAuthDiscovery,
  type ResourceProbe,
  resolveProtectedResource,
} from "../shared/oauth-discovery.js";
import { bearerChallenge } from "../shared/oauth-parser.js";
import type { Check, CheckResult, SiteMetadata } from "../types.js";

function stripWww(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_PROBE_BYTES = 256 * 1024;
export const PROBE_RETRY_DELAY_MS = 2000;
export const PROBE_MAX_ATTEMPTS = 2;

async function probeUrl(
  url: string,
  isAllowedTarget?: IsAllowedTarget,
): Promise<{ status: number; text: string; contentType: string; wwwAuthenticate: string } | null> {
  for (let attempt = 0; attempt < PROBE_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await guardedFetch(url, { signal: AbortSignal.timeout(5000) }, isAllowedTarget);
      if (res.status >= 500 && attempt + 1 < PROBE_MAX_ATTEMPTS) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, PROBE_RETRY_DELAY_MS));
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const wwwAuthenticate = res.headers.get("www-authenticate") ?? "";
      const reader = res.body?.getReader();
      if (!reader) return { status: res.status, text: "", contentType, wwwAuthenticate };
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        totalBytes += value.length;
        if (totalBytes >= MAX_PROBE_BYTES) {
          await reader.cancel();
          break;
        }
      }
      const buf = new Uint8Array(totalBytes);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.length;
      }
      return {
        status: res.status,
        text: new TextDecoder().decode(buf),
        contentType,
        wwwAuthenticate,
      };
    } catch (err) {
      if (err instanceof TargetNotAllowedError) return null;
      if (attempt + 1 < PROBE_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, PROBE_RETRY_DELAY_MS));
        continue;
      }
      return null;
    }
  }
  return null;
}

const PORTAL_PATHS = ["/developers", "/developer", "/api", "/docs/api", "/api-docs"];
const PORTAL_SUBDOMAINS = ["docs", "developers", "developer"];

type PortalResult =
  | { found: true; url: string; text: string }
  | { found: false; probeFailed: boolean };

async function probeDeveloperPortal(
  baseUrl: string,
  catchAll: boolean,
  isAllowedTarget?: IsAllowedTarget,
): Promise<PortalResult> {
  let anyResponseReceived = catchAll;

  const canonicalProbes = await Promise.all(
    (catchAll ? [] : PORTAL_PATHS).map(async (p) => {
      const url = `${baseUrl}${p}`;
      const probe = await probeUrl(url, isAllowedTarget);
      if (probe !== null) anyResponseReceived = true;
      if (probe && probe.status >= 200 && probe.status < 300)
        return { url, text: stripHtml(probe.text) };
      return null;
    }),
  );
  const canonical = canonicalProbes.find((p): p is { url: string; text: string } => p !== null);
  if (canonical) return { found: true, ...canonical };

  // Subdomain fallback assumes baseUrl is an apex (or www.) domain.
  // If baseUrl is already a subdomain, probes will degrade to 404; that's acceptable.
  // Fallback: subdomain probes (sequential, gentle on remote servers).
  const u = new URL(baseUrl);
  for (const sub of PORTAL_SUBDOMAINS) {
    const url = `${u.protocol}//${sub}.${stripWww(u.hostname)}/`;
    const probe = await probeUrl(url, isAllowedTarget);
    if (probe !== null) anyResponseReceived = true;
    if (probe && probe.status >= 200 && probe.status < 300) {
      return { found: true, url, text: stripHtml(probe.text) };
    }
  }

  return { found: false, probeFailed: !anyResponseReceived };
}

const portalCache = new WeakMap<object, Promise<PortalResult>>();

function cachedPortal(
  pages: object,
  metadata: SiteMetadata,
  isAllowedTarget?: IsAllowedTarget,
): Promise<PortalResult> {
  if (!portalCache.has(pages)) {
    portalCache.set(
      pages,
      probeDeveloperPortal(metadata.baseUrl, metadata.catchAll === true, isAllowedTarget),
    );
  }
  return portalCache.get(pages)!;
}

const KEY_DOC_PATHS = ["/keys", "/api-keys", "/docs/keys"];

async function probeKeyDocs(
  baseUrl: string,
  catchAll: boolean,
  isAllowedTarget?: IsAllowedTarget,
): Promise<{ url: string; text: string } | null> {
  const apexProbes = await Promise.all(
    (catchAll ? [] : KEY_DOC_PATHS).map(async (p) => {
      const url = `${baseUrl}${p}`;
      const probe = await probeUrl(url, isAllowedTarget);
      if (probe && probe.status >= 200 && probe.status < 300)
        return { url, text: stripHtml(probe.text) };
      return null;
    }),
  );
  const apex = apexProbes.find((r): r is { url: string; text: string } => r !== null);
  if (apex) return apex;

  const u = new URL(baseUrl);
  const docsBase = `${u.protocol}//docs.${stripWww(u.hostname)}`;
  for (const p of KEY_DOC_PATHS) {
    const url = `${docsBase}${p}`;
    const probe = await probeUrl(url, isAllowedTarget);
    if (probe && probe.status >= 200 && probe.status < 300)
      return { url, text: stripHtml(probe.text) };
  }
  return null;
}

const keyDocsCache = new WeakMap<object, Promise<{ url: string; text: string } | null>>();

function cachedKeyDocs(
  pages: object,
  metadata: SiteMetadata,
  isAllowedTarget?: IsAllowedTarget,
): Promise<{ url: string; text: string } | null> {
  if (!keyDocsCache.has(pages)) {
    keyDocsCache.set(
      pages,
      probeKeyDocs(metadata.baseUrl, metadata.catchAll === true, isAllowedTarget),
    );
  }
  return keyDocsCache.get(pages)!;
}

type ProbeResult = Awaited<ReturnType<typeof probeUrl>>;
type ApiProbe = { url: string; probe: ProbeResult };

const apiProbeCache = new WeakMap<object, Promise<ApiProbe[]>>();

function cachedApiProbes(
  pages: object,
  metadata: SiteMetadata,
  isAllowedTarget?: IsAllowedTarget,
): Promise<ApiProbe[]> {
  if (!apiProbeCache.has(pages)) {
    const host = new URL(metadata.baseUrl).hostname;
    const hostParts = host.split(".");
    const registeredDomain = hostParts.length > 2 ? hostParts.slice(-2).join(".") : host;
    const urls = [`${metadata.baseUrl}/api/`, `https://api.${registeredDomain}/`];
    apiProbeCache.set(
      pages,
      Promise.all(urls.map(async (url) => ({ url, probe: await probeUrl(url, isAllowedTarget) }))),
    );
  }
  return apiProbeCache.get(pages)!;
}

const discoveryCache = new WeakMap<object, Promise<OAuthDiscovery>>();

function cachedDiscovery(
  pages: object,
  metadata: SiteMetadata,
  isAllowedTarget?: IsAllowedTarget,
): Promise<OAuthDiscovery> {
  if (!discoveryCache.has(pages)) {
    discoveryCache.set(
      pages,
      cachedApiProbes(pages, metadata, isAllowedTarget).then((probes) =>
        discoverOAuth(
          {
            baseUrl: metadata.baseUrl,
            resourceProbes: [
              ...probes.flatMap(({ url, probe }): ResourceProbe[] =>
                probe
                  ? [
                      {
                        url,
                        status: probe.status,
                        wwwAuthenticate: probe.wwwAuthenticate || undefined,
                      },
                    ]
                  : [],
              ),
              ...(metadata.mcpInit?.status !== undefined
                ? [
                    {
                      url: metadata.mcpInit.mcpEndpointUrl,
                      status: metadata.mcpInit.status,
                      wwwAuthenticate: metadata.mcpInit.rawHeaders?.["www-authenticate"],
                    },
                  ]
                : []),
            ],
            wellKnownPrm: metadata.wellKnown["oauth-protected-resource"],
            wellKnownAs: metadata.wellKnown["oauth-authorization-server"],
          },
          isAllowedTarget,
        ),
      ),
    );
  }
  return discoveryCache.get(pages)!;
}

function extractApiHrefCount(html: string, host: string): number {
  const lower = html.toLowerCase();
  const apiPath = (lower.match(/href=["'][^"']*\/api[/"']/g) ?? []).length;
  const escapedHost = host.replace(/\./g, "\\.");
  const apiSubdomain = (lower.match(new RegExp(`href=["'][^"']*api\\.${escapedHost}`, "g")) ?? [])
    .length;
  return apiPath + apiSubdomain;
}

function countNearbyPairs(
  text: string,
  termsA: string[],
  termsB: string[],
  distance: number,
): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const a of termsA) {
    const reA = new RegExp(a, "gi");
    let m: RegExpExecArray | null;
    while ((m = reA.exec(lower)) !== null) {
      const pos = m.index;
      const win = lower.slice(Math.max(0, pos - distance), pos + a.length + distance);
      if (termsB.some((b) => new RegExp(b, "i").test(win))) count++;
    }
  }
  return count;
}

type Base = {
  id: string;
  name: string;
  category: "agent-auth";
  weight: number;
  severity: "info";
  maxScore: 100;
};

function mk(id: string, name: string, weight: number): Base {
  return { id, name, category: "agent-auth", weight, severity: "info", maxScore: 100 };
}

function res(
  base: Base,
  status: CheckResult["status"],
  score: number,
  message: string,
): CheckResult {
  return { ...base, status, score, message };
}

const a1: Check = {
  ...mk("public-api", "Public API surface", 2.0),
  run: async (pages, metadata, ctx) => {
    const base = mk("public-api", "Public API surface", 2.0);
    const host = new URL(metadata.baseUrl).hostname;
    const [r1, r2] = (await cachedApiProbes(pages, metadata, ctx?.isAllowedTarget)).map(
      (p) => p.probe,
    );

    // Accept 2xx (open) and 4xx (auth-required) JSON/YAML as evidence the API exists.
    // A real API correctly returns 4xx with a structured JSON body when called without auth.
    const isJsonOrYaml = (p: typeof r1) =>
      p &&
      ((p.status >= 200 && p.status < 300) || (p.status >= 400 && p.status < 500)) &&
      (p.contentType.includes("json") || p.contentType.includes("yaml"));

    if (isJsonOrYaml(r1) || isJsonOrYaml(r2))
      return res(base, "pass", 100, "Public API endpoint detected with structured response");

    const linkCount = extractApiHrefCount(pages[0]?.html ?? "", host);
    if (linkCount >= 3) return res(base, "pass", 100, `Found ${linkCount} API links on homepage`);
    if (linkCount >= 1)
      return res(
        base,
        "partial",
        50,
        `Found ${linkCount} API link(s) — no structured API endpoint`,
      );
    return res(base, "fail", 0, "No public API surface detected");
  },
};

const a2: Check = {
  ...mk("openapi-spec", "OpenAPI specification", 2.0),
  run: (_pages, metadata) => {
    const base = mk("openapi-spec", "OpenAPI specification", 2.0);
    const spec = metadata.openapi;
    if (!spec) return res(base, "fail", 0, "No OpenAPI spec found");
    if (spec.endpoints.length >= 1)
      return res(base, "pass", 100, `OpenAPI spec found with ${spec.endpoints.length} endpoint(s)`);
    return res(base, "partial", 50, "OpenAPI spec found but contains no endpoints");
  },
};

const a3: Check = {
  ...mk("developer-portal", "Developer portal", 2.0),
  run: async (pages, metadata, ctx) => {
    const base = mk("developer-portal", "Developer portal", 2.0);
    const portal = await cachedPortal(pages, metadata, ctx?.isAllowedTarget);
    if (!portal.found) {
      if (portal.probeFailed)
        return res(base, "skip", 0, "Could not verify portal (network unreachable)");
      return res(base, "fail", 0, "No developer portal found");
    }
    if (portal.text.length >= 1000)
      return res(base, "pass", 100, `Developer portal at ${portal.url}`);
    return res(
      base,
      "partial",
      50,
      `Developer portal at ${portal.url} has thin content (${portal.text.length} chars)`,
    );
  },
};

const a4: Check = {
  ...mk("agent-auth-docs", "Agent/bot auth documentation", 2.0),
  run: async (pages, metadata, ctx) => {
    const base = mk("agent-auth-docs", "Agent/bot auth documentation", 2.0);
    const portalResult = await cachedPortal(pages, metadata, ctx?.isAllowedTarget);
    if (!portalResult.found && portalResult.probeFailed)
      return res(base, "skip", 0, "Could not verify portal (network unreachable)");
    const keyDocs = await cachedKeyDocs(pages, metadata, ctx?.isAllowedTarget);
    const homepageText = stripHtml(pages[0]?.html ?? "");
    const combined = [
      portalResult.found ? portalResult.text : "",
      keyDocs?.text ?? "",
      homepageText,
    ].join(" ");

    const pairs = countNearbyPairs(
      combined,
      ["api key", "oauth", "rate limit"],
      ["agent", "bot", "ai", "scope", "permission", "token"],
      200,
    );

    if (pairs >= 3)
      return res(base, "pass", 100, `${pairs} agent auth documentation signals found`);
    if (pairs >= 1)
      return res(base, "partial", 50, `${pairs} agent auth signal(s) — incomplete coverage`);
    return res(base, "fail", 0, "No agent/bot auth documentation signals found");
  },
};

const b1: Check = {
  ...mk("oauth-discovery", "OAuth discovery chain (RFC 9728 → RFC 8414)", 3.0),
  run: async (pages, metadata, ctx) => {
    const base = mk("oauth-discovery", "OAuth discovery chain (RFC 9728 → RFC 8414)", 3.0);
    const d = await cachedDiscovery(pages, metadata, ctx?.isAllowedTarget);
    const broke = d.problems.length ? `: ${d.problems.join("; ")}` : "";
    if (d.outcome === "full")
      return res(
        base,
        "pass",
        100,
        `OAuth discovery resolved: ${d.resourceUrl} → ${d.prmUrl} → authorization server ${d.as?.issuer}`,
      );
    if (d.outcome === "prm-only")
      return res(
        base,
        "partial",
        50,
        `Protected resource metadata at ${d.prmUrl} is valid, but no usable authorization server was resolved${broke}`,
      );
    if (d.outcome === "root-as")
      return res(
        base,
        "partial",
        50,
        `No protected resource metadata; root authorization server metadata (issuer ${d.as?.issuer}) is valid`,
      );
    return res(base, "fail", 0, `No OAuth discovery chain found${broke}`);
  },
};

const b4: Check = {
  ...mk("scoped-permissions", "Scoped API permissions", 1.5),
  run: async (pages, metadata, ctx) => {
    const base = mk("scoped-permissions", "Scoped API permissions", 1.5);
    const portal = await cachedPortal(pages, metadata, ctx?.isAllowedTarget);
    const keyDocs = await cachedKeyDocs(pages, metadata, ctx?.isAllowedTarget);

    const portalText = portal.found ? portal.text : "";
    const text = [portalText, keyDocs?.text ?? ""].filter(Boolean).join(" ");
    if (!text) {
      if (!portal.found && portal.probeFailed)
        return res(base, "skip", 0, "Could not verify portal (network unreachable)");
      return res(base, "fail", 0, "No developer portal or key docs to scan for scope patterns");
    }

    const scopePatterns = (text.match(/\b(read|write|admin|delete|update):\w+/g) ?? []).length;
    const scopeKeyword = countNearbyPairs(text, ["scope"], ["permission", "token", "access"], 200);
    const bulletLists = (text.match(/^[-*]\s+\w+:\w+/gm) ?? []).length;

    // Graduated-access vocabulary signals (Stripe-style restricted keys, read-only/read or write tiers)
    const graduatedPatterns: RegExp[] = [
      /\brestricted\s+(api\s+)?keys?\b/i,
      /\bread[-\s]?only\b|\bread\s+(?:or|and|&)\s+write\b/i,
      /\b(custom|limited|scoped|restricted|granular)\s+permissions?\b/i,
      /\blimit(?:s|ed)?\s+access\b/i,
    ];
    const graduatedHits = graduatedPatterns.filter((re) => re.test(text)).length;

    const total = scopePatterns + scopeKeyword + bulletLists + graduatedHits;
    if (total >= 3) return res(base, "pass", 100, `${total} scope/permission signals found`);
    if (total >= 1) return res(base, "partial", 50, `${total} scope/permission signal(s) found`);
    return res(base, "fail", 0, "No scoped permission patterns found in developer portal");
  },
};

const b5: Check = {
  ...mk("pkce-s256", "PKCE S256 support", 1.5),
  run: async (pages, metadata, ctx) => {
    const base = mk("pkce-s256", "PKCE S256 support", 1.5);
    const { as } = await cachedDiscovery(pages, metadata, ctx?.isAllowedTarget);
    if (as?.codeChallengeMethodsSupported?.includes("S256"))
      return res(
        base,
        "pass",
        100,
        `PKCE S256 declared by authorization server ${as.issuer} (code_challenge_methods_supported)`,
      );

    const portal = await cachedPortal(pages, metadata, ctx?.isAllowedTarget);
    if (!portal.found) {
      if (portal.probeFailed)
        return res(base, "skip", 0, "Could not verify portal (network unreachable)");
      return res(base, "fail", 0, "No PKCE S256 support detected");
    }
    if (/PKCE/i.test(portal.text) && /S256/i.test(portal.text))
      return res(
        base,
        "partial",
        50,
        "PKCE S256 mentioned in developer docs but not declared in OAuth metadata",
      );
    return res(base, "fail", 0, "No PKCE S256 support detected");
  },
};

const c1: Check = {
  ...mk("mcp-auth", "MCP authorization (401 challenge → protected resource metadata)", 1.5),
  run: async (pages, metadata, ctx) => {
    const base = mk(
      "mcp-auth",
      "MCP authorization (401 challenge → protected resource metadata)",
      1.5,
    );
    const init = metadata.mcpInit;
    const endpoint = metadata.mcpEndpoint ?? init?.mcpEndpointUrl;
    if (!endpoint) return res(base, "skip", 0, "No MCP endpoint discovered");
    if (!init)
      return res(
        base,
        "skip",
        0,
        `No handshake response was recorded for MCP endpoint ${endpoint}`,
      );
    if (init.status !== 401)
      return res(base, "skip", 0, "MCP endpoint does not require authorization");
    const header = init.rawHeaders?.["www-authenticate"];
    if (!bearerChallenge(header))
      return res(base, "fail", 0, "MCP endpoint returns 401 without a Bearer challenge");
    const resolved = await resolveProtectedResource(endpoint, header, ctx?.isAllowedTarget);
    if (!resolved.prm)
      return res(
        base,
        "partial",
        50,
        `MCP endpoint sends a Bearer challenge, but ${resolved.problem ?? "no valid protected resource metadata was found"}`,
      );
    const discovery = await cachedDiscovery(pages, metadata, ctx?.isAllowedTarget);
    if (discovery.prmUrl === resolved.url)
      return res(
        base,
        "skip",
        0,
        `Not applicable — MCP endpoint uses the protected resource metadata already measured by oauth-discovery (${resolved.url})`,
      );
    return res(
      base,
      "pass",
      100,
      `MCP endpoint ${endpoint} challenges with Bearer and links valid protected resource metadata at ${resolved.url}`,
    );
  },
};

const c2: Check = {
  ...mk("cimd-support", "Client ID Metadata Documents (bonus)", 0.5),
  run: async (pages, metadata, ctx) => {
    const base = mk("cimd-support", "Client ID Metadata Documents (bonus)", 0.5);
    const d = await cachedDiscovery(pages, metadata, ctx?.isAllowedTarget);
    if (d.outcome !== "full")
      return res(base, "skip", 0, "No resolved OAuth discovery chain to read CIMD support from");
    if (d.as?.clientIdMetadataDocumentSupported)
      return res(
        base,
        "pass",
        100,
        `Authorization server ${d.as.issuer} supports Client ID Metadata Documents`,
      );
    return res(
      base,
      "skip",
      0,
      d.as?.registrationEndpoint
        ? "Authorization server offers Dynamic Client Registration but not Client ID Metadata Documents"
        : "Authorization server does not advertise client_id_metadata_document_supported",
    );
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function originOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

const d1: Check = {
  ...mk("agent-operator-signing", "Agent operator signing directory", 0),
  tracked: true,
  run: (_pages, metadata) => {
    const base = mk("agent-operator-signing", "Agent operator signing directory", 0);
    const raw = metadata.wellKnown["http-message-signatures-directory"];
    if (raw === undefined)
      return res(
        base,
        "skip",
        0,
        "No agent operator signing directory — only sites that operate a signing bot publish one",
      );
    const dir = parseJsonObject(raw);
    const keys = dir?.keys;
    const hasEd25519Key =
      Array.isArray(keys) &&
      keys.some(
        (k) => isObject(k) && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string",
      );
    if (!hasEd25519Key)
      return res(base, "fail", 0, "Signing directory has no Ed25519 JWK (kty OKP, crv Ed25519, x)");
    const agentOrigin = originOf(dir?.signature_agent);
    const siteOrigin = new URL(metadata.baseUrl).origin;
    if (agentOrigin !== siteOrigin)
      return res(
        base,
        "fail",
        0,
        `Signing directory signature_agent (${agentOrigin ?? "missing"}) does not match ${siteOrigin}`,
      );
    return res(base, "pass", 100, `Agent operator signing directory for ${siteOrigin}`);
  },
};

const LINKSET_API_RELATIONS = ["item", "service-desc", "service-doc"];

function isApiLinkContext(entry: unknown): boolean {
  if (!isObject(entry) || typeof entry.anchor !== "string") return false;
  return LINKSET_API_RELATIONS.some((rel) => {
    const targets = entry[rel];
    return (
      Array.isArray(targets) &&
      targets.length > 0 &&
      targets.every((t) => isObject(t) && typeof t.href === "string")
    );
  });
}

const d2: Check = {
  ...mk("api-catalog-rfc9727", "API catalog (RFC 9727)", 1.0),
  run: (_pages, metadata) => {
    const base = mk("api-catalog-rfc9727", "API catalog (RFC 9727)", 1.0);
    const raw = metadata.wellKnown["api-catalog"];
    if (raw === undefined)
      return res(
        base,
        "fail",
        0,
        "No API catalog at /.well-known/api-catalog (application/linkset+json)",
      );
    const linkset = parseJsonObject(raw)?.linkset;
    if (!Array.isArray(linkset)) return res(base, "fail", 0, "API catalog has no linkset array");
    const apis = linkset.filter(isApiLinkContext).length;
    if (apis === 0)
      return res(
        base,
        "fail",
        0,
        "API catalog linkset has no entry with an anchor and item/service-desc/service-doc links",
      );
    return res(base, "pass", 100, `API catalog linkset found with ${apis} API(s)`);
  },
};

export const agentAuthChecks: Check[] = [a1, a2, a3, a4, b1, b4, b5, c1, c2, d1, d2];
