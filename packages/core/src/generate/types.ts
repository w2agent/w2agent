import type { AuditOptions, FetchedPage, SiteMetadata } from "../audit/types.js";

export interface GenerateContext {
  pages: PageMarkdown[];
  rawPages: FetchedPage[];
  metadata: SiteMetadata;
  baseUrl: string;
  siteType?: {
    siteType: string;
    confidence: number;
    signals: string[];
  };
  /** Off-origin hosts allowed for generated-tool fetch targets. */
  allowedOffOriginHosts?: string[];
}

export interface GenerateOptions {
  maxPages: number;
  timeout: number;
  userAgent: string;
  /** Output formats to generate */
  formats: GenerateFormat[];
  /** Only include pages under these URL path prefixes (e.g., ["docs", "blog"]) */
  sections?: string[];
  /** MCP server endpoint URL for SKILL.md generation */
  mcpEndpoint?: string;
  /** A2A endpoint URL for agent-card.json supportedInterfaces; without it no agent card is generated */
  a2aEndpoint?: string;
  /** Off-origin hosts allowed for generated-tool fetch targets. */
  allowedOffOriginHosts?: string[];
  /** Gate applied to every crawl fetch target and redirect hop (see AuditOptions). */
  isAllowedTarget?: AuditOptions["isAllowedTarget"];
  /** Append detected-platform integration files (nextjs/, nuxt/, ...) to the output. Default true. */
  platformFiles?: boolean;
}

export type GenerateFormat =
  | "llms-txt"
  | "full"
  | "markdown"
  | "robots-txt"
  | "schema-org"
  | "agent-card"
  | "faq"
  | "mcp-server"
  | "skill-md"
  | "webmcp"
  | "openclaw"
  | "agents-md";

export interface GeneratedFile {
  filename: string;
  content: string;
  /** Size in bytes */
  size: number;
}

export interface GenerateResult {
  url: string;
  duration: number;
  pagesProcessed: number;
  /** Distinct pages fetched with status 200 and HTML, before markdown conversion and section filtering */
  pagesFetched: number;
  /** Total pages discovered (sitemap + links) before applying maxPages limit */
  totalPagesFound: number;
  files: GeneratedFile[];
  /** Section names found in llms.txt */
  sections: string[];
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

export interface ExtractedFormField {
  name: string;
  type: string;
  required: boolean;
  label?: string;
  options?: string[];
  pattern?: string;
  min?: string;
  max?: string;
  maxlength?: number;
}

export interface ExtractedForm {
  action: string;
  method: string;
  fields: ExtractedFormField[];
  id?: string;
  name?: string;
}

export interface PageMarkdown {
  url: string;
  title: string;
  description: string;
  markdown: string;
  forms?: ExtractedForm[];
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  maxPages: 100,
  timeout: 10000,
  userAgent: "w2agent/0.1 (+https://w2agent.dev)",
  formats: [
    "llms-txt",
    "agents-md",
    "full",
    "markdown",
    "robots-txt",
    "schema-org",
    "agent-card",
    "faq",
  ],
};
