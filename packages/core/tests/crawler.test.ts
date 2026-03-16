import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crawlSite } from "../src/audit/crawler.js";
import type { FetchedPage } from "../src/audit/types.js";
import { DEFAULT_OPTIONS } from "../src/audit/types.js";

vi.mock("../src/shared/fetcher.js", () => ({
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
      if (url.endsWith("/robots.txt")) return { text: "User-agent: *", status: 200 };
      if (url.endsWith("/sitemap.xml")) {
        const urls = Array.from({ length: 6 }, (_, i) => `${BASE_URL}/page-${i + 1}`);
        return { text: makeSitemap(urls), status: 200 };
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
      if (url.endsWith("/robots.txt")) return { text: "User-agent: *", status: 200 };
      if (url.endsWith("/sitemap.xml")) return { text: sitemap, status: 200 };
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
        return { text: "User-agent: *\nCrawl-delay: 5", status: 200 };
      if (url.endsWith("/sitemap.xml")) return { text: sitemap, status: 200 };
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
        return { text: "User-agent: *\nCrawl-delay: 60", status: 200 }; // 60s — too long
      if (url.endsWith("/sitemap.xml")) return { text: sitemap, status: 200 };
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
        return { text: "User-agent: *\nDisallow: /admin", status: 200 }; // no Crawl-delay
      if (url.endsWith("/sitemap.xml")) return { text: sitemap, status: 200 };
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
      if (url.endsWith("/robots.txt")) return { text: "User-agent: *", status: 200 };
      if (url.endsWith("/sitemap.xml")) return { text: makeSitemap(urls), status: 200 };
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
