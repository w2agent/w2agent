import robotsParser from "robots-parser";
import { discoverPages } from "../crawl/discovery.js";
import { selectPages } from "../crawl/strategy.js";
import { fetchPage, fetchText } from "../shared/fetcher.js";
import { probeOpenAPIPaths } from "../shared/openapi.js";
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
  const visited = new Set<string>([new URL(url).href]);

  const discovered = discoverPages({
    sitemapXml: metadata.sitemapXml,
    homepage: { html: homepage.html, url },
    baseUrl,
  });

  if (options.pageRankings?.size) {
    for (const page of discovered) {
      const rank = options.pageRankings.get(page.url);
      if (rank !== undefined) page.queritRank = rank;
    }
  }

  const totalUrlsFound = 1 + discovered.filter((p) => !visited.has(p.url)).length;
  const selected = selectPages(discovered, options.maxPages - 1, visited);
  const urlsToFetch = selected.map((p) => p.url);

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
