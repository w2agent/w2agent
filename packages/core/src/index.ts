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
