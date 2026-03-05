import type { FetchedPage, SiteMetadata } from "../audit/types.js";

export interface GenerateContext {
  pages: PageMarkdown[];
  rawPages: FetchedPage[];
  metadata: SiteMetadata;
  baseUrl: string;
}

export interface GenerateOptions {
  maxPages: number;
  timeout: number;
  userAgent: string;
  /** Output formats to generate */
  formats: GenerateFormat[];
  /** Only include pages under these URL path prefixes (e.g., ["docs", "blog"]) */
  sections?: string[];
}

export type GenerateFormat =
  | "llms-txt"
  | "full"
  | "markdown"
  | "robots-txt"
  | "schema-org"
  | "agent-card"
  | "faq"
  | "mcp-server";

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
  files: GeneratedFile[];
  /** Section names found in llms.txt */
  sections: string[];
  platform?: {
    platform: string;
    confidence: number;
    version?: string;
    details: Record<string, string>;
  };
}

export interface PageMarkdown {
  url: string;
  title: string;
  description: string;
  markdown: string;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  maxPages: 50,
  timeout: 10000,
  userAgent: "w2agent/0.1 (+https://w2agent.dev)",
  formats: ["llms-txt", "full", "markdown", "robots-txt", "schema-org", "agent-card", "faq"],
};
