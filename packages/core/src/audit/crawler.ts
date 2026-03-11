import robotsParser from "robots-parser";
import { fetchPage, fetchText } from "../shared/fetcher.js";
import { probeOpenAPIPaths } from "../shared/openapi.js";
import { sortUrlsByScore } from "../shared/page-scoring.js";
import type { AuditOptions, FetchedPage, SiteMetadata } from "./types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface CrawlResult {
  pages: FetchedPage[];
  metadata: SiteMetadata;
  /** Total URLs discovered (sitemap) before applying maxPages limit */
  totalUrlsFound: number;
}

export async function crawlSite(
  url: string,
  options: AuditOptions,
  onProgress?: (status: string) => void,
): Promise<CrawlResult> {
  const base = new URL(url);
  const baseUrl = `${base.protocol}//${base.host}`;

  onProgress?.("Fetching homepage...");
  const homepage = await fetchPage(url, options);

  onProgress?.("Fetching robots.txt...");
  const [robotsResult, sitemapResult, llmsResult, openapiResult] = await Promise.all([
    fetchText(`${baseUrl}/robots.txt`, options),
    fetchText(`${baseUrl}/sitemap.xml`, options),
    fetchText(`${baseUrl}/llms.txt`, options),
    probeOpenAPIPaths(baseUrl, options, { homepageHtml: homepage.html }),
  ]);

  onProgress?.("Fetching .well-known files...");
  const wellKnownPaths = ["agent-card.json", "agents.json", "ara/manifest.json", "mcp", "ucp"];
  const wellKnownResults = await Promise.all(
    wellKnownPaths.map(async (path) => {
      const result = await fetchText(`${baseUrl}/.well-known/${path}`, options);
      return [path, result?.status === 200 ? result.text : undefined] as const;
    }),
  );

  const wellKnown: Record<string, string | undefined> = {};
  for (const [path, content] of wellKnownResults) {
    wellKnown[path] = content;
  }

  const metadata: SiteMetadata = {
    baseUrl,
    robotsTxt: robotsResult?.status === 200 ? robotsResult.text : undefined,
    sitemapXml: sitemapResult?.status === 200 ? sitemapResult.text : undefined,
    llmsTxt: llmsResult?.status === 200 ? llmsResult.text : undefined,
    wellKnown,
    openapi: openapiResult ?? undefined,
  };

  const crawlDelaySeconds =
    robotsParser(`${baseUrl}/robots.txt`, metadata.robotsTxt ?? "").getCrawlDelay(
      options.userAgent,
    ) ?? 0;

  const effectiveDelay = Math.min(
    Math.max(options.requestDelay ?? 200, crawlDelaySeconds * 1000),
    10_000, // cap at 10s — prevents >10 minutes for a 20-page crawl
  );

  const pages: FetchedPage[] = [homepage];
  const visited = new Set<string>([url]);

  const sitemapUrls = parseSitemapUrls(metadata.sitemapXml, baseUrl);
  const uniqueSitemapUrls = sitemapUrls.filter((u) => !visited.has(u));
  const totalUrlsFound = 1 + uniqueSitemapUrls.length; // homepage + sitemap
  const rankedUrls = sortUrlsByScore(uniqueSitemapUrls);
  const urlsToFetch = rankedUrls.slice(0, options.maxPages - 1);

  if (urlsToFetch.length > 0) {
    onProgress?.(`Scanning ${urlsToFetch.length} pages from sitemap...`);

    const concurrency = options.concurrency ?? 3;
    let completed = 0;

    // Serialized gate: each worker chains onto the gate promise,
    // waiting effectiveDelay ms after the previous worker started.
    // This ensures at most one new request starts per effectiveDelay window
    // while still allowing concurrency fetches to run in parallel.
    let gate = Promise.resolve();

    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (true) {
          if (completed >= urlsToFetch.length) break;
          const u = urlsToFetch[completed];
          completed++;

          // Acquire rate limit slot
          const mySlot = gate.then(() => sleep(effectiveDelay));
          gate = mySlot;

          await mySlot;
          const page = await fetchPage(u, options);

          if (page.status > 0) {
            pages.push(page);
            visited.add(page.url);
          }

          onProgress?.(`Scanned ${pages.length - 1}/${urlsToFetch.length} pages...`);
        }
      }),
    );
  }

  return { pages, metadata, totalUrlsFound };
}

function parseSitemapUrls(xml: string | undefined, baseUrl: string): string[] {
  if (!xml) return [];
  const urls: string[] = [];
  const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null = null;
  while ((match = locRegex.exec(xml)) !== null) {
    const loc = match[1].trim();
    try {
      const parsed = new URL(loc);
      if (parsed.origin === new URL(baseUrl).origin) {
        urls.push(loc);
      }
    } catch {}
  }
  return urls;
}
