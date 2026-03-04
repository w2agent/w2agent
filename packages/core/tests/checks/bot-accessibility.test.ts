import { describe, it, expect } from "vitest";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";
import {
  robotsTxtExists,
  robotsTxtAiBots,
  sitemapExists,
  responseTime,
  statusCodes,
} from "../../src/audit/checks/bot-accessibility.js";

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

const basePage: FetchedPage = {
  url: "https://example.com",
  status: 200,
  html: "<html><body>Hello</body></html>",
  headers: {},
  responseTime: 100,
};

describe("robots-txt-exists", () => {
  it("passes when robots.txt exists", () => {
    const result = robotsTxtExists.run([basePage], {
      ...baseMeta,
      robotsTxt: "User-agent: *\nAllow: /",
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when no robots.txt", () => {
    const result = robotsTxtExists.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("robots-txt-ai-bots", () => {
  it("passes when all bots allowed", () => {
    const result = robotsTxtAiBots.run([basePage], {
      ...baseMeta,
      robotsTxt: "User-agent: *\nAllow: /",
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when bots are blocked", () => {
    const result = robotsTxtAiBots.run([basePage], {
      ...baseMeta,
      robotsTxt: "User-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nDisallow: /",
    });
    expect(result).toMatchObject({ status: "partial" });
    expect(result.score).toBeLessThan(100);
    expect(result.score).toBeGreaterThan(0);
  });

  it("blocks all bots", () => {
    const robotsTxt = [
      "User-agent: GPTBot\nDisallow: /",
      "User-agent: ClaudeBot\nDisallow: /",
      "User-agent: PerplexityBot\nDisallow: /",
      "User-agent: Google-Extended\nDisallow: /",
      "User-agent: Bytespider\nDisallow: /",
    ].join("\n");
    const result = robotsTxtAiBots.run([basePage], { ...baseMeta, robotsTxt });
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("sitemap-exists", () => {
  it("passes with valid sitemap", () => {
    const result = sitemapExists.run([basePage], {
      ...baseMeta,
      sitemapXml: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>',
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when no sitemap", () => {
    const result = sitemapExists.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("response-time", () => {
  it("scores 100 for fast pages", () => {
    const result = responseTime.run([{ ...basePage, responseTime: 200 }], baseMeta);
    expect(result.score).toBe(100);
  });

  it("scores lower for slow pages", () => {
    const result = responseTime.run([{ ...basePage, responseTime: 3500 }], baseMeta);
    expect(result.score).toBe(0);
  });
});

describe("status-codes", () => {
  it("passes when all pages return 200", () => {
    const result = statusCodes.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("partial when some pages have errors", () => {
    const result = statusCodes.run(
      [basePage, { ...basePage, url: "https://example.com/broken", status: 404 }],
      baseMeta,
    );
    expect(result).toMatchObject({ status: "partial" });
    expect(result.score).toBe(50);
  });
});
