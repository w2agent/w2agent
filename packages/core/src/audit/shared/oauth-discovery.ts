import { guardedFetch, type IsAllowedTarget, readBodyCapped } from "../../shared/fetcher.js";
import { isJsonContentType } from "./json.js";
import {
  bearerResourceMetadata,
  type ParsedOAuthMetadata,
  type ParsedProtectedResourceMetadata,
  parseOAuthMetadata,
  parseProtectedResourceMetadata,
} from "./oauth-parser.js";

export const OAUTH_DISCOVERY_BUDGET_MS = 15000;
const PER_FETCH_MS = 5000;
const MAX_METADATA_BYTES = 256 * 1024;

type Deadline = { end: number };
/** Retrieved PRM bodies by URL, shared by the checks of one audit. */
export type PrmBodyCache = Map<string, string>;

/** MCP SDK `checkResourceAllowed`: same origin and requested path within the configured path. */
export function resourceMatches(requested: string, configured: string): boolean {
  let req: URL;
  let conf: URL;
  try {
    req = new URL(requested);
    conf = new URL(configured);
  } catch {
    return false;
  }
  if (req.origin !== conf.origin) return false;
  if (req.pathname.length < conf.pathname.length) return false;
  const reqPath = req.pathname.endsWith("/") ? req.pathname : `${req.pathname}/`;
  const confPath = conf.pathname.endsWith("/") ? conf.pathname : `${conf.pathname}/`;
  return reqPath.startsWith(confPath);
}

/** Issuers must be identical strings; only an origin-only issuer may differ by its trailing "/". */
export function sameIssuer(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (long !== `${short}/` || short.endsWith("/") || /[?#]/.test(short)) return false;
  try {
    return new URL(short).pathname === "/";
  } catch {
    return false;
  }
}

function trimmedPath(url: URL): string {
  return url.pathname.replace(/\/+$/, "");
}

/** RFC 9728 §3.1 well-known URIs for a resource: path-inserted (when it has a path), then root. */
export function wellKnownPrmUrls(resourceUrl: string): string[] {
  const u = new URL(resourceUrl);
  const path = trimmedPath(u);
  const root = `${u.origin}/.well-known/oauth-protected-resource`;
  return path ? [`${root}${path}`, root] : [root];
}

/** MCP 2026-07-28 authorization server metadata discovery order (RFC 8414 + OIDC Discovery). */
export function asMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = trimmedPath(u);
  if (!path) {
    return [
      `${u.origin}/.well-known/oauth-authorization-server`,
      `${u.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchMetadata(
  url: string,
  deadline: Deadline,
  isAllowedTarget?: IsAllowedTarget,
): Promise<string | null> {
  const remaining = deadline.end - Date.now();
  if (remaining <= 0 || !isHttpUrl(url)) return null;
  try {
    const res = await guardedFetch(
      url,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(PER_FETCH_MS, remaining)),
      },
      isAllowedTarget,
    );
    if (res.status !== 200 || !isJsonContentType(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return await readBodyCapped(res, MAX_METADATA_BYTES);
  } catch {
    return null;
  }
}

export type PrmResolution = {
  /** URL of the PRM document that was retrieved (valid or not). */
  url?: string;
  /** Set only when the document is valid for the resource. */
  prm?: ParsedProtectedResourceMetadata;
  problem?: string;
};

export function validatePrm(
  prm: ParsedProtectedResourceMetadata | null,
  resourceUrl: string,
): string | undefined {
  if (!prm) return "is not a JSON object with a string resource";
  if (!resourceMatches(resourceUrl, prm.resource))
    return `resource ${prm.resource} does not match ${resourceUrl}`;
  if (!prm.authorizationServers?.length) return "lists no authorization_servers";
  return undefined;
}

async function resolvePrmWithin(
  resourceUrl: string,
  wwwAuthenticate: string | undefined,
  deadline: Deadline,
  isAllowedTarget: IsAllowedTarget | undefined,
  cache: PrmBodyCache,
): Promise<PrmResolution> {
  const linked = bearerResourceMetadata(wwwAuthenticate);
  const candidates = linked ? [linked] : wellKnownPrmUrls(resourceUrl);
  for (const url of candidates) {
    const text = cache.get(url) ?? (await fetchMetadata(url, deadline, isAllowedTarget));
    if (text === null) continue;
    cache.set(url, text);
    const parsed = parseProtectedResourceMetadata(text);
    const problem = validatePrm(parsed, resourceUrl);
    if (problem || !parsed)
      return { url, problem: `protected resource metadata at ${url} ${problem}` };
    return { url, prm: parsed };
  }
  return {
    problem: linked
      ? `resource_metadata ${linked} could not be retrieved as JSON`
      : `no protected resource metadata at ${candidates.join(" or ")}`,
  };
}

export type AsResolution = { url?: string; as?: ParsedOAuthMetadata; problem?: string };

async function resolveAsWithin(
  issuer: string,
  deadline: Deadline,
  isAllowedTarget?: IsAllowedTarget,
): Promise<AsResolution> {
  if (!isHttpUrl(issuer))
    return { problem: `authorization server ${issuer} is not an http(s) URL` };
  let problem = `no authorization server metadata found for ${issuer}`;
  let incomplete: AsResolution | undefined;
  for (const url of asMetadataUrls(issuer)) {
    const parsed = parseOAuthMetadata((await fetchMetadata(url, deadline, isAllowedTarget)) ?? "");
    if (!parsed) continue;
    if (sameIssuer(parsed.issuer, issuer)) {
      if (hasEndpoints(parsed)) return { url, as: parsed };
      incomplete ??= { url, as: parsed };
      continue;
    }
    problem = `authorization server metadata at ${url} has issuer ${parsed.issuer}, expected ${issuer}`;
  }
  return incomplete ?? { problem };
}

function withinBudget<T>(
  budgetMs: number,
  work: (deadline: Deadline) => Promise<T>,
  onTimeout: () => T,
): Promise<T> {
  const deadline = { end: Date.now() + budgetMs };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), budgetMs);
  });
  return Promise.race([work(deadline), timeout]).finally(() => clearTimeout(timer));
}

export function resolveProtectedResource(
  resourceUrl: string,
  wwwAuthenticate: string | undefined,
  isAllowedTarget?: IsAllowedTarget,
  budgetMs = OAUTH_DISCOVERY_BUDGET_MS,
  cache: PrmBodyCache = new Map(),
): Promise<PrmResolution> {
  return withinBudget<PrmResolution>(
    budgetMs,
    (deadline) => resolvePrmWithin(resourceUrl, wwwAuthenticate, deadline, isAllowedTarget, cache),
    () => ({ problem: "protected resource metadata discovery exceeded its time budget" }),
  );
}

export type OAuthDiscoveryOutcome = "full" | "prm-only" | "root-as" | "none";

export interface OAuthDiscovery {
  outcome: OAuthDiscoveryOutcome;
  resourceUrl?: string;
  prmUrl?: string;
  prm?: ParsedProtectedResourceMetadata;
  /** Set only for "full" and "root-as": issuer-matched metadata with both endpoints. */
  as?: ParsedOAuthMetadata;
  asMetadataUrl?: string;
  problems: string[];
}

export interface ResourceProbe {
  url: string;
  status: number;
  wwwAuthenticate?: string;
}

export interface OAuthDiscoveryInput {
  baseUrl: string;
  /** Unauthenticated responses from protected resources (API, then MCP), in precedence order. */
  resourceProbes: ResourceProbe[];
  wellKnownPrm?: string;
  wellKnownAs?: string;
}

function hasEndpoints(as: ParsedOAuthMetadata | undefined): boolean {
  return Boolean(as?.authorizationEndpoint && as.tokenEndpoint);
}

export function discoverOAuth(
  input: OAuthDiscoveryInput,
  isAllowedTarget?: IsAllowedTarget,
  budgetMs = OAUTH_DISCOVERY_BUDGET_MS,
  cache: PrmBodyCache = new Map(),
): Promise<OAuthDiscovery> {
  const problems: string[] = [];
  let best: OAuthDiscovery | undefined;

  const chainFrom = async (result: OAuthDiscovery, deadline: Deadline): Promise<OAuthDiscovery> => {
    for (const issuer of result.prm?.authorizationServers ?? []) {
      const resolved = await resolveAsWithin(issuer, deadline, isAllowedTarget);
      if (resolved.as && hasEndpoints(resolved.as)) {
        return { ...result, outcome: "full", as: resolved.as, asMetadataUrl: resolved.url };
      }
      if (resolved.as) {
        problems.push(
          `authorization server ${issuer} metadata lacks authorization_endpoint or token_endpoint`,
        );
      } else if (resolved.problem) {
        problems.push(resolved.problem);
      }
    }
    return result;
  };

  const run = async (deadline: Deadline): Promise<OAuthDiscovery> => {
    const origin = new URL(input.baseUrl).origin;
    const rootPrmUrl = `${origin}/.well-known/oauth-protected-resource`;
    if (input.wellKnownPrm !== undefined && !cache.has(rootPrmUrl))
      cache.set(rootPrmUrl, input.wellKnownPrm);
    const seenPrm = new Set<string>();
    const consider = async (
      resourceUrl: string,
      resolution: PrmResolution,
    ): Promise<OAuthDiscovery | undefined> => {
      if (!resolution.prm || !resolution.url) {
        if (resolution.problem && !problems.includes(resolution.problem))
          problems.push(resolution.problem);
        return undefined;
      }
      if (seenPrm.has(resolution.url)) return undefined;
      seenPrm.add(resolution.url);
      const partial: OAuthDiscovery = {
        outcome: "prm-only",
        resourceUrl,
        prmUrl: resolution.url,
        prm: resolution.prm,
        problems,
      };
      if (!best) best = partial;
      const chain = await chainFrom(partial, deadline);
      return chain.outcome === "full" ? chain : undefined;
    };

    for (const probe of input.resourceProbes) {
      if (probe.status !== 401) continue;
      const resolution = await resolvePrmWithin(
        probe.url,
        probe.wwwAuthenticate,
        deadline,
        isAllowedTarget,
        cache,
      );
      const full = await consider(probe.url, resolution);
      if (full) return full;
    }

    if (input.wellKnownPrm !== undefined) {
      const url = rootPrmUrl;
      const parsed = parseProtectedResourceMetadata(input.wellKnownPrm);
      const problem = validatePrm(parsed, `${origin}/`);
      const full = await consider(
        `${origin}/`,
        problem || !parsed
          ? { url, problem: `protected resource metadata at ${url} ${problem}` }
          : { url, prm: parsed },
      );
      if (full) return full;
    }

    if (best) return best;

    const rootAs = parseOAuthMetadata(input.wellKnownAs);
    if (rootAs) {
      if (!sameIssuer(rootAs.issuer, origin)) {
        problems.push(
          `root authorization server metadata has issuer ${rootAs.issuer}, expected ${origin}`,
        );
      } else if (!hasEndpoints(rootAs)) {
        problems.push(
          "root authorization server metadata lacks authorization_endpoint or token_endpoint",
        );
      } else {
        return {
          outcome: "root-as",
          as: rootAs,
          asMetadataUrl: `${origin}/.well-known/oauth-authorization-server`,
          problems,
        };
      }
    }
    return { outcome: "none", problems };
  };

  return withinBudget(budgetMs, run, () => {
    if (best) return { ...best, problems: [...problems] };
    return { outcome: "none", problems: [...problems, "OAuth discovery exceeded its time budget"] };
  });
}
