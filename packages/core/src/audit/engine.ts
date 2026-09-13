import { detectPlatform, getAdapter } from "../adapters/registry.js";
import { fetchPage } from "../shared/fetcher.js";
import { getSiteTypeChecks } from "../site-types/checks.js";
import { detectSiteType } from "../site-types/index.js";
import { crawlPages, crawlSite } from "./crawler.js";
import type {
  AuditOptions,
  AuditReport,
  AuditWarning,
  CategoryId,
  CategoryResult,
  Check,
  CheckResult,
  FetchedPage,
  LetterGrade,
  SiteMetadata,
  TopIssue,
} from "./types.js";
import { CATEGORY_CONFIG as CATEGORIES, DEFAULT_OPTIONS, RUBRIC_VERSION } from "./types.js";

const checkRegistry: Check[] = [];

export function registerCheck(check: Check): void {
  checkRegistry.push(check);
}

export function registerChecks(checks: Check[]): void {
  checks.forEach(registerCheck);
}

export function getRegisteredChecks(): Check[] {
  return [...checkRegistry];
}

export function clearChecks(): void {
  checkRegistry.length = 0;
}

export async function runAudit(
  url: string,
  optionsOverride: Partial<AuditOptions> = {},
  onProgress?: (status: string) => void,
  checksOverride?: Check[],
): Promise<AuditReport> {
  const options: AuditOptions = { ...DEFAULT_OPTIONS, ...optionsOverride };
  const start = Date.now();

  // Crawl
  let pages: FetchedPage[];
  let metadata: SiteMetadata;
  if (options.prefetchedPages?.length && options.prefetchedMetadata) {
    metadata = options.prefetchedMetadata;
    pages =
      options.prefetchedPages.length > options.maxPages
        ? await reselectPrefetchedPages(url, options.prefetchedPages, metadata, options, onProgress)
        : options.prefetchedPages;
  } else {
    const crawled = await crawlSite(url, options, onProgress);
    pages = crawled.pages;
    metadata = crawled.metadata;

    if (pages[0]?.status === 0) {
      throw new Error(
        `Could not reach ${new URL(url).host}. Check the URL or your network connection.`,
      );
    }
  }

  // Detect platform
  const detected = detectPlatform(pages, metadata);
  if (detected) {
    onProgress?.(
      `Detected platform: ${detected.platform} (${Math.round(detected.confidence * 100)}% confidence)`,
    );
  }

  // Detect site type
  const detectedSiteType = detectSiteType(pages, metadata);
  if (detectedSiteType) {
    onProgress?.(
      `Detected site type: ${detectedSiteType.siteType} (${Math.round(detectedSiteType.confidence * 100)}% confidence)`,
    );
  }

  // Use provided checks or fall back to registry
  const sourceChecks = checksOverride ?? checkRegistry;

  // Merge platform-specific checks
  const allChecks = [...sourceChecks];
  if (detected) {
    const adapter = getAdapter(detected.platform);
    if (adapter) allChecks.push(...adapter.checks);
  }

  // Merge site-type-specific checks
  if (detectedSiteType) {
    allChecks.push(...getSiteTypeChecks(detectedSiteType.siteType));
  }

  // Filter checks by selected categories
  const checks = options.categories
    ? allChecks.filter((c) => options.categories?.includes(c.category))
    : [...allChecks];

  // Run checks
  onProgress?.(`Running ${checks.length} checks...`);
  const results: CheckResult[] = await Promise.all(
    checks.map((check) => check.run(pages, metadata)),
  );
  applyNaCascade(results);

  // Group by category
  const categories = computeCategories(results);

  // Overall score
  const overallScore = computeOverallScore(categories);
  const grade = computeGrade(overallScore);

  // Top issues
  const topIssues = computeTopIssues(results, categories, overallScore);
  const warnings = computeWarnings(results);

  const duration = Date.now() - start;

  return {
    url,
    timestamp: new Date().toISOString(),
    duration,
    pagesScanned: pages.length,
    overallScore: Math.round(overallScore),
    grade,
    rubricVersion: RUBRIC_VERSION,
    categories,
    topIssues,
    warnings,
    ...(detected && { platform: detected }),
    ...(detectedSiteType && { siteType: detectedSiteType }),
  };
}

function normalizePageUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return u;
  }
}

async function reselectPrefetchedPages(
  url: string,
  prefetched: FetchedPage[],
  metadata: SiteMetadata,
  options: AuditOptions,
  onProgress?: (status: string) => void,
): Promise<FetchedPage[]> {
  const byUrl = new Map<string, FetchedPage>();
  for (const page of prefetched) {
    const key = normalizePageUrl(page.url);
    if (!byUrl.has(key)) byUrl.set(key, page);
  }
  const cached = (u: string) => byUrl.get(normalizePageUrl(u));

  const homepage = cached(url) ?? (await fetchPage(url, options));
  if (homepage.status === 0) {
    throw new Error(
      `Could not reach ${new URL(url).host}. Check the URL or your network connection.`,
    );
  }

  const { pages } = await crawlPages(url, homepage, metadata, options, { cached, onProgress });
  return pages;
}

function isFailOrNa(r: CheckResult | undefined): boolean {
  if (!r) return true;
  return r.status === "fail" || r.status === "skip";
}

export function applyNaCascade(results: CheckResult[]): CheckResult[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  // §5.6 cascade — order matches §3 dependency graph (acyclic; references only earlier checks).
  const cascade: Array<{ id: string; naWhen: (m: Map<string, CheckResult>) => boolean }> = [
    { id: "openapi-spec", naWhen: (m) => isFailOrNa(m.get("public-api")) },
    { id: "developer-portal", naWhen: (m) => isFailOrNa(m.get("public-api")) },
    { id: "agent-auth-docs", naWhen: (m) => isFailOrNa(m.get("developer-portal")) },
    { id: "oauth-support", naWhen: (m) => isFailOrNa(m.get("public-api")) },
    { id: "oauth-protected-resource", naWhen: (m) => isFailOrNa(m.get("public-api")) },
    { id: "scoped-permissions", naWhen: (m) => isFailOrNa(m.get("developer-portal")) },
    {
      id: "pkce-s256",
      naWhen: (m) => isFailOrNa(m.get("oauth-support")) && isFailOrNa(m.get("developer-portal")),
    },
    // MCP-tier checks: NA when the site has no MCP signal at all (mcp-discovery is the sentinel).
    // Keeps the rubric from punishing sites that haven't adopted an emerging standard they don't claim.
    { id: "mcp-auth-mechanism", naWhen: (m) => isFailOrNa(m.get("mcp-discovery")) },
    { id: "mcp-oauth-metadata", naWhen: (m) => isFailOrNa(m.get("mcp-discovery")) },
    { id: "oauth-metadata-rfc9728", naWhen: (m) => isFailOrNa(m.get("mcp-discovery")) },
    { id: "mcp-pkce-s256", naWhen: (m) => isFailOrNa(m.get("mcp-oauth-metadata")) },
    { id: "api-catalog-rfc9727", naWhen: (m) => isFailOrNa(m.get("public-api")) },
    { id: "mcp-server-card", naWhen: (m) => isFailOrNa(m.get("mcp-discovery")) },
  ];
  for (const { id, naWhen } of cascade) {
    const r = byId.get(id);
    if (!r) continue;
    if (r.status === "pass" || r.status === "partial") continue;
    if (naWhen(byId)) {
      r.status = "skip";
      r.message = `Not applicable — dependency unmet (${id} cascade)`;
    }
  }
  return results;
}

function computeWarnings(results: CheckResult[]): AuditWarning[] {
  const warnings: AuditWarning[] = [];

  const noJsResult = results.find((r) => r.id === "no-js-dependency");
  const tokenResult = results.find((r) => r.id === "token-efficiency");

  const noJsScore = noJsResult?.score ?? 100;
  const tokenScore = tokenResult?.score ?? 100;

  const isJsHeavy = noJsScore <= 30 || (noJsScore <= 50 && tokenScore <= 30);

  if (isJsHeavy) {
    warnings.push({
      id: "js-heavy-site",
      title: "JavaScript-dependent content detected",
      message:
        "This site appears to use client-side rendering. Audit scores may be lower than actual quality — AI crawlers that don't execute JavaScript will see minimal content. Consider server-side rendering (SSR) or pre-rendering.",
      details: noJsResult?.details,
    });
  }

  return warnings;
}

function computeCategories(results: CheckResult[]): CategoryResult[] {
  const grouped = new Map<CategoryId, CheckResult[]>();
  for (const r of results) {
    const list = grouped.get(r.category) || [];
    list.push(r);
    grouped.set(r.category, list);
  }

  const categories: CategoryResult[] = [];
  for (const [id, config] of Object.entries(CATEGORIES)) {
    const catId = id as CategoryId;
    const checks = grouped.get(catId) || [];
    const score = computeCategoryScore(checks);
    categories.push({
      id: catId,
      name: config.name,
      weight: config.weight,
      score: score === null ? null : Math.round(score),
      checks,
    });
  }

  return categories;
}

export function computeCategoryScore(checks: CheckResult[]): number | null {
  const applicable = checks.filter((c) => c.status !== "skip");
  if (applicable.length === 0) return null;
  const totalWeight = applicable.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return null;
  return applicable.reduce((sum, c) => sum + (c.score * c.weight) / totalWeight, 0);
}

export function computeOverallScore(categories: CategoryResult[]): number {
  const scored = categories.filter((c) => c.score !== null);
  if (scored.length === 0) return 0;
  const totalWeight = scored.reduce((sum, c) => sum + c.weight, 0);
  return scored.reduce((sum, c) => sum + (c.score as number) * (c.weight / totalWeight), 0);
}

function computeGrade(score: number): LetterGrade {
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 45) return "C";
  if (score >= 30) return "D";
  return "F";
}

function computeTopIssues(
  results: CheckResult[],
  categories: CategoryResult[],
  _overallScore: number,
): TopIssue[] {
  const failedChecks = results
    .filter((r) => r.score < 100 && r.status !== "skip")
    .sort((a, b) => {
      // Sort by potential impact (how many overall points fixing would add)
      const aImpact = estimateImpact(a, categories);
      const bImpact = estimateImpact(b, categories);
      return bImpact - aImpact;
    });

  return failedChecks.slice(0, 5).map((check) => ({
    checkId: check.id,
    message: check.message,
    pointsIfFixed: Math.round(estimateImpact(check, categories)),
    fixSnippet: check.fixSnippet,
  }));
}

function estimateImpact(check: CheckResult, categories: CategoryResult[]): number {
  const category = categories.find((c) => c.id === check.category);
  if (!category) return 0;

  const categoryWeight = category.weight;
  const applicableChecks = category.checks.filter((c) => c.status !== "skip");
  if (applicableChecks.length === 0) return 0;

  const totalCheckWeight = applicableChecks.reduce((sum, c) => sum + c.weight, 0);
  if (totalCheckWeight === 0) return 0;
  const pointsGained = (100 - check.score) * (check.weight / totalCheckWeight);
  return pointsGained * categoryWeight;
}
