import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crawlSite } from "../src/audit/crawler.js";
import type { FetchedPage } from "../src/audit/types.js";
import { DEFAULT_OPTIONS } from "../src/audit/types.js";

vi.mock("../src/shared/fetcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shared/fetcher.js")>()),
  fetchPage: vi.fn(),
  fetchText: vi.fn(),
}));

vi.mock("../src/shared/openapi.js", () => ({
  probeOpenAPIPaths: vi.fn().mockResolvedValue(null),
}));

import { fetchPage, fetchText } from "../src/shared/fetcher.js";

const mockFetchPage = vi.mocked(fetchPage);
const mockFetchText = vi.mocked(fetchText);

const BASE_URL = "https://example.com";

let globalFetchSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  globalFetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("", { status: 404 }));
});
afterEach(() => {
  globalFetchSpy?.mockRestore();
});

function makeSitemap(urls: string[]): string {
  return `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
}

function makePageResult(url: string): FetchedPage {
  return { url, status: 200, html: "<html></html>", headers: {}, responseTime: 5 };
}

describe("crawlSite concurrency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchPage.mockReset();
    mockFetchText.mockReset();
    mockFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt"))
        return { text: "User-agent: *", status: 200, contentType: "text/plain" };
      if (url.endsWith("/sitemap.xml")) {
        const urls = Array.from({ length: 6 }, (_, i) => `${BASE_URL}/page-${i + 1}`);
        return { text: makeSitemap(urls), status: 200, contentType: "text/plain" };
      }
      return null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("respects concurrency=2: never more than 2 fetches in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    mockFetchPage.mockImplementation(async (url: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => setTimeout(r, 10));
      inFlight--;
      return makePageResult(url);
    });

    const promise = crawlSite(BASE_URL, { ...DEFAULT_OPTIONS, concurrency: 2 });
    await vi.runAllTimersAsync();
    await promise;

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("default concurrency is 3", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    mockFetchPage.mockImplementation(async (url: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => setTimeout(r, 10));
      inFlight--;
      return makePageResult(url);
    });

    const promise = crawlSite(BASE_URL, {
      ...DEFAULT_OPTIONS,
      concurrency: undefined,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("fetches all sitemap URLs up to maxPages", async () => {
    mockFetchPage.mockImplementation(async (url) => makePageResult(url));

    const promise = crawlSite(BASE_URL, { ...DEFAULT_OPTIONS, maxPages: 5, concurrency: 2 });
    await vi.runAllTimersAsync();
    const result = await promise;

    // 1 homepage + 4 sitemap pages = maxPages=5
    expect(result.pages).toHaveLength(5);
  });
});

describe("crawlSite rate limiting and Crawl-delay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchPage.mockReset();
    mockFetchText.mockReset();
    mockFetchPage.mockImplementation(async (url: string) => makePageResult(url));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies requestDelay between consecutive request starts", async () => {
    const sitemap = makeSitemap([`${BASE_URL}/a`, `${BASE_URL}/b`, `${BASE_URL}/c`]);
    mockFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt"))
        return { text: "User-agent: *", status: 200, contentType: "text/plain" };
      if (url.endsWith("/sitemap.xml"))
        return { text: sitemap, status: 200, contentType: "text/plain" };
      return null;
    });

    const callTimes: number[] = [];
    mockFetchPage.mockImplementation(async (url: string) => {
      callTimes.push(Date.now());
      return makePageResult(url);
    });

    const promise = crawlSite(BASE_URL, {
      ...DEFAULT_OPTIONS,
      requestDelay: 500,
      concurrency: 1,
    });
    await vi.runAllTimersAsync();
    await promise;

    // Should have fetched homepage + 3 sitemap pages
    expect(callTimes).toHaveLength(4);
    // callTimes[1] is first sitemap URL, callTimes[2] is second — spaced >= 500ms
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(500);
  });

  it("uses robots.txt Crawl-delay when larger than requestDelay", async () => {
    const sitemap = makeSitemap([`${BASE_URL}/a`, `${BASE_URL}/b`]);
    mockFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt"))
        return { text: "User-agent: *\nCrawl-delay: 5", status: 200, contentType: "text/plain" };
      if (url.endsWith("/sitemap.xml"))
        return { text: sitemap, status: 200, contentType: "text/plain" };
      return null;
    });

    const callTimes: number[] = [];
    mockFetchPage.mockImplementation(async (url: string) => {
      callTimes.push(Date.now());
      return makePageResult(url);
    });

    const promise = crawlSite(BASE_URL, {
      ...DEFAULT_OPTIONS,
      requestDelay: 200, // 200ms default, but Crawl-delay: 5 should win
      concurrency: 1,
    });
    await vi.runAllTimersAsync();
    await promise;

    // With Crawl-delay: 5 (5000ms) > requestDelay: 200ms
    expect(callTimes).toHaveLength(3); // homepage + 2 sitemap
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(5000);
  });

  it("caps Crawl-delay at 10000ms when robots.txt says Crawl-delay: 60", async () => {
    const sitemap = makeSitemap([`${BASE_URL}/a`, `${BASE_URL}/b`]);
    mockFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt"))
        return { text: "User-agent: *\nCrawl-delay: 60", status: 200, contentType: "text/plain" }; // 60s — too long
      if (url.endsWith("/sitemap.xml"))
        return { text: sitemap, status: 200, contentType: "text/plain" };
      return null;
    });

    const callTimes: number[] = [];
    mockFetchPage.mockImplementation(async (url: string) => {
      callTimes.push(Date.now());
      return makePageResult(url);
    });

    const promise = crawlSite(BASE_URL, { ...DEFAULT_OPTIONS, concurrency: 1 });
    await vi.runAllTimersAsync();
    await promise;

    // effectiveDelay should be capped at 10000ms, not 60000ms
    expect(callTimes).toHaveLength(3);
    const gap = callTimes[2] - callTimes[1];
    expect(gap).toBeGreaterThanOrEqual(10000);
    expect(gap).toBeLessThan(60000);
  });

  it("uses requestDelay when Crawl-delay is absent from robots.txt", async () => {
    const sitemap = makeSitemap([`${BASE_URL}/a`, `${BASE_URL}/b`]);
    mockFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt"))
        return { text: "User-agent: *\nDisallow: /admin", status: 200, contentType: "text/plain" }; // no Crawl-delay
      if (url.endsWith("/sitemap.xml"))
        return { text: sitemap, status: 200, contentType: "text/plain" };
      return null;
    });

    const callTimes: number[] = [];
    mockFetchPage.mockImplementation(async (url: string) => {
      callTimes.push(Date.now());
      return makePageResult(url);
    });

    const promise = crawlSite(BASE_URL, {
      ...DEFAULT_OPTIONS,
      requestDelay: 300,
      concurrency: 1,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(callTimes).toHaveLength(3);
    // Gaps should be ~300ms (requestDelay), not 0 and not thousands
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(300);
    expect(callTimes[2] - callTimes[1]).toBeLessThan(5000);
  });
});

describe("crawlSite pageRankings enrichment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchPage.mockReset();
    mockFetchText.mockReset();
    mockFetchPage.mockImplementation(async (url: string) => makePageResult(url));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pages with pageRankings are selected over unranked pages when maxPages is small", async () => {
    // 6 pages in sitemap; /page-5 and /page-6 are top-ranked
    const urls = Array.from({ length: 6 }, (_, i) => `${BASE_URL}/page-${i + 1}`);
    mockFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt"))
        return { text: "User-agent: *", status: 200, contentType: "text/plain" };
      if (url.endsWith("/sitemap.xml"))
        return { text: makeSitemap(urls), status: 200, contentType: "text/plain" };
      return null;
    });

    const pageRankings = new Map([
      [`${BASE_URL}/page-5`, 1],
      [`${BASE_URL}/page-6`, 2],
    ]);

    const promise = crawlSite(BASE_URL, {
      ...DEFAULT_OPTIONS,
      maxPages: 3,
      concurrency: 3,
      pageRankings,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    const fetchedUrls = result.pages.map((p) => p.url);
    expect(fetchedUrls).toContain(`${BASE_URL}/page-5`);
    expect(fetchedUrls).toContain(`${BASE_URL}/page-6`);
  });
});

describe("crawlSite well-known paths and MCP init probe", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchPage.mockReset();
    mockFetchText.mockReset();
    mockFetchPage.mockImplementation(async (url: string) => makePageResult(url));
    mockFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt"))
        return { text: "User-agent: *", status: 200, contentType: "text/plain" };
      if (url.endsWith("/sitemap.xml")) return null;
      return null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("records the robots.txt fetch status, 0 when there was no response", async () => {
    const cases: Array<[Awaited<ReturnType<typeof fetchText>>, number, boolean]> = [
      [{ text: "User-agent: *", status: 200, contentType: "text/plain" }, 200, true],
      [{ text: "down", status: 500, contentType: "text/plain" }, 500, false],
      [{ text: "<html>nope</html>", status: 200, contentType: "text/html" }, 200, false],
      [null, 0, false],
    ];
    for (const [robots, status, hasText] of cases) {
      mockFetchText.mockImplementation(async (url: string) =>
        url.endsWith("/robots.txt") ? robots : null,
      );
      const promise = crawlSite(BASE_URL, { ...DEFAULT_OPTIONS, maxPages: 1 });
      await vi.runAllTimersAsync();
      const { metadata } = await promise;
      expect(metadata.robotsTxtStatus).toBe(status);
      expect(metadata.robotsTxt !== undefined).toBe(hasText);
    }
  });

  it("fetches oauth-authorization-server and oauth-protected-resource well-known paths", async () => {
    mockFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt"))
        return { text: "User-agent: *", status: 200, contentType: "text/plain" };
      if (url.endsWith("/sitemap.xml")) return null;
      if (url.endsWith("/.well-known/oauth-authorization-server"))
        return {
          text: '{"issuer":"https://example.com"}',
          status: 200,
          contentType: "application/json",
        };
      if (url.endsWith("/.well-known/oauth-protected-resource"))
        return {
          text: '{"resource":"https://example.com"}',
          status: 200,
          contentType: "application/json",
        };
      return null;
    });

    const promise = crawlSite(BASE_URL, { ...DEFAULT_OPTIONS, maxPages: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.metadata.wellKnown["oauth-authorization-server"]).toBe(
      '{"issuer":"https://example.com"}',
    );
    expect(result.metadata.wellKnown["oauth-protected-resource"]).toBe(
      '{"resource":"https://example.com"}',
    );
  });

  it("sets neither mcpInit nor mcpEndpoint when no MCP candidate confirms", async () => {
    const promise = crawlSite(BASE_URL, { ...DEFAULT_OPTIONS, maxPages: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.metadata.mcpInit).toBeUndefined();
    expect(result.metadata.mcpEndpoint).toBeUndefined();
    expect(result.metadata.wellKnown).not.toHaveProperty("mcp");
  });

  function serveMcpAt(endpoint: string, headers: Record<string, string> = {}) {
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== endpoint || init?.method !== "POST") return new Response("", { status: 404 });
      const method = JSON.parse(String(init.body)).method;
      if (method !== "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { serverInfo: { name: "test", version: "1.0" }, capabilities: {} },
        }),
        { status: 200, headers: { "content-type": "application/json", ...headers } },
      );
    }) as typeof fetch;
  }

  it("populates mcpInit and mcpEndpoint when /mcp completes a handshake", async () => {
    serveMcpAt(`${BASE_URL}/mcp`);

    const promise = crawlSite(BASE_URL, { ...DEFAULT_OPTIONS, maxPages: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.metadata.mcpEndpoint).toBe(`${BASE_URL}/mcp`);
    expect(result.metadata.mcpInit?.success).toBe(true);
    expect(result.metadata.mcpInit?.serverInfo?.name).toBe("test");
  });

  it("captures Link header into mcpInit.oauthResourceMetadataUrl", async () => {
    serveMcpAt(`${BASE_URL}/mcp`, {
      link: '<https://example.com/.well-known/oauth-protected-resource>; rel="resource_metadata"',
    });

    const promise = crawlSite(BASE_URL, { ...DEFAULT_OPTIONS, maxPages: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.metadata.mcpInit?.linkHeader).toContain("resource_metadata");
    expect(result.metadata.mcpInit?.oauthResourceMetadataUrl).toBe(
      "https://example.com/.well-known/oauth-protected-resource",
    );
  });

  it("a network error on every MCP candidate leaves mcpInit and mcpEndpoint unset without throwing", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const promise = crawlSite(BASE_URL, { ...DEFAULT_OPTIONS, maxPages: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.metadata.mcpInit).toBeUndefined();
    expect(result.metadata.mcpEndpoint).toBeUndefined();
  });
});
