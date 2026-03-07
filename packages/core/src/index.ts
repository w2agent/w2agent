export { allChecks } from "./audit/checks/index.js";
export { crawlSite } from "./audit/crawler.js";
export {
  clearChecks,
  getRegisteredChecks,
  registerCheck,
  registerChecks,
  runAudit,
} from "./audit/engine.js";
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
export { CATEGORY_CONFIG, DEFAULT_OPTIONS } from "./audit/types.js";
export { generateAgentCard } from "./generate/agent-card.js";
export { runGenerate } from "./generate/engine.js";
export { generateFaq } from "./generate/faq.js";
export { htmlToMarkdown } from "./generate/html-to-markdown.js";
export { generateLlmsFullTxt } from "./generate/llms-full-txt.js";
export { extractSiteInfo, generateLlmsTxt } from "./generate/llms-txt.js";
export {
  detectTools,
  generateMcpServer,
  type McpDetectedTools,
  type SelfHostPlatform,
} from "./generate/mcp-server.js";
export { generateRobotsTxt } from "./generate/robots-txt.js";
export { generateSchemaOrg } from "./generate/schema-org.js";
export { generateSkillMd, type SkillMdOptions } from "./generate/skill-md.js";
// Generate
export type {
  GenerateContext,
  GeneratedFile,
  GenerateFormat,
  GenerateOptions,
  GenerateResult,
  PageMarkdown,
} from "./generate/types.js";
export { DEFAULT_GENERATE_OPTIONS } from "./generate/types.js";
export { loadConfig, mergeConfigWithOptions } from "./shared/config.js";
export { fetchPage, fetchText } from "./shared/fetcher.js";
export { parseHTML } from "./shared/html-parser.js";
export { scoreUrl, sortUrlsByScore } from "./shared/page-scoring.js";

// Adapters (import registers all built-in adapters)
import "./adapters/index.js";

export {
  astroAdapter,
  docusaurusAdapter,
  nextjsAdapter,
  nuxtAdapter,
  shopifyAdapter,
  wordpressAdapter,
} from "./adapters/index.js";
export { allAdapters, detectPlatform, getAdapter, registerAdapter } from "./adapters/registry.js";
export type { PlatformAdapter, PlatformDetectionResult, PlatformId } from "./adapters/types.js";

// Install
export { executeInstallPlan, formatInstallSummary } from "./install/executor.js";
export { planInstall } from "./install/planner.js";
export type { InstallAction, InstallActionType, InstallPlan } from "./install/types.js";
