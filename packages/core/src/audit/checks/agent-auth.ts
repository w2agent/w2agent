import { parseOAuthMetadata, parseMcpResourceLink } from "../shared/oauth-parser.js";
import type { Check, CheckResult, SiteMetadata } from "../types.js";

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_PROBE_BYTES = 64 * 1024;

async function probeUrl(
  url: string,
): Promise<{ status: number; text: string; contentType: string } | null> {
  try {
    const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(5000) });
    const contentType = res.headers.get("content-type") ?? "";
    const reader = res.body?.getReader();
    if (!reader) return { status: res.status, text: "", contentType };
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      totalBytes += value.length;
      if (totalBytes >= MAX_PROBE_BYTES) { await reader.cancel(); break; }
    }
    const buf = new Uint8Array(totalBytes);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return { status: res.status, text: new TextDecoder().decode(buf), contentType };
  } catch {
    return null;
  }
}

const PORTAL_PATHS = ["/developers", "/developer", "/api", "/docs/api", "/api-docs"];

async function probeDeveloperPortal(
  baseUrl: string,
): Promise<{ url: string; text: string } | null> {
  const results = await Promise.all(
    PORTAL_PATHS.map(async (p) => {
      const url = `${baseUrl}${p}`;
      const probe = await probeUrl(url);
      if (probe && probe.status >= 200 && probe.status < 300) return { url, text: stripHtml(probe.text) };
      return null;
    }),
  );
  return results.find((p): p is { url: string; text: string } => p !== null) ?? null;
}

const portalCache = new WeakMap<object, Promise<{ url: string; text: string } | null>>();

function cachedPortal(pages: object, baseUrl: string): Promise<{ url: string; text: string } | null> {
  if (!portalCache.has(pages)) {
    portalCache.set(pages, probeDeveloperPortal(baseUrl));
  }
  return portalCache.get(pages)!;
}

function extractApiHrefCount(html: string, host: string): number {
  const lower = html.toLowerCase();
  const apiPath = (lower.match(/href=["'][^"']*\/api[/"']/g) ?? []).length;
  const escapedHost = host.replace(/\./g, "\\.");
  const apiSubdomain = (
    lower.match(new RegExp(`href=["'][^"']*api\\.${escapedHost}`, "g")) ?? []
  ).length;
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

function parseRobotsBlocks(
  text: string,
): { userAgent: string; allow: number; disallow: number }[] {
  const lines = text.split(/\r?\n/);
  const blocks: { userAgent: string; allow: number; disallow: number }[] = [];
  let current: { userAgent: string; allow: number; disallow: number } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^user-agent:/i.test(trimmed)) {
      const agent = trimmed.replace(/^user-agent:\s*/i, "").trim();
      current = { userAgent: agent, allow: 0, disallow: 0 };
      blocks.push(current);
    } else if (current) {
      if (/^allow:/i.test(trimmed)) {
        current.allow++;
      } else if (/^disallow:/i.test(trimmed)) {
        current.disallow++;
      }
    }
  }
  return blocks;
}

const AI_BOTS = [
  "gptbot",
  "claudebot",
  "claude-web",
  "anthropic-ai",
  "perplexitybot",
  "google-extended",
  "ccbot",
  "bytespider",
];

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
  run: async (pages, metadata) => {
    const base = mk("public-api", "Public API surface", 2.0);
    const host = new URL(metadata.baseUrl).hostname;
    const hostParts = host.split(".");
    const registeredDomain = hostParts.length > 2 ? hostParts.slice(-2).join(".") : host;

    const [r1, r2] = await Promise.all([
      probeUrl(`${metadata.baseUrl}/api/`),
      probeUrl(`https://api.${registeredDomain}/`),
    ]);

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
      return res(base, "partial", 50, `Found ${linkCount} API link(s) — no structured API endpoint`);
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
  run: async (pages, metadata) => {
    const base = mk("developer-portal", "Developer portal", 2.0);
    const portal = await cachedPortal(pages, metadata.baseUrl);
    if (!portal) return res(base, "fail", 0, "No developer portal found");
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
  run: async (pages, metadata) => {
    const base = mk("agent-auth-docs", "Agent/bot auth documentation", 2.0);
    const portal = await cachedPortal(pages, metadata.baseUrl);
    const homepageText = stripHtml(pages[0]?.html ?? "");
    const combined = [portal?.text ?? "", homepageText].join(" ");

    const pairs = countNearbyPairs(
      combined,
      ["api key", "oauth", "rate limit"],
      ["agent", "bot", "ai", "scope", "permission", "token"],
      200,
    );

    if (pairs >= 3) return res(base, "pass", 100, `${pairs} agent auth documentation signals found`);
    if (pairs >= 1) return res(base, "partial", 50, `${pairs} agent auth signal(s) — incomplete coverage`);
    return res(base, "fail", 0, "No agent/bot auth documentation signals found");
  },
};

const b1: Check = {
  ...mk("oauth-support", "OAuth 2.0 authorization server", 1.5),
  run: (_pages, metadata) => {
    const base = mk("oauth-support", "OAuth 2.0 authorization server", 1.5);
    const parsed = parseOAuthMetadata(metadata.wellKnown["oauth-authorization-server"]);
    if (!parsed) return res(base, "fail", 0, "No OAuth authorization server metadata found");
    if (parsed.issuer && parsed.authorizationEndpoint && parsed.tokenEndpoint)
      return res(base, "pass", 100, `OAuth 2.0 AS metadata valid (issuer: ${parsed.issuer})`);
    return res(
      base,
      "partial",
      50,
      "OAuth AS metadata present but missing issuer, authorization_endpoint, or token_endpoint",
    );
  },
};

const b2: Check = {
  ...mk("oauth-protected-resource", "OAuth 2.0 protected resource metadata", 1.5),
  run: (_pages, metadata) => {
    const base = mk("oauth-protected-resource", "OAuth 2.0 protected resource metadata", 1.5);
    const raw = metadata.wellKnown["oauth-protected-resource"];
    if (raw === undefined) return res(base, "fail", 0, "No OAuth protected resource metadata found");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object")
        return res(base, "pass", 100, "OAuth protected resource metadata present and valid");
      return res(base, "partial", 50, "OAuth protected resource metadata present but malformed");
    } catch {
      return res(base, "partial", 50, "OAuth protected resource metadata present but invalid JSON");
    }
  },
};

const b3: Check = {
  ...mk("oauth-metadata-rfc9728", "OAuth resource metadata via Link header (RFC 9728)", 1.5),
  run: (_pages, metadata) => {
    const base = mk(
      "oauth-metadata-rfc9728",
      "OAuth resource metadata via Link header (RFC 9728)",
      1.5,
    );
    const mcpInit = metadata.mcpInit;
    if (!mcpInit?.linkHeader)
      return res(base, "fail", 0, "No Link header in MCP initialization response");
    if (mcpInit.oauthResourceMetadataUrl) {
      const ownUrl = `${new URL(metadata.baseUrl).origin}/.well-known/oauth-protected-resource`;
      if (mcpInit.oauthResourceMetadataUrl === ownUrl && metadata.wellKnown["oauth-protected-resource"])
        return res(base, "pass", 100, "RFC 9728 Link header present and resource metadata reachable");
      return res(base, "partial", 50, "Link header present but resource_metadata URL not verified (external or unreachable)");
    }
    return res(base, "partial", 50, "Link header present but no resource_metadata relation found");
  },
};

const b4: Check = {
  ...mk("scoped-permissions", "Scoped API permissions", 1.5),
  run: async (pages, metadata) => {
    const base = mk("scoped-permissions", "Scoped API permissions", 1.5);
    const portal = await cachedPortal(pages, metadata.baseUrl);
    if (!portal) return res(base, "fail", 0, "No developer portal to scan for scope patterns");

    const text = portal.text;
    const scopePatterns = (text.match(/\b(read|write|admin|delete|update):\w+/g) ?? []).length;
    const scopeKeyword = countNearbyPairs(text, ["scope"], ["permission", "token", "access"], 200);
    const bulletLists = (text.match(/^[\-\*]\s+\w+:\w+/gm) ?? []).length;
    const total = scopePatterns + scopeKeyword + bulletLists;

    if (total >= 3) return res(base, "pass", 100, `${total} scope/permission signals found`);
    if (total >= 1) return res(base, "partial", 50, `${total} scope/permission signal(s) found`);
    return res(base, "fail", 0, "No scoped permission patterns found in developer portal");
  },
};

const b5: Check = {
  ...mk("pkce-s256", "PKCE S256 support", 1.5),
  run: async (pages, metadata) => {
    const base = mk("pkce-s256", "PKCE S256 support", 1.5);
    const parsed = parseOAuthMetadata(metadata.wellKnown["oauth-authorization-server"]);
    if (parsed?.codeChallengeMethodsSupported?.includes("S256"))
      return res(base, "pass", 100, "PKCE S256 declared in OAuth authorization server metadata");

    const portal = await cachedPortal(pages, metadata.baseUrl);
    if (portal && /PKCE/i.test(portal.text) && /S256/i.test(portal.text))
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
  ...mk("mcp-auth-mechanism", "MCP authentication mechanism", 1.0),
  run: (_pages, metadata) => {
    const base = mk("mcp-auth-mechanism", "MCP authentication mechanism", 1.0);
    const mcpInit = metadata.mcpInit;
    if (!mcpInit) return res(base, "fail", 0, "No MCP initialization data available");
    if (mcpInit.serverInfo?.authMechanism)
      return res(base, "pass", 100, `MCP auth mechanism declared: ${mcpInit.serverInfo.authMechanism}`);
    if (mcpInit.status === 401 && mcpInit.rawHeaders?.["www-authenticate"])
      return res(base, "pass", 100, "MCP endpoint requires auth (401 + WWW-Authenticate)");
    if (mcpInit.status === 401)
      return res(base, "partial", 50, "MCP endpoint returns 401 but no WWW-Authenticate header");
    return res(base, "fail", 0, "MCP endpoint does not declare an authentication mechanism");
  },
};

const c2: Check = {
  ...mk("mcp-oauth-metadata", "MCP OAuth resource metadata link", 1.0),
  run: (_pages, metadata) => {
    const base = mk("mcp-oauth-metadata", "MCP OAuth resource metadata link", 1.0);
    const linkHeader = metadata.mcpInit?.linkHeader;
    const parsed = parseMcpResourceLink(linkHeader);
    if (!linkHeader || parsed.rels.length === 0)
      return res(base, "fail", 0, "No Link header in MCP initialization response");
    if (parsed.resourceMetadataUrl && metadata.wellKnown["oauth-protected-resource"])
      return res(base, "pass", 100, "MCP Link header points to reachable OAuth resource metadata");
    return res(base, "partial", 50, "Link header present but resource_metadata target not reachable");
  },
};

const c3: Check = {
  ...mk("mcp-pkce-s256", "MCP PKCE S256 via resource metadata", 1.0),
  run: (_pages, metadata) => {
    const base = mk("mcp-pkce-s256", "MCP PKCE S256 via resource metadata", 1.0);
    const linkParsed = parseMcpResourceLink(metadata.mcpInit?.linkHeader);
    if (!linkParsed.resourceMetadataUrl)
      return res(base, "fail", 0, "No MCP resource metadata link — cannot verify PKCE support");
    const prRaw = metadata.wellKnown["oauth-protected-resource"];
    if (prRaw) {
      try {
        const pr = JSON.parse(prRaw) as Record<string, unknown>;
        const asList = pr.authorization_servers;
        if (Array.isArray(asList) && asList.length > 0) {
          const baseOrigin = new URL(metadata.baseUrl).origin;
          if (!String(asList[0]).startsWith(baseOrigin))
            return res(base, "partial", 50, "MCP-linked authorization server is external — cannot verify PKCE S256 without fetching it");
        }
      } catch { /* ignore parse errors */ }
    }
    const oauthMeta = parseOAuthMetadata(metadata.wellKnown["oauth-authorization-server"]);
    if (oauthMeta?.codeChallengeMethodsSupported?.includes("S256"))
      return res(base, "pass", 100, "PKCE S256 supported via OAuth AS linked from MCP");
    return res(base, "fail", 0, "OAuth authorization server does not declare PKCE S256 support");
  },
};

const d1: Check = {
  ...mk("web-bot-auth-directory", "HTTP message signatures directory", 1.0),
  run: async (_pages, metadata) => {
    const base = mk("web-bot-auth-directory", "HTTP message signatures directory", 1.0);
    const probe = await probeUrl(
      `${metadata.baseUrl}/.well-known/http-message-signatures-directory`,
    );
    if (!probe || probe.status < 200 || probe.status >= 300)
      return res(base, "fail", 0, "No HTTP message signatures directory found");
    try {
      const parsed = JSON.parse(probe.text);
      if (parsed && typeof parsed === "object")
        return res(base, "pass", 100, "HTTP message signatures directory present and valid");
      return res(base, "partial", 50, "HTTP message signatures directory present but malformed");
    } catch {
      return res(base, "partial", 50, "HTTP message signatures directory present but not valid JSON");
    }
  },
};

const d2: Check = {
  ...mk("api-catalog-rfc9727", "API catalog (RFC 9727)", 1.0),
  run: async (_pages, metadata) => {
    const base = mk("api-catalog-rfc9727", "API catalog (RFC 9727)", 1.0);
    const probe = await probeUrl(`${metadata.baseUrl}/.well-known/api-catalog`);
    if (!probe || probe.status < 200 || probe.status >= 300)
      return res(base, "fail", 0, "No API catalog at /.well-known/api-catalog");
    try {
      const parsed = JSON.parse(probe.text) as { apis?: unknown[] };
      if (
        Array.isArray(parsed.apis) &&
        parsed.apis.length > 0 &&
        parsed.apis.every(
          (api): api is Record<string, unknown> =>
            typeof api === "object" && api !== null && "name" in api && "url" in api,
        )
      )
        return res(base, "pass", 100, `API catalog found with ${parsed.apis.length} API(s)`);
      return res(
        base,
        "partial",
        50,
        "API catalog found but missing required fields (apis[].name and apis[].url)",
      );
    } catch {
      return res(base, "partial", 50, "API catalog found but not valid JSON");
    }
  },
};

const d3: Check = {
  ...mk("agent-allowlist", "AI agent allowlist in robots.txt", 1.0),
  run: (_pages, metadata) => {
    const base = mk("agent-allowlist", "AI agent allowlist in robots.txt", 1.0);
    if (!metadata.robotsTxt) return res(base, "fail", 0, "No robots.txt found");

    const blocks = parseRobotsBlocks(metadata.robotsTxt);
    const catchAll = blocks.find((b) => b.userAgent === "*");
    const catchAllBlocked = catchAll !== undefined && catchAll.disallow > 0 && catchAll.allow === 0;

    const aiBotBlocks = blocks.filter((b) =>
      AI_BOTS.some((bot) => b.userAgent.toLowerCase().includes(bot)),
    );
    const explicitAllows = aiBotBlocks.filter((b) => b.allow > 0).length;
    const aiDisallowed = aiBotBlocks.some((b) => b.disallow > 0 && b.allow === 0);

    if (aiDisallowed || (catchAllBlocked && aiBotBlocks.length === 0))
      return res(base, "fail", 0, "AI agents are explicitly blocked in robots.txt");
    if (explicitAllows >= 3)
      return res(base, "pass", 100, `${explicitAllows} AI agents explicitly allowed in robots.txt`);
    if (explicitAllows >= 1)
      return res(
        base,
        "partial",
        50,
        `${explicitAllows} AI agent(s) explicitly allowed in robots.txt`,
      );
    return res(base, "fail", 0, "No AI agents explicitly allowed in robots.txt");
  },
};

const d4: Check = {
  ...mk("mcp-server-card", "MCP server card (mcp.json)", 1.0),
  run: async (_pages, metadata) => {
    const base = mk("mcp-server-card", "MCP server card (mcp.json)", 1.0);
    const probe = await probeUrl(`${metadata.baseUrl}/.well-known/mcp.json`);
    if (!probe || probe.status < 200 || probe.status >= 300)
      return res(base, "fail", 0, "No MCP server card at /.well-known/mcp.json");
    try {
      const parsed = JSON.parse(probe.text) as Record<string, unknown>;
      if (parsed.name && parsed.version && parsed.capabilities)
        return res(base, "pass", 100, `MCP server card: ${parsed.name} v${parsed.version}`);
      return res(
        base,
        "partial",
        50,
        "MCP server card found but missing required fields (name, version, or capabilities)",
      );
    } catch {
      return res(base, "partial", 50, "MCP server card found but not valid JSON");
    }
  },
};

export const agentAuthChecks: Check[] = [
  a1, a2, a3, a4, b1, b2, b3, b4, b5, c1, c2, c3, d1, d2, d3, d4,
];
