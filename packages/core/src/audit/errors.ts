import { type ChallengeVendor, detectChallenge } from "./shared/challenge.js";
import type { FetchedPage, MultiUaResponse } from "./types.js";

export const CHALLENGE_BODY_PREFIX_BYTES = 4 * 1024;

export type AuditErrorKind =
  | "unreachable"
  | "blocked"
  | "auth_gated"
  | "rate_limited"
  | "timeout"
  | "unknown_failure";

export type EdgeVerdict = "all-blocked" | "agents-allowed" | "mixed" | "unknown";

export interface EdgeEvidenceAgent {
  token: string;
  status: number;
  outcome: MultiUaResponse["outcome"];
  challenge?: { vendor: ChallengeVendor; signal: string };
  /** Status seen on the wire before a body-read error erased the response. */
  observedStatus?: number;
}

export interface EdgeEvidence {
  verdict: EdgeVerdict;
  control: { status: number; vendor?: ChallengeVendor; signal?: string };
  agents: EdgeEvidenceAgent[];
  notProbed: Array<{ token: string; reason: "no-ua-string" | "extra-pages-only" }>;
}

export interface AuditErrorEvidence {
  status?: number;
  vendor?: ChallengeVendor;
  signal?: string;
  cause?: string;
  /** Homepage agent-UA evidence, attached by the engine from whatever crawl produced the metadata. */
  edge?: EdgeEvidence;
}

export interface FetchFailure {
  kind: AuditErrorKind;
  status?: number;
  cause?: string;
  challenge?: { vendor: ChallengeVendor; signal: string };
}

export class AuditError extends Error {
  readonly name = "AuditError";

  constructor(
    readonly kind: AuditErrorKind,
    message: string,
    readonly evidence: AuditErrorEvidence = {},
  ) {
    super(message);
  }
}

const VENDOR_LABELS: Record<ChallengeVendor, string> = {
  cloudflare: "Cloudflare",
  akamai: "Akamai",
  datadome: "DataDome",
  perimeterx: "PerimeterX",
  imperva: "Imperva",
  "aws-waf": "AWS WAF",
  unknown: "vendor unknown",
};

const TIMEOUT_CAUSES = new Set([
  "AbortError",
  "TimeoutError",
  "ETIMEDOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/**
 * Maps the facts a fetch attempt collected onto the §3 D-2 vocabulary. Kept in
 * one place so the fetcher and the engine cannot drift apart.
 */
export function fetchFailureKind(detail: {
  status?: number;
  cause?: string;
  challenge?: { vendor: ChallengeVendor; signal: string };
}): AuditErrorKind {
  if (detail.challenge) return "blocked";
  if (detail.status === 429) return "rate_limited";
  if (detail.status === 503) return "unknown_failure";
  if (detail.cause && TIMEOUT_CAUSES.has(detail.cause)) return "timeout";
  return "unreachable";
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function messageFor(kind: AuditErrorKind, host: string, evidence: AuditErrorEvidence): string {
  switch (kind) {
    case "unreachable":
      return `Could not reach ${host}. Check the URL or your network connection.`;
    case "blocked": {
      const vendor = VENDOR_LABELS[evidence.vendor ?? "unknown"];
      return `${host} served an anti-bot challenge (${vendor}) to w2agent's crawler. Allow the w2agent user-agent to audit it.`;
    }
    case "auth_gated":
      return `${host} requires authentication (HTTP 401) before it can be read. Audit a page that is reachable without signing in.`;
    case "rate_limited":
      return `${host} rate-limited w2agent's crawler (HTTP 429 after retries). Try again later, or raise the rate limit for the w2agent user-agent.`;
    case "timeout":
      return `${host} did not respond in time after retries. Try again later, or allow a longer request timeout.`;
    case "unknown_failure":
      return `${host} refused w2agent's crawler with HTTP ${evidence.status ?? "an error"} and no challenge or authentication signal. Check the server or its WAF rules, then re-run the audit.`;
  }
}

export function auditError(
  kind: AuditErrorKind,
  url: string,
  evidence: AuditErrorEvidence = {},
): AuditError {
  return new AuditError(kind, messageFor(kind, hostOf(url), evidence), evidence);
}

/**
 * Decides whether a homepage response can be scored at all (§3 D-2). Returns
 * null when the audit should proceed — including 2xx, 3xx-terminal, 404 and
 * 5xx other than 503.
 *
 * Runs on the final response, after redirects and retries. Deliberately usable
 * without `runAudit` so a bare `fetchPage` + classify pass can survey a site
 * list.
 */
export function classifyHomepage(page: FetchedPage, url: string): AuditError | null {
  const failure = page.fetchFailure;
  if (failure) {
    return auditError(failure.kind, url, {
      ...(failure.status !== undefined && failure.status > 0 ? { status: failure.status } : {}),
      ...(failure.challenge
        ? { vendor: failure.challenge.vendor, signal: failure.challenge.signal }
        : {}),
      ...(failure.cause ? { cause: failure.cause } : {}),
    });
  }

  if (page.status === 0) return auditError("unreachable", url, {});

  const challenge = detectChallenge(
    page.status,
    page.headers,
    page.html.slice(0, CHALLENGE_BODY_PREFIX_BYTES),
  );
  if (challenge) {
    return auditError("blocked", url, {
      status: page.status,
      vendor: challenge.vendor,
      signal: challenge.signal,
    });
  }

  if (page.status === 401 && header(page.headers, "www-authenticate") !== undefined) {
    return auditError("auth_gated", url, { status: 401 });
  }

  if (page.status === 403) return auditError("unknown_failure", url, { status: 403 });

  // A 429/503 handed in directly (fetchPage never returns one: retryableFetch
  // retries both and reports exhaustion as status 0 + fetchFailure).
  if (page.status === 429) return auditError("rate_limited", url, { status: 429 });
  if (page.status === 503) return auditError("unknown_failure", url, { status: 503 });

  return null;
}
