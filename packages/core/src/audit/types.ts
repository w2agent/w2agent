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
  | "technical";

export interface CategoryResult {
  id: CategoryId;
  name: string;
  weight: number;
  score: number; // 0-100
  checks: CheckResult[];
}

export type LetterGrade = "A" | "B" | "C" | "D" | "F";

export interface TopIssue {
  checkId: string;
  message: string;
  pointsIfFixed: number;
  fixSnippet?: string;
}

export interface AuditReport {
  url: string;
  timestamp: string;
  duration: number; // ms
  pagesScanned: number;
  overallScore: number;
  grade: LetterGrade;
  categories: CategoryResult[];
  topIssues: TopIssue[];
  platform?: {
    platform: string;
    confidence: number;
    version?: string;
    details: Record<string, string>;
  };
}

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  headers: Record<string, string>;
  responseTime: number; // ms
}

export interface SiteMetadata {
  baseUrl: string;
  robotsTxt?: string;
  sitemapXml?: string;
  llmsTxt?: string;
  wellKnown: Record<string, string | undefined>;
  openapi?: ParsedOpenAPISpec;
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
}

export const DEFAULT_OPTIONS: AuditOptions = {
  maxPages: 20,
  timeout: 10000,
  verbose: false,
  userAgent: "w2agent/0.1 (+https://w2agent.dev)",
};

export const CATEGORY_CONFIG: Record<CategoryId, { name: string; weight: number }> = {
  "bot-accessibility": { name: "Bot Accessibility", weight: 0.2 },
  "structured-data": { name: "Structured Data", weight: 0.2 },
  "content-quality": { name: "Content Quality", weight: 0.2 },
  "agent-discovery": { name: "Agent Discovery", weight: 0.15 },
  "agent-protocols": { name: "Agent Protocols", weight: 0.15 },
  technical: { name: "Technical Foundations", weight: 0.1 },
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
