import { detectPlatform, getAdapter } from "../adapters/registry.js";
import { fetchPage } from "../shared/fetcher.js";
import { getSiteTypeChecks } from "../site-types/checks.js";
import { detectSiteType, type SiteType } from "../site-types/index.js";
import { crawlPages, crawlSite } from "./crawler.js";
import { classifyHomepage } from "./errors.js";
import { withGuide } from "./guides.js";
import { summarizeEdgeEvidence } from "./shared/edge-evidence.js";
import type {
  AuditOptions,
  AuditReport,
  AuditWarning,
  CategoryId,
  CategoryResult,
  Check,
  CheckResult,
  EdgeProbePage,
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
    if (options.prefetchedPages.length > options.maxPages) {
      pages = await reselectPrefetchedPages(
        url,
        options.prefetchedPages,
        metadata,
        options,
        onProgress,
      );
    } else {
      // Prefetched pages are used verbatim here, so this branch needs the same
      // homepage guard as the crawl path — otherwise a challenge page is scored.
      // A list with no page for the audited URL buys the verdict with one
      // guarded fetch, as reselectPrefetchedPages already does; the fetched page
      // is classified only, never scored.
      pages = options.prefetchedPages;
      throwIfUnscorable(
        findHomepage(url, pages) ?? (await fetchPage(url, options)),
        url,
        metadata.edgeProbe,
      );
    }
  } else {
    const crawled = await crawlSite(url, options, onProgress);
    pages = crawled.pages;
    metadata = crawled.metadata;

    throwIfUnscorable(pages[0], url, crawled.metadata.edgeProbe);
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
    checks.map(async (check) => {
      const result = await check.run(pages, metadata, options);
      return check.tracked ? { ...result, tracked: true } : result;
    }),
  );
  applyNaCascade(results, metadata, detectedSiteType?.siteType);
  for (let i = 0; i < results.length; i++) results[i] = withGuide(results[i]);

  // Group by category
  const categories = computeCategories(results);

  // Overall score
  const overallScore = computeOverallScore(categories);
  const grade = computeGrade(overallScore);

  // Top issues
  const topIssues = computeTopIssues(results, categories, overallScore);
  const warnings = computeWarnings(results, metadata);

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

// An empty crawl has no homepage to judge; that stays unguarded, as before.
//
// `edgeProbe` is the multi-UA evidence (§3 D-1) of whatever crawl produced the
// metadata — our own on the crawl path, the caller's on the prefetched paths
// (the platform's deploy route prefetches with core's `crawlSite`, which
// populates it). A caller that truly did no crawl carries no `edgeProbe`, so
// that case still yields no evidence with no special-casing. Only the homepage
// entry crosses the throw.
function throwIfUnscorable(
  homepage: FetchedPage | undefined,
  url: string,
  edgeProbe?: EdgeProbePage[],
): void {
  if (!homepage) return;
  const failure = classifyHomepage(homepage, url);
  if (!failure) return;
  const probedHomepage = edgeProbe?.[0];
  // `evidence` is a readonly field pointing at a mutable literal that
  // `classifyHomepage` built for this error alone.
  if (probedHomepage) failure.evidence.edge = summarizeEdgeEvidence(probedHomepage);
  throw failure;
}

// Only a page for the audited URL itself can be classified. A subpage at index 0
// says nothing about the homepage in either direction.
function findHomepage(url: string, pages: FetchedPage[]): FetchedPage | undefined {
  const key = normalizePageUrl(url);
  return pages.find((p) => normalizePageUrl(p.url) === key);
}

function normalizePageUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    return parsed.href;
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
  throwIfUnscorable(homepage, url, metadata.edgeProbe);

  const { pages } = await crawlPages(url, homepage, metadata, options, { cached, onProgress });
  return pages;
}

function isFailOrNa(r: CheckResult | undefined): boolean {
  if (!r) return true;
  return r.status === "fail" || r.status === "skip";
}

export function applyNaCascade(
  results: CheckResult[],
  metadata: Pick<SiteMetadata, "mcpEndpoint">,
  siteType?: SiteType,
): CheckResult[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const noMcpEndpoint = () => metadata.mcpEndpoint === undefined;
  // §5.6 cascade — order matches §3 dependency graph (acyclic; references only earlier checks).
  // sentinel rows demote even pass/partial targets and zero their score.
  const cascade: Array<{
    id: string;
    naWhen: (m: Map<string, CheckResult>) => boolean;
    sentinel?: boolean;
    message?: string;
  }> = [
    { id: "openapi-spec", naWhen: (m) => isFailOrNa(m.get("public-api")) },
    { id: "developer-portal", naWhen: (m) => isFailOrNa(m.get("public-api")) },
    { id: "agent-auth-docs", naWhen: (m) => isFailOrNa(m.get("developer-portal")) },
    {
      id: "oauth-discovery",
      naWhen: (m) => isFailOrNa(m.get("public-api")) && noMcpEndpoint(),
    },
    { id: "scoped-permissions", naWhen: (m) => isFailOrNa(m.get("developer-portal")) },
    {
      id: "pkce-s256",
      naWhen: (m) => isFailOrNa(m.get("oauth-discovery")) && isFailOrNa(m.get("developer-portal")),
    },
    // MCP-tier checks: NA when no MCP endpoint was confirmed (metadata.mcpEndpoint is the sentinel).
    // Keeps the rubric from punishing sites that haven't adopted an emerging standard they don't claim.
    { id: "mcp-auth", naWhen: noMcpEndpoint, sentinel: true },
    { id: "api-catalog-rfc9727", naWhen: (m) => isFailOrNa(m.get("public-api")) },
    // Non-sentinel: a valid UCP profile on a store the detector missed keeps its pass.
    {
      id: "well-known-ucp",
      naWhen: () => siteType !== "ecommerce",
      message: "Not applicable — site not detected as ecommerce (UCP is a commerce protocol)",
    },
  ];
  for (const { id, naWhen, sentinel, message } of cascade) {
    const r = byId.get(id);
    if (!r) continue;
    if (!sentinel && (r.status === "pass" || r.status === "partial")) continue;
    if (naWhen(byId)) {
      r.status = "skip";
      if (sentinel) r.score = 0;
      r.message = message ?? `Not applicable — dependency unmet (${id} cascade)`;
    }
  }
  return results;
}

function computeWarnings(results: CheckResult[], metadata: SiteMetadata): AuditWarning[] {
  const warnings: AuditWarning[] = [];
  const scored = results.filter((r) => !r.tracked);

  const noJsResult = scored.find((r) => r.id === "no-js-dependency");
  const tokenResult = scored.find((r) => r.id === "token-efficiency");

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

  if (metadata.catchAll === true) {
    warnings.push({
      id: "catch-all-responses",
      title: "Site returns 200 for non-existent paths",
      message:
        "This site answers 200 OK for URLs that do not exist (a catch-all route or soft-404 page). /.well-known/* files were only credited when served as JSON that differs from the response for a missing URL, and developer-portal paths on this domain (such as /developers) were not credited.",
    });
  }

  const unmeasured = scored.filter((r) => r.status === "error").map((r) => r.id);
  if (unmeasured.length > 0) {
    warnings.push({
      id: "unmeasured-checks",
      title: "Some checks could not be measured",
      message:
        "These checks were not measured in this run (for example, the crawler ran out of time, or this crawl did not fetch the page under agent user-agents) and were left out of the score. They are not a finding about the site.",
      details: unmeasured.join(", "),
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
  const applicable = checks.filter(
    (c) => c.status !== "skip" && c.status !== "error" && !c.tracked,
  );
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
    .filter((r) => r.score < 100 && r.status !== "skip" && r.status !== "error" && !r.tracked)
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
    ...(check.guide && check.fixBy ? { guide: check.guide, fixBy: check.fixBy } : {}),
  }));
}

function estimateImpact(check: CheckResult, categories: CategoryResult[]): number {
  const category = categories.find((c) => c.id === check.category);
  if (!category) return 0;

  const categoryWeight = category.weight;
  const applicableChecks = category.checks.filter(
    (c) => c.status !== "skip" && c.status !== "error" && !c.tracked,
  );
  if (applicableChecks.length === 0) return 0;

  const totalCheckWeight = applicableChecks.reduce((sum, c) => sum + c.weight, 0);
  if (totalCheckWeight === 0) return 0;
  const pointsGained = (100 - check.score) * (check.weight / totalCheckWeight);
  return pointsGained * categoryWeight;
}
