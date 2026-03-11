import { describe, expect, it } from "vitest";
import type { DiscoveredPage } from "../../src/crawl/discovery.js";
import { selectPages } from "../../src/crawl/strategy.js";

function makePage(url: string, overrides?: Partial<DiscoveredPage>): DiscoveredPage {
  return {
    url,
    source: "sitemap",
    internalLinkCount: 0,
    depth: new URL(url).pathname.split("/").filter(Boolean).length,
    ...overrides,
  };
}

const BASE = "https://example.com";

describe("selectPages", () => {
  it("returns top N pages by score", () => {
    const pages = [
      makePage(`${BASE}/blog/post`, { sitemapPriority: 0.3 }),
      makePage(`${BASE}/docs`, { sitemapPriority: 0.8 }),
      makePage(`${BASE}/pricing`, { sitemapPriority: 0.9 }),
      makePage(`${BASE}/about`, { sitemapPriority: 0.5 }),
      makePage(`${BASE}/contact`, { sitemapPriority: 0.2 }),
    ];
    const result = selectPages(pages, 3);
    expect(result).toHaveLength(3);
    // Higher priority pages should rank first
    expect(result[0].url).toBe(`${BASE}/pricing`);
    expect(result[1].url).toBe(`${BASE}/docs`);
  });

  it("excludes URLs in the exclude set", () => {
    const homepage = `${BASE}/`;
    const pages = [
      makePage(homepage, { source: "homepage" }),
      makePage(`${BASE}/docs`),
      makePage(`${BASE}/pricing`),
    ];
    const exclude = new Set([homepage]);
    const result = selectPages(pages, 5, exclude);
    expect(result.every((p) => p.url !== homepage)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty discovered list", () => {
    expect(selectPages([], 10)).toEqual([]);
  });

  it("returns all pages when maxPages exceeds discovered count", () => {
    const pages = [makePage(`${BASE}/docs`), makePage(`${BASE}/pricing`)];
    const result = selectPages(pages, 100);
    expect(result).toHaveLength(2);
  });

  it("pages with sitemap priority and link counts rank higher than bare URLs", () => {
    const pages = [
      makePage(`${BASE}/bare`),
      makePage(`${BASE}/rich`, { sitemapPriority: 0.8, internalLinkCount: 9 }),
    ];
    const result = selectPages(pages, 2);
    expect(result[0].url).toBe(`${BASE}/rich`);
  });

  it("exclude set with no matching URLs returns all pages up to maxPages", () => {
    const pages = [
      makePage(`${BASE}/docs`),
      makePage(`${BASE}/pricing`),
      makePage(`${BASE}/about`),
    ];
    const exclude = new Set([`${BASE}/other`]);
    const result = selectPages(pages, 2, exclude);
    expect(result).toHaveLength(2);
  });
});
