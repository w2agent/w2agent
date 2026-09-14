import { describe, expect, it } from "vitest";
import {
  aiAgentAccess,
  responseTime,
  robotsTxtExists,
  sitemapExists,
  statusCodes,
} from "../../src/audit/checks/bot-accessibility.js";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";

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

describe("ai-agent-access", () => {
  const run = (robotsTxt?: string) => aiAgentAccess.run([basePage], { ...baseMeta, robotsTxt });

  it("fails with severity error when a user-initiated agent is blocked — the site declares intent to refuse agents acting for a person", () => {
    const result = run("User-agent: ChatGPT-User\nDisallow: /");
    expect(result).toMatchObject({ status: "fail", score: 0, severity: "error" });
    expect(result.message).toContain("ChatGPT-User");
    expect(result.message).toContain("declares intent to block");
    expect(result.fixSnippet).toContain("User-agent: ChatGPT-User\nAllow: /");
  });

  it("only warns (partial 50) when an AI search fetcher is blocked — lost discoverability, not refused agents", () => {
    const result = run("User-agent: PerplexityBot\nDisallow: /");
    expect(result).toMatchObject({ status: "partial", score: 50, severity: "warning" });
    expect(result.message).toContain("PerplexityBot");
    expect(result.fixSnippet).toContain("User-agent: PerplexityBot\nAllow: /");
  });

  it("stays pass 100 when only training crawlers are blocked — opting out of training is neutral (D-2)", () => {
    const result = run(
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /",
    );
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.details).toMatch(/Training.*blocked: GPTBot, Google-Extended, CCBot/);
    expect(result.fixSnippet).toBeUndefined();
  });

  it("does not fix-suggest training tokens when user/search tokens are also blocked", () => {
    const result = run(
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: Claude-SearchBot\nDisallow: /",
    );
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.fixSnippet).toContain("Claude-SearchBot");
    expect(result.fixSnippet).not.toContain("GPTBot");
  });

  it("fails when User-agent: * disallows everything — user agents inherit the wildcard block", () => {
    const result = run("User-agent: *\nDisallow: /");
    expect(result).toMatchObject({ status: "fail", score: 0, severity: "error" });
    expect(result.message).toContain("Claude-User");
  });

  it("passes when only a path is disallowed — the site root stays reachable", () => {
    expect(run("User-agent: *\nDisallow: /private")).toMatchObject({ status: "pass", score: 100 });
  });

  it("passes when there is no robots.txt — nothing is blocked (absence is scored by robots-txt-exists)", () => {
    const result = run(undefined);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("nothing is blocked");
  });

  it("never evaluates Google-Agent — it has no robots.txt token; only notes it in details", () => {
    const result = run("User-agent: Google-Agent\nDisallow: /");
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.details).toContain("Google-Agent: no robots.txt token");
    expect(result.message).not.toContain("Google-Agent");
    expect(result.details).not.toMatch(/blocked: [^\n]*Google-Agent/);
  });
});

describe("sitemap-exists", () => {
  it("passes with valid sitemap", () => {
    const result = sitemapExists.run([basePage], {
      ...baseMeta,
      sitemapXml:
        '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>',
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
