export { allChecks } from "./audit/checks/index.js";
export { crawlSite, probeSiteMetadata } from "./audit/crawler.js";
export {
  clearChecks,
  getRegisteredChecks,
  registerCheck,
  registerChecks,
  runAudit,
} from "./audit/engine.js";
export type {
  AuditErrorEvidence,
  AuditErrorKind,
  EdgeEvidence,
  EdgeEvidenceAgent,
  EdgeVerdict,
  FetchFailure,
} from "./audit/errors.js";
export { AuditError, classifyHomepage } from "./audit/errors.js";
export type { ChallengeVendor } from "./audit/shared/challenge.js";
export { detectChallenge } from "./audit/shared/challenge.js";
export { formatEdgeEvidenceLine, summarizeEdgeEvidence } from "./audit/shared/edge-evidence.js";
export type {
  AuditOptions,
  AuditReport,
  AuditWarning,
  CategoryId,
  CategoryResult,
  Check,
  CheckResult,
  CheckStatus,
  FetchedPage,
  LetterGrade,
  OpenAPIEndpoint,
  OpenAPIParameter,
  OpenAPIRequestBody,
  ParsedOpenAPISpec,
  Severity,
  SiteMetadata,
  TopIssue,
} from "./audit/types.js";
export {
  AUDIT_CRAWL_PROFILE,
  AUDIT_CRAWL_PROFILE_ID,
  CATEGORY_CONFIG,
  DEFAULT_OPTIONS,
  RUBRIC_VERSION,
} from "./audit/types.js";
export type { DiscoveredPage } from "./crawl/index.js";
export {
  discoverInternalLinks,
  discoverPages,
  parseSitemapWithMetadata,
  scorePage,
  selectPages,
  sortPagesByScore,
} from "./crawl/index.js";
export { generateAgentCard } from "./generate/agent-card.js";
export { generateAgentsMd } from "./generate/agents-md.js";
export { runGenerate } from "./generate/engine.js";
export { generateFaq } from "./generate/faq.js";
export {
  CHECK_TO_FORMAT,
  type FromAuditResult,
  mapFailedChecksToFormats,
} from "./generate/from-audit.js";
export { htmlToMarkdown } from "./generate/html-to-markdown.js";
export { generateLlmsFullTxt } from "./generate/llms-full-txt.js";
export { extractSiteInfo, generateLlmsTxt } from "./generate/llms-txt.js";
export {
  detectTools,
  generateMcpServer,
  type McpDetectedTools,
  type SelfHostPlatform,
} from "./generate/mcp-server.js";
export { generateRobotsAdditions, generateRobotsTxt } from "./generate/robots-txt.js";
export { generateSchemaOrg } from "./generate/schema-org.js";
export { generateSkillMd, type SkillMdOptions } from "./generate/skill-md.js";
export {
  generateOpenClawSkillMd,
  type OpenClawSkillMdOptions,
} from "./generate/skill-md-openclaw.js";
export type {
  GenerateContext,
  GeneratedFile,
  GenerateFormat,
  GenerateOptions,
  GenerateResult,
  PageMarkdown,
} from "./generate/types.js";
export { DEFAULT_GENERATE_OPTIONS } from "./generate/types.js";
export { generateWebMcp } from "./generate/webmcp.js";
export { loadConfig, mergeConfigWithOptions } from "./shared/config.js";
export type { IsAllowedTarget } from "./shared/fetcher.js";
export { fetchPage, fetchText, guardedFetch, TargetNotAllowedError } from "./shared/fetcher.js";
export { parseHTML } from "./shared/html-parser.js";
export { parseOpenAPISpec, probeOpenAPIPaths } from "./shared/openapi.js";
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

// Site Types (import registers all built-in detectors)
import "./site-types/index.js";

export {
  buildLocalBusinessArtifacts,
  type ExtractedLocalBusiness,
  extractLocalBusiness,
  extractLocalBusinessFromHtml,
  extractLocalBusinessFromJsonLd,
  extractLocalBusinessFromMicrodata,
  generateBusinessInfoTable,
  generateLocalBusinessToolHandlers,
  type LocalBusinessArtifacts,
  type OpeningHours,
} from "./generate/local-business.js";
// Install
export { executeInstallPlan, formatInstallSummary } from "./install/executor.js";
export { planInstall } from "./install/planner.js";
export type { InstallAction, InstallActionType, InstallPlan } from "./install/types.js";
export type { SiteTypeCheckAdapter } from "./site-types/checks.js";
export { getSiteTypeChecks, registerSiteTypeChecks } from "./site-types/checks.js";
export { ecommerceDetector } from "./site-types/ecommerce.js";
export { localBusinessDetector } from "./site-types/local-business.js";
export { detectSiteType, registerSiteTypeDetector } from "./site-types/registry.js";
export type { SiteType, SiteTypeDetectionResult, SiteTypeDetector } from "./site-types/types.js";
