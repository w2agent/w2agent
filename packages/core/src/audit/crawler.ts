import { fetchPage, fetchText } from "../shared/fetcher.js";
import type { AuditOptions, FetchedPage, SiteMetadata } from "./types.js";

export interface CrawlResult {
  pages: FetchedPage[];
  metadata: SiteMetadata;
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
  const [robotsResult, sitemapResult, llmsResult] = await Promise.all([
    fetchText(`${baseUrl}/robots.txt`, options),
    fetchText(`${baseUrl}/sitemap.xml`, options),
    fetchText(`${baseUrl}/llms.txt`, options),
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
  };

  const pages: FetchedPage[] = [homepage];
  const visited = new Set<string>([url]);

  const sitemapUrls = parseSitemapUrls(metadata.sitemapXml, baseUrl);
  const urlsToFetch = sitemapUrls.filter((u) => !visited.has(u)).slice(0, options.maxPages - 1);

  if (urlsToFetch.length > 0) {
    onProgress?.(`Scanning ${urlsToFetch.length} pages from sitemap...`);
    const batchSize = 5;
    for (let i = 0; i < urlsToFetch.length; i += batchSize) {
      const batch = urlsToFetch.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((u) => fetchPage(u, options)));
      for (const page of results) {
        if (page.status > 0) {
          pages.push(page);
          visited.add(page.url);
        }
      }
      onProgress?.(
        `Scanned ${Math.min(i + batchSize, urlsToFetch.length)}/${urlsToFetch.length} pages...`,
      );
    }
  }

  return { pages, metadata };
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
