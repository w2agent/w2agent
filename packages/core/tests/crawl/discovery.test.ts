import { describe, expect, it } from "vitest";
import {
  discoverInternalLinks,
  discoverPages,
  parseSitemapWithMetadata,
} from "../../src/crawl/discovery.js";

const BASE_URL = "https://example.com";

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <priority>1.0</priority>
    <lastmod>2024-01-15</lastmod>
  </url>
  <url>
    <loc>https://example.com/docs/getting-started</loc>
    <priority>0.8</priority>
    <lastmod>2024-03-01</lastmod>
  </url>
  <url>
    <loc>https://example.com/blog/post-1</loc>
  </url>
  <url>
    <loc>https://other.com/page</loc>
    <priority>0.5</priority>
  </url>
</urlset>`;

const HOMEPAGE_HTML = `<html><body>
  <a href="/docs/getting-started">Docs</a>
  <a href="/docs/getting-started">Docs again</a>
  <a href="/blog/post-1">Blog</a>
  <a href="https://external.com/page">External</a>
  <a href="/about#team">About</a>
  <a href="https://example.com/about">About absolute</a>
</body></html>`;

describe("parseSitemapWithMetadata", () => {
  it("parses loc, priority, and lastmod from standard sitemap", () => {
    const pages = parseSitemapWithMetadata(SITEMAP_XML, BASE_URL);
    const docsPage = pages.find((p) => p.url.includes("getting-started"));
    expect(docsPage).toBeDefined();
    expect(docsPage?.sitemapPriority).toBe(0.8);
    expect(docsPage?.sitemapLastmod).toBe("2024-03-01");
    expect(docsPage?.source).toBe("sitemap");
  });

  it("sets priority and lastmod to undefined when missing", () => {
    const pages = parseSitemapWithMetadata(SITEMAP_XML, BASE_URL);
    const blogPage = pages.find((p) => p.url.includes("blog"));
    expect(blogPage).toBeDefined();
    expect(blogPage?.sitemapPriority).toBeUndefined();
    expect(blogPage?.sitemapLastmod).toBeUndefined();
  });

  it("filters cross-origin URLs", () => {
    const pages = parseSitemapWithMetadata(SITEMAP_XML, BASE_URL);
    expect(pages.every((p) => p.url.startsWith("https://example.com"))).toBe(true);
    expect(pages.find((p) => p.url.includes("other.com"))).toBeUndefined();
  });

  it("handles malformed url blocks with missing loc", () => {
    const xml = `<urlset><url><priority>0.5</priority></url><url><loc>https://example.com/valid</loc></url></urlset>`;
    const pages = parseSitemapWithMetadata(xml, BASE_URL);
    expect(pages).toHaveLength(1);
    expect(pages[0].url).toBe("https://example.com/valid");
  });

  it("computes depth from pathname segments", () => {
    const pages = parseSitemapWithMetadata(SITEMAP_XML, BASE_URL);
    const homepage = pages.find((p) => p.url === "https://example.com/");
    const docsPage = pages.find((p) => p.url.includes("getting-started"));
    expect(homepage?.depth).toBe(0);
    expect(docsPage?.depth).toBe(2);
  });

  it("returns empty array for empty string input", () => {
    expect(parseSitemapWithMetadata("", BASE_URL)).toEqual([]);
  });
});

describe("discoverInternalLinks", () => {
  it("counts internal links from HTML", () => {
    const counts = discoverInternalLinks(HOMEPAGE_HTML, BASE_URL);
    const docsUrl = "https://example.com/docs/getting-started";
    expect(counts.get(docsUrl)).toBe(2);
  });

  it("filters cross-origin links", () => {
    const counts = discoverInternalLinks(HOMEPAGE_HTML, BASE_URL);
    for (const url of counts.keys()) {
      expect(url.startsWith("https://example.com")).toBe(true);
    }
  });

  it("resolves relative URLs against baseUrl", () => {
    const html = `<html><body><a href="/relative/path">link</a></body></html>`;
    const counts = discoverInternalLinks(html, BASE_URL);
    expect(counts.has("https://example.com/relative/path")).toBe(true);
  });

  it("deduplicates by normalized URL - strips fragments and trailing slashes", () => {
    const html = `<html><body>
      <a href="/about#team">About team</a>
      <a href="/about#history">About history</a>
      <a href="https://example.com/about">About absolute</a>
    </body></html>`;
    const counts = discoverInternalLinks(html, BASE_URL);
    const aboutUrl = "https://example.com/about";
    expect(counts.get(aboutUrl)).toBe(3);
  });

  it("returns empty map for HTML with no links", () => {
    const counts = discoverInternalLinks("<html><body><p>No links</p></body></html>", BASE_URL);
    expect(counts.size).toBe(0);
  });
});

describe("discoverPages", () => {
  it("merges sitemap pages with homepage link counts", () => {
    const pages = discoverPages({
      sitemapXml: SITEMAP_XML,
      homepage: { html: HOMEPAGE_HTML, url: BASE_URL },
      baseUrl: BASE_URL,
    });
    const docsPage = pages.find((p) => p.url.includes("getting-started"));
    expect(docsPage).toBeDefined();
    expect(docsPage?.source).toBe("sitemap");
    expect(docsPage?.internalLinkCount).toBe(2);
  });

  it("adds link-only pages not in sitemap", () => {
    const html = `<html><body><a href="/new-page">New</a></body></html>`;
    const pages = discoverPages({
      sitemapXml: SITEMAP_XML,
      homepage: { html, url: BASE_URL },
      baseUrl: BASE_URL,
    });
    const newPage = pages.find((p) => p.url.includes("new-page"));
    expect(newPage).toBeDefined();
    expect(newPage?.source).toBe("link");
    expect(newPage?.internalLinkCount).toBe(1);
  });

  it("always includes homepage entry", () => {
    const pages = discoverPages({ baseUrl: BASE_URL });
    const homepage = pages.find((p) => p.url === "https://example.com/");
    expect(homepage).toBeDefined();
    expect(homepage?.source).toBe("homepage");
  });

  it("works with sitemap only (no homepage)", () => {
    const pages = discoverPages({ sitemapXml: SITEMAP_XML, baseUrl: BASE_URL });
    expect(pages.some((p) => p.url.includes("getting-started"))).toBe(true);
    expect(pages.every((p) => p.internalLinkCount === 0)).toBe(true);
  });

  it("works with homepage only (no sitemap)", () => {
    const pages = discoverPages({
      homepage: { html: HOMEPAGE_HTML, url: BASE_URL },
      baseUrl: BASE_URL,
    });
    const docsPage = pages.find((p) => p.url.includes("getting-started"));
    expect(docsPage).toBeDefined();
    expect(docsPage?.source).toBe("link");
  });
});
