import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAudit } from "../src/audit/engine.js";
import type { AuditOptions, Check, FetchedPage, SiteMetadata } from "../src/audit/types.js";
import {
  AUDIT_CRAWL_PROFILE,
  AUDIT_CRAWL_PROFILE_ID,
  crawlSite,
  DEFAULT_OPTIONS,
  probeSiteMetadata,
} from "../src/index.js";

const SITE = "https://site.test";
const HOME = `${SITE}/`;
// 29 non-homepage URLs: /p1..p9 carry sitemap priority 0.9 (the deterministic
// top 9 for a 10-page profile), /p10..p29 carry 0.1.
const PAGE_URLS = Array.from({ length: 29 }, (_, i) => `${SITE}/p${i + 1}`);
const TOP_NINE = PAGE_URLS.slice(0, 9);
const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>${HOME}</loc></url>${PAGE_URLS.map(
  (u, i) => `<url><loc>${u}</loc><priority>${i < 9 ? "0.9" : "0.1"}</priority></url>`,
).join("")}</urlset>`;
const HOME_HTML = "<html><head><title>Home</title></head><body><p>hello</p></body></html>";
const MCP_INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { serverInfo: { name: "site-mcp", version: "1.2.3" } },
});

const OPTIONS: AuditOptions = { ...DEFAULT_OPTIONS, ...AUDIT_CRAWL_PROFILE, requestDelay: 0 };

type Call = { url: string; method: string; ua?: string };
let calls: Call[] = [];
let fetchMock: ReturnType<typeof vi.spyOn> | undefined;

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

beforeEach(() => {
  calls = [];
  fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const ua = (init?.headers as Record<string, string> | undefined)?.["User-Agent"];
    calls.push({ url, method, ua });
    const path = new URL(url).pathname;
    if (new URL(url).origin !== SITE) return new Response("", { status: 404 });
    if (path === "/") return html(HOME_HTML);
    if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /", { status: 200 });
    if (path === "/sitemap.xml") return new Response(SITEMAP, { status: 200 });
    if (path === "/mcp" && method === "POST") {
      return new Response(MCP_INIT_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/^\/p\d+$/.test(path)) return html(`<html><body><p>page ${path}</p></body></html>`);
    if (path === "/guide/") return html("<html><body><p>guide index (slash)</p></body></html>");
    return new Response("", { status: 404 });
  });
});

afterEach(() => {
  fetchMock?.mockRestore();
});

function mainUaPageFetches(url: string): Call[] {
  return calls.filter((c) => c.url === url && c.method === "GET" && c.ua === OPTIONS.userAgent);
}

describe("AUDIT_CRAWL_PROFILE", () => {
  it("is exported from the package index with a stamp derived from its values", () => {
    expect(AUDIT_CRAWL_PROFILE).toEqual({ maxPages: 10, timeout: 10000 });
    expect(AUDIT_CRAWL_PROFILE_ID).toBe("maxPages=10;timeout=10000");
    expect(DEFAULT_OPTIONS.maxPages).toBe(20);
  });
});

describe("probeSiteMetadata", () => {
  it("runs the MCP endpoint probe and the multi-UA pass", async () => {
    const metadata = await probeSiteMetadata(HOME, OPTIONS);

    expect(metadata.mcpEndpoint).toBe(`${SITE}/mcp`);
    expect(metadata.mcpInit?.success).toBe(true);
    expect(metadata.mcpInit?.serverInfo?.name).toBe("site-mcp");
    expect(Object.keys(metadata.multiUaResponses ?? {}).sort()).toEqual([
      "amazon",
      "google",
      "meta",
      "mistral",
      "openai",
      "perplexity",
    ]);
    expect(metadata.multiUaResponses?.openai.status).toBe(200);
    expect(metadata.sitemapXml).toBe(SITEMAP);
  });

  // Two fetches under our own UA on the homepage, on every path: the crawl's
  // own (retrying) `fetchPage`, plus the edge probe's single-shot control. The
  // control is deliberately its own request — reusing the retrying fetch would
  // report "200 after retry" against an agent's "503 first shot".
  it("fetches the homepage for its HTML only when no homepageHtml is given, plus the edge control", async () => {
    await probeSiteMetadata(HOME, OPTIONS);
    expect(mainUaPageFetches(HOME)).toHaveLength(2);

    calls = [];
    await probeSiteMetadata(HOME, OPTIONS, { homepageHtml: HOME_HTML });
    expect(mainUaPageFetches(HOME)).toHaveLength(1);
  });

  it("crawlSite metadata equals probeSiteMetadata output, with the same two homepage fetches", async () => {
    const probed = await probeSiteMetadata(HOME, OPTIONS);

    calls = [];
    const crawled = await crawlSite(HOME, OPTIONS);

    expect(crawled.metadata).toEqual(probed);
    expect(mainUaPageFetches(HOME)).toHaveLength(2);
  });
});

describe("runAudit re-selection of prefetched pages beyond the profile", () => {
  let scored: string[] = [];
  const recorder: Check = {
    id: "page-recorder",
    name: "Page recorder",
    category: "content-quality",
    weight: 1,
    severity: "info",
    run: (pages) => {
      scored = pages.map((p) => p.url).sort();
      return {
        id: "page-recorder",
        name: "Page recorder",
        category: "content-quality",
        status: "pass",
        score: 100,
        maxScore: 100,
        weight: 1,
        message: "",
        severity: "info",
      };
    },
  };

  const metadata: SiteMetadata = {
    baseUrl: SITE,
    robotsTxt: "User-agent: *\nAllow: /",
    sitemapXml: SITEMAP,
    wellKnown: {},
  };

  function prefetched(): FetchedPage[] {
    return [SITE, ...PAGE_URLS].map((url) => ({
      url,
      status: 200,
      html: url === SITE ? HOME_HTML : "<html><body><p>cached</p></body></html>",
      headers: { "content-type": "text/html" },
      responseTime: 0,
    }));
  }

  function shuffled<T>(items: T[]): T[] {
    const out = [...items];
    let seed = 7;
    for (let i = out.length - 1; i > 0; i--) {
      seed = (seed * 9301 + 49297) % 233280;
      const j = Math.floor((seed / 233280) * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // Ranks that, if honoured, would pull /p20..p29 above the priority-0.9 pages.
  const pageRankings = new Map(PAGE_URLS.slice(19).map((u) => [u, 1]));

  beforeEach(() => {
    scored = [];
  });

  it("scores exactly the profile's page count, chosen by sitemap + homepage links", async () => {
    const report = await runAudit(
      HOME,
      { ...OPTIONS, prefetchedPages: prefetched(), prefetchedMetadata: metadata },
      undefined,
      [recorder],
    );

    expect(report.pagesScanned).toBe(10);
    expect(scored).toEqual([SITE, ...TOP_NINE].sort());
    expect(calls.filter((c) => c.ua === OPTIONS.userAgent)).toHaveLength(0);
  });

  it("selects the same pages regardless of prefetched order and ignores pageRankings", async () => {
    await runAudit(
      HOME,
      { ...OPTIONS, prefetchedPages: prefetched(), prefetchedMetadata: metadata },
      undefined,
      [recorder],
    );
    const inOrder = scored;

    await runAudit(
      HOME,
      {
        ...OPTIONS,
        pageRankings,
        prefetchedPages: shuffled(prefetched()),
        prefetchedMetadata: metadata,
      },
      undefined,
      [recorder],
    );

    expect(scored).toEqual(inOrder);
  });

  it("matches the page set of a fresh AUDIT_CRAWL_PROFILE crawl of the same site", async () => {
    const fresh = await runAudit(HOME, { ...AUDIT_CRAWL_PROFILE, requestDelay: 0 }, undefined, [
      recorder,
    ]);
    const freshUrls = scored.map((u) => u.replace(/\/$/, ""));

    const reselected = await runAudit(
      HOME,
      {
        ...OPTIONS,
        pageRankings,
        prefetchedPages: shuffled(prefetched()),
        prefetchedMetadata: metadata,
      },
      undefined,
      [recorder],
    );
    const reselectedUrls = scored.map((u) => u.replace(/\/$/, ""));

    expect(fresh.pagesScanned).toBe(10);
    expect(reselected.pagesScanned).toBe(10);
    expect(reselectedUrls).toEqual(freshUrls);
  });

  it("fetches selected pages (and the homepage) live when missing from prefetched", async () => {
    const pages = prefetched().filter((p) => p.url !== SITE && p.url !== `${SITE}/p5`);
    expect(pages.length).toBeGreaterThan(AUDIT_CRAWL_PROFILE.maxPages);

    const report = await runAudit(
      HOME,
      { ...OPTIONS, prefetchedPages: pages, prefetchedMetadata: metadata },
      undefined,
      [recorder],
    );

    expect(report.pagesScanned).toBe(10);
    expect(scored).toContain(`${SITE}/p5`);
    expect(mainUaPageFetches(`${SITE}/p5`)).toHaveLength(1);
    expect(mainUaPageFetches(HOME)).toHaveLength(1);
    expect(mainUaPageFetches(`${SITE}/p1`)).toHaveLength(0);
  });

  it("treats /guide and /guide/ as distinct pages: only an exact prefetched match is reused", async () => {
    const guide = `${SITE}/guide`;
    const guideSlash = `${SITE}/guide/`;
    const sitemapXml = `<?xml version="1.0"?><urlset><url><loc>${HOME}</loc></url><url><loc>${guide}</loc><priority>0.9</priority></url><url><loc>${guideSlash}</loc><priority>0.9</priority></url>${PAGE_URLS.map(
      (u) => `<url><loc>${u}</loc><priority>0.1</priority></url>`,
    ).join("")}</urlset>`;
    const pages: FetchedPage[] = [
      ...prefetched(),
      {
        url: guide,
        status: 200,
        html: "<html><body><p>guide article (no slash)</p></body></html>",
        headers: { "content-type": "text/html" },
        responseTime: 0,
      },
    ];
    expect(pages.length).toBeGreaterThan(AUDIT_CRAWL_PROFILE.maxPages);

    let scoredPages: FetchedPage[] = [];
    const htmlRecorder: Check = {
      ...recorder,
      run: (p, m) => {
        scoredPages = p;
        return recorder.run(p, m);
      },
    };

    await runAudit(
      HOME,
      { ...OPTIONS, prefetchedPages: pages, prefetchedMetadata: { ...metadata, sitemapXml } },
      undefined,
      [htmlRecorder],
    );

    const htmlOf = (u: string) => scoredPages.filter((p) => p.url === u).map((p) => p.html);
    expect(htmlOf(guide)).toEqual(["<html><body><p>guide article (no slash)</p></body></html>"]);
    expect(htmlOf(guideSlash)).toEqual(["<html><body><p>guide index (slash)</p></body></html>"]);
    expect(mainUaPageFetches(guideSlash)).toHaveLength(1);
    expect(mainUaPageFetches(guide)).toHaveLength(0);
  });
});
