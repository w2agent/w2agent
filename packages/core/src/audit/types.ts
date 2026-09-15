import type { FetchFailure } from "./errors.js";
import type { ChallengeVendor } from "./shared/challenge.js";

export type Severity = "error" | "warning" | "info";

export type CheckStatus = "pass" | "fail" | "partial" | "skip" | "error";

export interface CheckResult {
  id: string;
  name: string;
  category: CategoryId;
  status: CheckStatus;
  score: number; // 0-100
  maxScore: number; // always 100
  weight: number; // relative weight within category
  message: string;
  details?: string;
  fixSnippet?: string;
  severity: Severity;
  tracked?: boolean; // reported but excluded from scoring, top issues, and warnings
}

export type CategoryId =
  | "bot-accessibility"
  | "structured-data"
  | "content-quality"
  | "agent-discovery"
  | "agent-protocols"
  | "technical"
  | "agent-auth";

export interface CategoryResult {
  id: CategoryId;
  name: string;
  weight: number;
  score: number | null; // 0-100, or null when all checks are skipped
  checks: CheckResult[];
}

export type LetterGrade = "A" | "B" | "C" | "D" | "F";

export interface TopIssue {
  checkId: string;
  message: string;
  pointsIfFixed: number;
  fixSnippet?: string;
}

export interface AuditWarning {
  id: string;
  title: string;
  message: string;
  details?: string;
}

export const RUBRIC_VERSION = "3.0";

export interface AuditReport {
  url: string;
  timestamp: string;
  duration: number; // ms
  pagesScanned: number;
  overallScore: number;
  grade: LetterGrade;
  rubricVersion: string;
  categories: CategoryResult[];
  topIssues: TopIssue[];
  warnings: AuditWarning[];
  summary?: string;
  platform?: {
    platform: string;
    confidence: number;
    version?: string;
    details: Record<string, string>;
  };
  siteType?: {
    siteType: string;
    confidence: number;
    signals: string[];
  };
}

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  headers: Record<string, string>;
  responseTime: number; // ms
  /**
   * Why this fetch produced no scorable response. Set only when `status === 0`
   * or the response was withheld (a challenge stops the retry loop and its body
   * is consumed for fingerprinting). Optional: every existing consumer ignores it.
   */
  fetchFailure?: FetchFailure;
}

export interface McpInitResult {
  mcpEndpointUrl: string;
  success: boolean;
  status?: number;
  serverInfo?: { name: string; version?: string };
  rawHeaders?: Record<string, string>;
  oauthResourceMetadataUrl?: string;
  transport?: "streamable-http" | "http+sse";
}

export interface MultiUaResponse {
  /**
   * The BOT_TOKENS token this result was fetched under, e.g. "ChatGPT-User".
   * The literal "control" marks a fetch under our own declared crawler UA
   * (`EdgeProbePage.control`); it is never one of the probed agent tokens.
   */
  token: string;
  /** The URL probed (before redirects; see `finalUrl`). */
  url: string;
  status: number;
  contentLength: number;
  finalUrl: string;
  /** True when the final response was 2xx with a non-empty body. */
  reachable: boolean;
  /** "ok" = response received; "budget-skipped" = never fetched (time budget exhausted). */
  outcome: "ok" | "fetch-error" | "budget-skipped" | "timeout";
  /** Edge-relevant response headers. Empty when no response was received. */
  headers: { cfMitigated?: string; server?: string; retryAfter?: string };
  /** Set when the response fingerprints as an anti-bot challenge (first 4 KB of body). */
  challenge?: { vendor: ChallengeVendor; signal: string };
  /**
   * Edge-only: the status the wire actually carried when the body read failed
   * afterwards (`outcome: "fetch-error" | "timeout"`, `status: 0`). Undefined
   * when no response header block arrived at all. `reach-*` never reads it —
   * `status`/`reachable`/`outcome` keep their old "did not answer" values.
   */
  observedStatus?: number;
}

/** One probed page of the multi-UA pass: our declared crawler vs the agent UAs. */
export interface EdgeProbePage {
  url: string;
  /**
   * Our declared crawler's own single-shot fetch of this URL, in the same shape
   * as the agent results (token `"control"`). The page is comparable evidence
   * only when this is `outcome: "ok"`, 2xx and challenge-free.
   */
  control: MultiUaResponse;
  /**
   * The agent-UA results. Empty on an extra page whose control was not
   * comparable, since its agent fetches are then skipped; the homepage always
   * carries a row per probed UA (its control runs last).
   */
  results: MultiUaResponse[];
}

export interface SiteMetadata {
  baseUrl: string;
  robotsTxt?: string;
  /** HTTP status of the robots.txt fetch; after 429/503 retries it is the last status; 0 = no response (network error, timeout). */
  robotsTxtStatus?: number;
  sitemapXml?: string;
  llmsTxt?: string;
  wellKnown: Record<string, string | undefined>;
  openapi?: ParsedOpenAPISpec;
  mcpInit?: McpInitResult;
  mcpEndpoint?: string;
  multiUaResponses?: Record<string, MultiUaResponse>;
  /**
   * Per-page edge evidence. `edgeProbe[0]` is the homepage and its `results`
   * are the very objects `multiUaResponses` holds — one source of truth.
   */
  edgeProbe?: EdgeProbePage[];
  catchAll?: boolean;
}

export interface Check {
  id: string;
  name: string;
  category: CategoryId;
  weight: number;
  severity: Severity;
  tracked?: boolean;
  run: (
    pages: FetchedPage[],
    metadata: SiteMetadata,
    ctx?: Pick<AuditOptions, "isAllowedTarget">,
  ) => CheckResult | Promise<CheckResult>;
}

export interface AuditOptions {
  maxPages: number;
  timeout: number; // ms per request
  categories?: CategoryId[];
  verbose: boolean;
  userAgent: string;
  concurrency?: number; // max parallel fetches (default 3)
  requestDelay?: number; // min ms between request starts (default 200)
  pageRankings?: Map<string, number>; // url → 1-based rank from search engine
  prefetchedPages?: FetchedPage[];
  prefetchedMetadata?: SiteMetadata;
  /**
   * Off-origin hostnames allowed for generated-tool fetch targets (OpenAPI
   * servers[].url, form actions, Swagger-UI spec URLs). Private-IP hosts are
   * always rejected even when allowlisted.
   */
  allowedOffOriginHosts?: string[];
  /**
   * Gate applied to every audit fetch target and each redirect hop. Returning
   * false (or throwing) refuses the fetch. Unset = native fetch behaviour.
   */
  isAllowedTarget?: (url: string) => boolean | Promise<boolean>;
}

export const DEFAULT_OPTIONS: AuditOptions = {
  maxPages: 20,
  timeout: 10000,
  verbose: false,
  userAgent: "w2agent/0.1 (+https://w2agent.dev)",
  concurrency: 3,
  requestDelay: 200,
};

export const AUDIT_CRAWL_PROFILE = {
  maxPages: 10,
  timeout: 10000,
} as const satisfies Readonly<Pick<AuditOptions, "maxPages" | "timeout">>;

export const AUDIT_CRAWL_PROFILE_ID: string = `maxPages=${AUDIT_CRAWL_PROFILE.maxPages};timeout=${AUDIT_CRAWL_PROFILE.timeout}`;

export const CATEGORY_CONFIG: Record<CategoryId, { name: string; weight: number }> = {
  "bot-accessibility": { name: "Bot Accessibility", weight: 0.15 },
  "structured-data": { name: "Structured Data", weight: 0.15 },
  "content-quality": { name: "Content Quality", weight: 0.15 },
  "agent-discovery": { name: "Agent Discovery", weight: 0.12 },
  "agent-protocols": { name: "Agent Protocols", weight: 0.13 },
  technical: { name: "Technical Foundations", weight: 0.1 },
  "agent-auth": { name: "Auth & Access", weight: 0.2 },
};

export interface OpenAPIParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  type?: string;
  required: boolean;
  description?: string;
}

export interface OpenAPIRequestBody {
  contentType: string;
  required: boolean;
  properties: Record<string, { type?: string; description?: string }>;
}

export interface OpenAPIEndpoint {
  path: string;
  method: string;
  operationId?: string;
  summary?: string;
  description?: string;
  parameters: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
}

export interface ParsedOpenAPISpec {
  specUrl: string;
  version: string;
  title?: string;
  description?: string;
  serverUrl?: string;
  endpoints: OpenAPIEndpoint[];
}
