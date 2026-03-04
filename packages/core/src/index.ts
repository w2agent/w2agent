export type {
  AuditOptions,
  AuditReport,
  CategoryId,
  CategoryResult,
  Check,
  CheckResult,
  CheckStatus,
  FetchedPage,
  LetterGrade,
  Severity,
  SiteMetadata,
  TopIssue,
} from "./audit/types.js";

export { DEFAULT_OPTIONS, CATEGORY_CONFIG } from "./audit/types.js";
export { runAudit, registerCheck, registerChecks, clearChecks, getRegisteredChecks } from "./audit/engine.js";
export { crawlSite } from "./audit/crawler.js";
export { allChecks } from "./audit/checks/index.js";
export { parseHTML } from "./shared/html-parser.js";
export { fetchPage, fetchText } from "./shared/fetcher.js";
export { loadConfig, mergeConfigWithOptions } from "./shared/config.js";

// Generate
export type {
  GenerateOptions,
  GenerateFormat,
  GenerateContext,
  GenerateResult,
  GeneratedFile,
  PageMarkdown,
} from "./generate/types.js";
export { DEFAULT_GENERATE_OPTIONS } from "./generate/types.js";
export { runGenerate } from "./generate/engine.js";
export { htmlToMarkdown } from "./generate/html-to-markdown.js";
export { generateLlmsTxt, extractSiteInfo } from "./generate/llms-txt.js";
export { generateLlmsFullTxt } from "./generate/llms-full-txt.js";
export { generateRobotsTxt } from "./generate/robots-txt.js";
export { generateSchemaOrg } from "./generate/schema-org.js";
export { generateAgentCard } from "./generate/agent-card.js";
export { generateFaq } from "./generate/faq.js";

// Adapters (import registers all built-in adapters)
import "./adapters/index.js";
export type { PlatformId, PlatformDetectionResult, PlatformAdapter } from "./adapters/types.js";
export { detectPlatform, getAdapter, registerAdapter, allAdapters } from "./adapters/registry.js";
export { wordpressAdapter, nextjsAdapter, shopifyAdapter, docusaurusAdapter } from "./adapters/index.js";
