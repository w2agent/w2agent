import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allChecks } from "../src/audit/checks/index.js";
import {
  clearChecks,
  computeCategoryScore,
  computeOverallScore,
  getRegisteredChecks,
  registerChecks,
  runAudit,
} from "../src/audit/engine.js";
import type { CategoryResult, CheckResult, FetchedPage, SiteMetadata } from "../src/audit/types.js";

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, "fixtures", name), "utf-8");
}

function makePage(html: string, url = "https://example.com"): FetchedPage {
  return {
    url,
    status: 200,
    html,
    headers: { "content-type": "text/html; charset=utf-8" },
    responseTime: 100,
  };
}

describe("check registry", () => {
  beforeEach(() => {
    clearChecks();
  });

  it("registers and retrieves checks", () => {
    registerChecks(allChecks);
    expect(getRegisteredChecks().length).toBeGreaterThan(30);
  });

  it("clears checks", () => {
    registerChecks(allChecks);
    clearChecks();
    expect(getRegisteredChecks()).toHaveLength(0);
  });
});

describe("individual check execution", () => {
  it("all checks return valid results against basic page", async () => {
    const html = loadFixture("basic-page.html");
    const page = makePage(html);
    const meta: SiteMetadata = {
      baseUrl: "https://example.com",
      robotsTxt: "User-agent: *\nAllow: /",
      sitemapXml:
        '<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url></urlset>',
      wellKnown: {},
    };

    const validate = (r: any, checkId: string) => {
      expect(r.id).toBe(checkId);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.maxScore).toBe(100);
      expect(["pass", "fail", "partial", "skip"]).toContain(r.status);
    };

    const promises: Promise<void>[] = [];
    for (const check of allChecks) {
      const result = check.run([page], meta);
      if (result instanceof Promise) {
        promises.push(result.then((r) => validate(r, check.id)));
      } else {
        validate(result, check.id);
      }
    }
    await Promise.all(promises);
  });

  it("well-structured page scores higher than bare page", () => {
    const richHtml = loadFixture("with-schema.html");
    const bareHtml = "<html><body><p>Hello</p></body></html>";

    const meta: SiteMetadata = {
      baseUrl: "https://example.com",
      wellKnown: {},
    };

    // Run a few key checks on both
    const schemaCheck = allChecks.find((c) => c.id === "schema-org-present")!;
    const richResult = schemaCheck.run([makePage(richHtml)], meta);
    const bareResult = schemaCheck.run([makePage(bareHtml)], meta);

    expect((richResult as any).score).toBeGreaterThan((bareResult as any).score);
  });
});

describe("check coverage", () => {
  it("has checks for all 7 categories", () => {
    const categories = new Set(allChecks.map((c) => c.category));
    expect(categories.size).toBe(7);
    expect(categories).toContain("bot-accessibility");
    expect(categories).toContain("structured-data");
    expect(categories).toContain("content-quality");
    expect(categories).toContain("agent-discovery");
    expect(categories).toContain("agent-protocols");
    expect(categories).toContain("technical");
    expect(categories).toContain("agent-auth");
  });

  it("has at least 35 checks total", () => {
    expect(allChecks.length).toBeGreaterThanOrEqual(35);
  });

  it("all checks have unique IDs", () => {
    const ids = allChecks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("JS-heavy site warning heuristic", () => {
  // Mirror the heuristic from computeWarnings()
  function isJsHeavy(noJsScore: number, tokenScore: number): boolean {
    return noJsScore <= 30 || (noJsScore <= 50 && tokenScore <= 30);
  }

  it("detects pure SPA (no-js=0)", () => {
    expect(isJsHeavy(0, 0)).toBe(true);
  });

  it("detects SPA with no-js ≤ 30", () => {
    expect(isJsHeavy(20, 80)).toBe(true);
  });

  it("detects partial SSR with no-js ≤ 50 and token ≤ 30", () => {
    expect(isJsHeavy(40, 20)).toBe(true);
  });

  it("no warning when no-js is fine", () => {
    expect(isJsHeavy(80, 60)).toBe(false);
  });

  it("no warning when no-js is borderline but token-efficiency is fine", () => {
    expect(isJsHeavy(45, 60)).toBe(false);
  });

  it("boundary: no-js=30 triggers warning", () => {
    expect(isJsHeavy(30, 80)).toBe(true);
  });

  it("boundary: no-js=31 does not trigger via first condition", () => {
    // only triggered if tokenScore ≤ 30 too
    expect(isJsHeavy(31, 60)).toBe(false);
  });
});

function makeCheck(
  overrides: Partial<CheckResult> & { status: CheckResult["status"] },
): CheckResult {
  return {
    id: "test-check",
    name: "Test Check",
    category: "bot-accessibility",
    status: overrides.status,
    score: overrides.status === "pass" ? 100 : overrides.status === "fail" ? 0 : 50,
    maxScore: 100,
    weight: 1,
    message: "test",
    severity: "info",
    ...overrides,
  };
}

function makeCategoryResult(score: number | null, weight: number): CategoryResult {
  return {
    id: "bot-accessibility",
    name: "Bot Accessibility",
    weight,
    score,
    checks: [],
  };
}

describe("NA semantics", () => {
  it("computeCategoryScore returns null when all checks are skip", () => {
    const checks = [
      makeCheck({ status: "skip" }),
      makeCheck({ status: "skip" }),
    ];
    expect(computeCategoryScore(checks)).toBeNull();
  });

  it("computeCategoryScore excludes skip from denominator", () => {
    const checks = [
      makeCheck({ status: "pass", score: 80, weight: 1 }),
      makeCheck({ status: "skip", score: 50, weight: 1 }),
    ];
    // Only the pass check is applicable; score should be exactly 80
    expect(computeCategoryScore(checks)).toBe(80);
  });

  it("computeOverallScore re-normalizes when one category is null", () => {
    // agent-auth (weight 0.20) is null; remaining 6 categories sum to 0.80
    // Each gets score = 100; re-normalized weights sum to 1.0, so overall = 100
    const categories: CategoryResult[] = [
      makeCategoryResult(100, 0.15),
      makeCategoryResult(100, 0.15),
      makeCategoryResult(100, 0.15),
      makeCategoryResult(100, 0.12),
      makeCategoryResult(100, 0.13),
      makeCategoryResult(100, 0.10),
      makeCategoryResult(null, 0.20),
    ];
    expect(computeOverallScore(categories)).toBe(100);
  });

  it("runAudit stamps rubricVersion='2.0' on report", async () => {
    const pages: FetchedPage[] = [
      makePage("<html><head><title>Test</title></head><body><p>hello</p></body></html>"),
    ];
    const metadata: SiteMetadata = {
      baseUrl: "https://example.com",
      robotsTxt: "User-agent: *\nAllow: /",
      wellKnown: {},
    };
    const report = await runAudit(
      "https://example.com",
      { prefetchedPages: pages, prefetchedMetadata: metadata },
      undefined,
      allChecks,
    );
    expect(report.rubricVersion).toBe("2.0");
  });
});

describe("runAudit prefetch bypass", () => {
  it("skips crawlSite when prefetchedPages and prefetchedMetadata are provided", async () => {
    const crawlerModule = await import("../src/audit/crawler.js");
    const crawlSpy = vi.spyOn(crawlerModule, "crawlSite");

    const pages: FetchedPage[] = [
      makePage("<html><head><title>Test</title></head><body><p>hello</p></body></html>"),
    ];
    const metadata: SiteMetadata = {
      baseUrl: "https://example.com",
      robotsTxt: "User-agent: *\nAllow: /",
      sitemapXml:
        '<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url></urlset>',
      wellKnown: {},
    };

    const report = await runAudit(
      "https://example.com",
      { prefetchedPages: pages, prefetchedMetadata: metadata },
      undefined,
      allChecks,
    );

    expect(crawlSpy).not.toHaveBeenCalled();
    expect(report.pagesScanned).toBe(1);
    crawlSpy.mockRestore();
  });
});
