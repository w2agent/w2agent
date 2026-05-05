export type Severity = "error" | "warning" | "info";

export type CheckStatus = "pass" | "fail" | "partial" | "skip";

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

export const RUBRIC_VERSION = "2.0";

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
}

export interface McpInitResult {
  mcpEndpointUrl: string;
  success: boolean;
  status?: number;
  serverInfo?: { name: string; version?: string; authMechanism?: string };
  rawHeaders?: Record<string, string>;
  linkHeader?: string;
  oauthResourceMetadataUrl?: string;
}

export interface SiteMetadata {
  baseUrl: string;
  robotsTxt?: string;
  sitemapXml?: string;
  llmsTxt?: string;
  wellKnown: Record<string, string | undefined>;
  openapi?: ParsedOpenAPISpec;
  mcpInit?: McpInitResult;
}

export interface Check {
  id: string;
  name: string;
  category: CategoryId;
  weight: number;
  severity: Severity;
  run: (pages: FetchedPage[], metadata: SiteMetadata) => CheckResult | Promise<CheckResult>;
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
}

export const DEFAULT_OPTIONS: AuditOptions = {
  maxPages: 20,
  timeout: 10000,
  verbose: false,
  userAgent: "w2agent/0.1 (+https://w2agent.dev)",
  concurrency: 3,
  requestDelay: 200,
};

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
