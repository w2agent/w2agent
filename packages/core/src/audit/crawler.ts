import robotsParser from "robots-parser";
import { discoverPages } from "../crawl/discovery.js";
import { selectPages } from "../crawl/strategy.js";
import { fetchPage, fetchText, guardedFetch } from "../shared/fetcher.js";
import { probeOpenAPIPaths } from "../shared/openapi.js";
import { isJsonContentType } from "./shared/json.js";
import { parseMcpResourceLink } from "./shared/oauth-parser.js";
import type {
  AuditOptions,
  FetchedPage,
  McpInitResult,
  MultiUaResponse,
  SiteMetadata,
} from "./types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const AGENT_UAS: { key: string; ua: string; robotsName: string }[] = [
  {
    key: "claude",
    ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +https://www.anthropic.com/claude-bot)",
    robotsName: "ClaudeBot",
  },
  {
    key: "chatgpt",
    ua: "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)",
    robotsName: "ChatGPT-User",
  },
  {
    key: "gemini",
    ua: "Mozilla/5.0 (compatible; Google-Extended/1.0)",
    robotsName: "Google-Extended",
  },
  {
    key: "perplexity",
    ua: "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://www.perplexity.ai/perplexitybot)",
    robotsName: "PerplexityBot",
  },
  { key: "deepseek", ua: "Mozilla/5.0 (compatible; DeepSeekBot/1.0)", robotsName: "DeepSeekBot" },
];

export async function fetchUnderUas(
  homepageUrl: string,
  options: AuditOptions,
  robotsTxt?: string,
): Promise<Record<string, MultiUaResponse>> {
  const responses: Record<string, MultiUaResponse> = {};
  // Wall-clock budget for the entire multi-UA pass. Checked between fetches —
  // a single fetch can still take up to options.timeout ms, so worst-case
  // budget overshoot is one per-fetch timeout (DEFAULT_OPTIONS.timeout = 10s).
  const budget = Math.min((options.timeout ?? 5000) * 3, 15000);
  const start = Date.now();

  const robotsRulesUrl = (() => {
    try {
      return `${new URL(homepageUrl).origin}/robots.txt`;
    } catch {
      return `${homepageUrl}/robots.txt`;
    }
  })();
  const robots = robotsParser(robotsRulesUrl, robotsTxt ?? "");

  for (const { key, ua, robotsName } of AGENT_UAS) {
    if (Date.now() - start > budget) {
      responses[key] = {
        status: 0,
        contentLength: 0,
        finalUrl: homepageUrl,
        reachable: false,
        outcome: "budget-skipped",
      };
      continue;
    }

    // Check robots.txt before fetching
    if (robotsTxt && robots.isAllowed(homepageUrl, robotsName) === false) {
      responses[key] = {
        status: 0,
        contentLength: 0,
        finalUrl: homepageUrl,
        reachable: false,
        outcome: "blocked-by-robots",
      };
      continue;
    }

    try {
      const res = await guardedFetch(
        homepageUrl,
        {
          headers: { "User-Agent": ua },
          signal: AbortSignal.timeout(options.timeout ?? 5000),
        },
        options.isAllowedTarget,
      );
      let contentLength = 0;
      if (res.body) {
        const reader = res.body.getReader();
        const cap = 64 * 1024;
        while (true) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          contentLength += value.length;
          if (contentLength >= cap) {
            await reader.cancel();
            break;
          }
        }
      }
      responses[key] = {
        status: res.status,
        contentLength,
        finalUrl: res.url,
        reachable: res.status < 500 && contentLength > 0,
        outcome: "ok",
      };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      responses[key] = {
        status: 0,
        contentLength: 0,
        finalUrl: homepageUrl,
        reachable: false,
        outcome: isTimeout ? "timeout" : "fetch-error",
      };
    }
  }
  return responses;
}

function stripWww(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

const LLMS_SUBDOMAINS = ["docs", "developers", "developer"];

type TextResult = Awaited<ReturnType<typeof fetchText>>;

function is2xx(r: TextResult): r is NonNullable<TextResult> {
  return r !== null && r.status >= 200 && r.status < 300;
}

function isTextFile(r: TextResult): r is NonNullable<TextResult> {
  return r?.status === 200 && !r.contentType.toLowerCase().includes("text/html");
}

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
  onProgress?.("Fetching homepage...");
  const homepage = await fetchPage(url, options);

  const metadata = await probeSiteMetadata(url, options, {
    homepageHtml: homepage.html,
    onProgress,
  });

  const { pages, totalUrlsFound } = await crawlPages(url, homepage, metadata, options, {
    pageRankings: options.pageRankings,
    onProgress,
  });

  return { pages, metadata, totalUrlsFound };
}

export async function probeSiteMetadata(
  url: string,
  options: AuditOptions,
  opts: { homepageHtml?: string; onProgress?: (status: string) => void } = {},
): Promise<SiteMetadata> {
  const { onProgress } = opts;
  const base = new URL(url);
  const baseUrl = `${base.protocol}//${base.host}`;
  const homepageHtml = opts.homepageHtml ?? (await fetchPage(url, options)).html;

  onProgress?.("Fetching robots.txt...");
  const [robotsResult, sitemapResult, llmsResult, openapiResult] = await Promise.all([
    fetchText(`${baseUrl}/robots.txt`, options),
    fetchText(`${baseUrl}/sitemap.xml`, options),
    fetchText(`${baseUrl}/llms.txt`, options),
    probeOpenAPIPaths(baseUrl, options, { homepageHtml }),
  ]);

  let llmsTxtFallback: string | undefined;
  if (!isTextFile(llmsResult)) {
    // Subdomain fallback assumes baseUrl is an apex (or www.) domain.
    // If baseUrl is already a subdomain, probes will degrade to 404; that's acceptable.
    for (const sub of LLMS_SUBDOMAINS) {
      const r = await fetchText(
        `${base.protocol}//${sub}.${stripWww(base.hostname)}/llms.txt`,
        options,
      );
      if (isTextFile(r)) {
        llmsTxtFallback = r.text;
        break;
      }
    }
  }

  onProgress?.("Fetching .well-known files...");
  const wellKnownPaths = [
    "agent-card.json",
    "mcp",
    "ucp",
    "oauth-authorization-server",
    "oauth-protected-resource",
  ];
  const [rootProbe, wellKnownProbe, ...wellKnownResults] = await Promise.all([
    fetchText(`${baseUrl}/${crypto.randomUUID()}`, options),
    fetchText(`${baseUrl}/.well-known/${crypto.randomUUID()}`, options),
    ...wellKnownPaths.map((path) => fetchText(`${baseUrl}/.well-known/${path}`, options)),
  ]);
  const catchAllBody = is2xx(wellKnownProbe) ? wellKnownProbe.text : undefined;

  const wellKnown: Record<string, string | undefined> = {};
  wellKnownPaths.forEach((path, i) => {
    const result = wellKnownResults[i];
    const accepted =
      result?.status === 200 &&
      isJsonContentType(result.contentType) &&
      result.text !== catchAllBody;
    wellKnown[path] = accepted ? result.text : undefined;
  });

  const metadata: SiteMetadata = {
    baseUrl,
    robotsTxt: isTextFile(robotsResult) ? robotsResult.text : undefined,
    sitemapXml: sitemapResult?.status === 200 ? sitemapResult.text : undefined,
    llmsTxt: isTextFile(llmsResult) ? llmsResult.text : llmsTxtFallback,
    wellKnown,
    openapi: openapiResult ?? undefined,
    catchAll: is2xx(rootProbe) || is2xx(wellKnownProbe),
  };

  if (wellKnown.mcp) {
    metadata.mcpInit = await probeMcpInit(`${baseUrl}/.well-known/mcp`, options);
  }

  onProgress?.("Simulating agent user-agents...");
  metadata.multiUaResponses = await fetchUnderUas(url, options, metadata.robotsTxt);

  return metadata;
}

export async function crawlPages(
  url: string,
  homepage: FetchedPage,
  metadata: SiteMetadata,
  options: AuditOptions,
  opts: {
    pageRankings?: Map<string, number>;
    cached?: (url: string) => FetchedPage | undefined;
    onProgress?: (status: string) => void;
  } = {},
): Promise<{ pages: FetchedPage[]; totalUrlsFound: number }> {
  const { onProgress, cached } = opts;
  const base = new URL(url);
  const baseUrl = `${base.protocol}//${base.host}`;

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

  if (opts.pageRankings?.size) {
    for (const page of discovered) {
      const rank = opts.pageRankings.get(page.url);
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

          let page = cached?.(u);
          if (!page) {
            // Acquire rate limit slot
            const mySlot = gate.then(() => sleep(effectiveDelay));
            gate = mySlot;

            await mySlot;
            page = await fetchPage(u, options);
          }

          if (page.status > 0) {
            pages.push(page);
            visited.add(page.url);
          }

          onProgress?.(`Scanned ${pages.length - 1}/${urlsToFetch.length} pages...`);
        }
      }),
    );
  }

  if (metadata.sitemapXml !== undefined) {
    await fillFromSitemap(pages, metadata.sitemapXml, url, options, cached);
  }

  return { pages, totalUrlsFound };
}

function parseSitemapUrls(xml: string): string[] {
  const matches = xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]+?)(?:\]\]>)?\s*<\/loc>/gi);
  return Array.from(matches, (m) => m[1].trim());
}

async function fillFromSitemap(
  pages: FetchedPage[],
  sitemapXml: string,
  baseUrl: string,
  options: AuditOptions,
  cached?: (url: string) => FetchedPage | undefined,
): Promise<void> {
  // Fewer than 3 crawled pages signals a link-starved crawl (typical of SPA shells).
  // Most multi-page checks (e.g., "X/N pages have JSON-LD") degrade meaningfully when N < 3.
  const MIN_PAGES = 3;
  if (pages.length >= MIN_PAGES) return;
  const remaining = Math.min(options.maxPages - pages.length, 5);
  if (remaining <= 0) return;

  const urls = parseSitemapUrls(sitemapXml);
  const seen = new Set(pages.map((p) => p.url));
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");

  const candidates = urls
    .filter((u) => {
      try {
        const h = new URL(u).hostname;
        return (h === baseHost || h.endsWith(`.${baseHost}`)) && !seen.has(u);
      } catch {
        return false;
      }
    })
    .filter((u) => new URL(u).pathname.length > 1)
    .slice(0, remaining);

  const fallbackBudget = Math.min((options.timeout ?? 5000) * 3, 15000);
  const start = Date.now();
  for (const u of candidates) {
    if (Date.now() - start > fallbackBudget) break;
    const page = cached?.(u) ?? (await fetchPage(u, options));
    if (page.status >= 200 && page.status < 300) {
      pages.push(page);
    }
  }
}

async function probeMcpInit(url: string, options: AuditOptions): Promise<McpInitResult> {
  const result: McpInitResult = { mcpEndpointUrl: url, success: false };
  try {
    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "w2agent-audit", version: "0.1.0" },
      },
    };
    const response = await guardedFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(initRequest),
        signal: AbortSignal.timeout(5000),
      },
      options.isAllowedTarget,
    );
    result.status = response.status;
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    result.rawHeaders = headers;
    result.linkHeader = headers.link;
    if (headers.link) {
      const parsed = parseMcpResourceLink(headers.link);
      result.oauthResourceMetadataUrl = parsed.resourceMetadataUrl;
    }
    if (!response.ok) return result;
    const contentType = headers["content-type"] || "";
    const body = await response.text();
    const parsed = tryParseJsonRpcInit(body, contentType);
    if (parsed?.serverInfo?.name) {
      result.success = true;
      result.serverInfo = {
        name: parsed.serverInfo.name,
        version: parsed.serverInfo.version,
        authMechanism: parsed.authMechanism,
      };
    }
    return result;
  } catch {
    return result;
  }
}

function tryParseJsonRpcInit(
  body: string,
  contentType: string,
): { serverInfo?: { name: string; version?: string }; authMechanism?: string } | null {
  try {
    let jsonStr = body;
    if (contentType.includes("text/event-stream")) {
      for (const line of body.split("\n")) {
        if (line.startsWith("data: ")) {
          jsonStr = line.slice(6);
          break;
        }
      }
    }
    const json = JSON.parse(jsonStr);
    const result = json.result;
    if (!result?.serverInfo?.name) return null;
    const authMechanism = result.capabilities?.auth?.type ?? result._meta?.auth?.type;
    return { serverInfo: result.serverInfo, authMechanism };
  } catch {
    return null;
  }
}
