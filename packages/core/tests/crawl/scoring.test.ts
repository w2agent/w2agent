import { describe, expect, it } from "vitest";
import type { DiscoveredPage } from "../../src/crawl/discovery.js";
import { scorePage, sortPagesByScore } from "../../src/crawl/scoring.js";
import { scoreUrl } from "../../src/shared/page-scoring.js";

function makePage(overrides: Partial<DiscoveredPage> & { url: string }): DiscoveredPage {
  return {
    source: "sitemap",
    internalLinkCount: 0,
    depth: new URL(overrides.url).pathname.split("/").filter(Boolean).length,
    ...overrides,
  };
}

describe("scorePage", () => {
  it("homepage scores 25 with no metadata", () => {
    const page = makePage({ url: "https://example.com/" });
    expect(scorePage(page)).toBe(25); // 20 pattern + 5 depth
  });

  it("docs page scores correctly without metadata", () => {
    const page = makePage({ url: "https://example.com/docs/foo" });
    // 7 (docs pattern) + 3 (depth=2, 5-2=3) = 10
    expect(scorePage(page)).toBe(10);
  });

  it("sitemap priority 0.8 adds 8 points", () => {
    const base = makePage({ url: "https://example.com/about" });
    const withPriority = makePage({ url: "https://example.com/about", sitemapPriority: 0.8 });
    expect(scorePage(withPriority) - scorePage(base)).toBe(8);
  });

  it("sitemap priority 1.0 adds 10 points", () => {
    const base = makePage({ url: "https://example.com/pricing" });
    const withPriority = makePage({ url: "https://example.com/pricing", sitemapPriority: 1.0 });
    expect(scorePage(withPriority) - scorePage(base)).toBe(10);
  });

  it("lastmod within 1 month adds 5 points", () => {
    const now = new Date();
    const recentDate = now.toISOString().split("T")[0];
    const base = makePage({ url: "https://example.com/blog" });
    const withLastmod = makePage({ url: "https://example.com/blog", sitemapLastmod: recentDate });
    expect(scorePage(withLastmod) - scorePage(base)).toBe(5);
  });

  it("lastmod older than 24 months adds 0 points", () => {
    const base = makePage({ url: "https://example.com/blog" });
    const withOldLastmod = makePage({
      url: "https://example.com/blog",
      sitemapLastmod: "2020-01-01",
    });
    expect(scorePage(withOldLastmod) - scorePage(base)).toBe(0);
  });

  it("missing lastmod adds 0 points", () => {
    const base = makePage({ url: "https://example.com/features" });
    expect(scorePage(base)).toBe(scorePage(makePage({ url: "https://example.com/features" })));
  });

  it("internalLinkCount 9 adds 3 points", () => {
    const base = makePage({ url: "https://example.com/about" });
    const withLinks = makePage({ url: "https://example.com/about", internalLinkCount: 9 });
    expect(scorePage(withLinks) - scorePage(base)).toBe(3);
  });

  it("internalLinkCount 15 adds 5 points (capped)", () => {
    const base = makePage({ url: "https://example.com/about" });
    const withLinks = makePage({ url: "https://example.com/about", internalLinkCount: 15 });
    expect(scorePage(withLinks) - scorePage(base)).toBe(5);
  });

  it("all signals combined produces correct total", () => {
    const now = new Date();
    const recentDate = now.toISOString().split("T")[0];
    const page = makePage({
      url: "https://example.com/pricing",
      sitemapPriority: 0.5,
      sitemapLastmod: recentDate,
      internalLinkCount: 6,
    });
    // pricing = 8, depth=1 → 5-1=4, priority 0.5 → 5, lastmod recent → 5, links 6 → 2
    expect(scorePage(page)).toBe(8 + 4 + 5 + 5 + 2);
  });

  it("bare page without metadata matches scoreUrl output", () => {
    const url = "https://example.com/docs";
    const page = makePage({ url, source: "link" });
    expect(scorePage(page)).toBe(scoreUrl(url));
  });

  it("invalid lastmod date treated as 0 recency", () => {
    const base = makePage({ url: "https://example.com/contact" });
    const withBadDate = makePage({
      url: "https://example.com/contact",
      sitemapLastmod: "not-a-date",
    });
    expect(scorePage(withBadDate)).toBe(scorePage(base));
  });
});

describe("sortPagesByScore", () => {
  it("returns pages in descending score order", () => {
    const pages = [
      makePage({ url: "https://example.com/blog" }), // lower score
      makePage({ url: "https://example.com/pricing" }), // higher score
      makePage({ url: "https://example.com/about" }), // mid score
    ];
    const sorted = sortPagesByScore(pages);
    const scores = sorted.map(scorePage);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);
    expect(scores[1]).toBeGreaterThanOrEqual(scores[2]);
  });

  it("homepage always first even without metadata", () => {
    const pages = [
      makePage({ url: "https://example.com/pricing", sitemapPriority: 1.0 }),
      makePage({ url: "https://example.com/" }),
      makePage({ url: "https://example.com/docs", internalLinkCount: 15 }),
    ];
    const sorted = sortPagesByScore(pages);
    expect(sorted[0].url).toBe("https://example.com/");
  });

  it("does not mutate input array", () => {
    const pages = [
      makePage({ url: "https://example.com/blog" }),
      makePage({ url: "https://example.com/pricing" }),
    ];
    const original = [...pages];
    sortPagesByScore(pages);
    expect(pages[0].url).toBe(original[0].url);
  });
});
