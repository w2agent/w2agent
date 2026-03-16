import { parseHTML } from "../shared/html-parser.js";

export interface DiscoveredPage {
  url: string;
  source: "sitemap" | "link" | "homepage";
  sitemapPriority?: number;
  sitemapLastmod?: string;
  internalLinkCount: number;
  depth: number;
  queritRank?: number;
}

export function parseSitemapWithMetadata(xml: string, baseUrl: string): DiscoveredPage[] {
  const pages: DiscoveredPage[] = [];
  const origin = new URL(baseUrl).origin;
  const urlBlockRegex = /<url>([\s\S]*?)<\/url>/gi;
  let block: RegExpExecArray | null = null;

  while ((block = urlBlockRegex.exec(xml)) !== null) {
    const content = block[1];
    const locMatch = /<loc>\s*(.*?)\s*<\/loc>/i.exec(content);
    if (!locMatch) continue;

    const loc = locMatch[1].trim();
    let parsed: URL;
    try {
      parsed = new URL(loc);
    } catch {
      continue;
    }
    if (parsed.origin !== origin) continue;

    const priorityMatch = /<priority>\s*([\d.]+)\s*<\/priority>/i.exec(content);
    const lastmodMatch = /<lastmod>\s*(.*?)\s*<\/lastmod>/i.exec(content);

    pages.push({
      url: loc,
      source: "sitemap",
      sitemapPriority: priorityMatch ? parseFloat(priorityMatch[1]) : undefined,
      sitemapLastmod: lastmodMatch ? lastmodMatch[1].trim() : undefined,
      internalLinkCount: 0,
      depth: parsed.pathname.split("/").filter(Boolean).length,
    });
  }
  return pages;
}

export function discoverInternalLinks(html: string, baseUrl: string): Map<string, number> {
  const parsed = parseHTML(html);
  const origin = new URL(baseUrl).origin;
  const counts = new Map<string, number>();

  for (const link of parsed.links) {
    if (!link.href) continue;
    let url: URL;
    try {
      url = new URL(link.href, baseUrl);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;

    url.hash = "";
    const normalized = url.pathname === "/" ? url.href : url.href.replace(/\/$/, "");
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

interface DiscoverOptions {
  sitemapXml?: string;
  homepage?: { html: string; url: string };
  baseUrl: string;
}

export function discoverPages(options: DiscoverOptions): DiscoveredPage[] {
  const { sitemapXml, homepage, baseUrl } = options;

  const sitemapPages = sitemapXml ? parseSitemapWithMetadata(sitemapXml, baseUrl) : [];
  const linkCounts = homepage
    ? discoverInternalLinks(homepage.html, baseUrl)
    : new Map<string, number>();

  const pageMap = new Map<string, DiscoveredPage>();
  for (const page of sitemapPages) {
    pageMap.set(page.url, page);
  }

  for (const [url, count] of linkCounts) {
    const existing = pageMap.get(url);
    if (existing) {
      existing.internalLinkCount = count;
    } else {
      const parsed = new URL(url);
      pageMap.set(url, {
        url,
        source: "link",
        internalLinkCount: count,
        depth: parsed.pathname.split("/").filter(Boolean).length,
      });
    }
  }

  const homepageUrl = new URL("/", baseUrl).href;
  if (!pageMap.has(homepageUrl)) {
    pageMap.set(homepageUrl, {
      url: homepageUrl,
      source: "homepage",
      internalLinkCount: 0,
      depth: 0,
    });
  }

  return Array.from(pageMap.values());
}
