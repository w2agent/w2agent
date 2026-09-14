import robotsParser from "robots-parser";
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
  });

  // Appending "User-agent: ChatGPT-User / Allow: /" merges into the owner's group, where the
  // longer "Disallow: /*" still wins — the old snippet left the check failing after applying it.
  it("named-group block: the snippet describes the same edit the generator makes (delete the token's lines, append its own group)", () => {
    const robotsTxt =
      "User-agent: GPTBot\nUser-agent: ChatGPT-User\nDisallow: /*\n\nUser-agent: *\nDisallow: /";
    const snippet = run(robotsTxt).fixSnippet ?? "";
    expect(
      snippet.startsWith(
        [
          "# Allow AI agents and search fetchers in robots.txt:",
          "# 1. Delete these lines (only the agents below move out; every other agent keeps its rules):",
          "#    line 2: User-agent: ChatGPT-User",
          "# 2. Append:",
          "User-agent: ChatGPT-User",
        ].join("\n"),
      ),
    ).toBe(true);

    const deleted = robotsTxt
      .split("\n")
      .filter((_, i) => i !== 1)
      .join("\n");
    const applied = `${deleted}\n\n${snippet}`;
    expect(run(applied)).toMatchObject({ status: "pass", score: 100 });
    const robots = robotsParser("https://example.com/robots.txt", applied);
    expect(robots.isAllowed("https://example.com/", "GPTBot")).toBe(false);
  });

  it("wildcard block: applying the snippet makes the check pass and keeps * path restrictions", () => {
    const robotsTxt =
      "User-agent: *\nDisallow: /*\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /";
    const result = run(robotsTxt);
    const applied = `${robotsTxt}\n\n${result.fixSnippet}`;
    expect(run(applied)).toMatchObject({ status: "pass", score: 100 });
    const robots = robotsParser("https://example.com/robots.txt", applied);
    expect(robots.isAllowed("https://example.com/private/a", "ChatGPT-User")).toBe(false);
    expect(robots.isAllowed("https://example.com/", "GPTBot")).toBe(false);
    expect(result.fixSnippet).not.toContain("GPTBot");
  });

  it("only warns (partial 50) when an AI search fetcher is blocked — lost discoverability, not refused agents", () => {
    const result = run("User-agent: PerplexityBot\nDisallow: /");
    expect(result).toMatchObject({ status: "partial", score: 50, severity: "warning" });
    expect(result.message).toContain("PerplexityBot");
    expect(result.fixSnippet).toContain("#    line 1: User-agent: PerplexityBot");
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

  const runStatus = (robotsTxtStatus: number | undefined) =>
    aiAgentAccess.run([basePage], { ...baseMeta, robotsTxtStatus });

  it("passes on a 4xx robots.txt — RFC 9309 'unavailable' means crawlers may access everything", () => {
    for (const status of [403, 404, 410]) {
      const result = runStatus(status);
      expect(result).toMatchObject({ status: "pass", score: 100 });
      expect(result.message).toContain("crawlers may access everything");
    }
  });

  it("fails on a 5xx robots.txt — RFC 9309 'unreachable' means crawlers must assume complete disallow", () => {
    for (const status of [500, 503]) {
      const result = runStatus(status);
      expect(result).toMatchObject({ status: "fail", score: 0, severity: "error" });
      expect(result.message).toContain(`returned ${status}`);
      expect(result.message).toContain("assume complete disallow");
    }
  });

  // A 429 only reaches metadata after every retry was rate-limited: the file was never seen,
  // so scoring it as "no robots.txt" would claim access we never measured.
  it("reports error (unmeasured) on a persistent 429", () => {
    const result = runStatus(429);
    expect(result).toMatchObject({ status: "error", score: 0 });
    expect(result.message).toContain("429");
  });

  // 0 means we never saw a response (network error, timeout): unmeasured, not a finding.
  it("reports error (unmeasured) when the robots.txt fetch got no response", () => {
    expect(runStatus(0)).toMatchObject({ status: "error", score: 0 });
  });

  it("passes on a 200 HTML soft-404 (robotsTxt absent) and on hand-built metadata with no status", () => {
    expect(runStatus(200)).toMatchObject({ status: "pass", score: 100 });
    expect(run(undefined)).toMatchObject({ status: "pass", score: 100 });
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
  const run = (...times: number[]) =>
    responseTime.run(
      times.map((t, i) => ({ ...basePage, url: `https://example.com/p${i}`, responseTime: t })),
      baseMeta,
    );

  it("scores 100 for fast pages", () => {
    expect(run(200)).toMatchObject({ status: "pass", score: 100, severity: "info" });
  });

  it("fails very slow pages", () => {
    expect(run(3500)).toMatchObject({ status: "fail", score: 0, severity: "warning" });
  });

  it("uses few coarse buckets with strict < boundaries so run-to-run jitter rarely moves the score", () => {
    expect(run(499)).toMatchObject({ status: "pass", score: 100, severity: "info" });
    expect(run(500)).toMatchObject({ status: "pass", score: 70, severity: "info" });
    expect(run(1499)).toMatchObject({ status: "pass", score: 70, severity: "info" });
    expect(run(1500)).toMatchObject({ status: "partial", score: 35, severity: "warning" });
    expect(run(2999)).toMatchObject({ status: "partial", score: 35, severity: "warning" });
    expect(run(3000)).toMatchObject({ status: "fail", score: 0, severity: "warning" });
  });

  it("skips when every page is unmeasured (responseTime 0) so spider-crawled sites don't earn free full marks", () => {
    const result = run(0, 0, 0);
    expect(result).toMatchObject({ status: "skip", score: 0 });
    expect(result.message).toContain("not measured");
  });

  it("skips with no pages because there is nothing to time", () => {
    expect(responseTime.run([], baseMeta)).toMatchObject({
      status: "skip",
      score: 0,
      message: "No pages to measure",
    });
  });

  it("averages only measured pages so unmeasured zeros can't drag a slow site into a faster bucket", () => {
    const result = run(0, 2000);
    expect(result).toMatchObject({ status: "partial", score: 35 });
    expect(result.message).toContain("2000ms");
    expect(result.message).toContain("1 unmeasured");
    expect(result.details).toBe("https://example.com/p1: 2000ms");
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
