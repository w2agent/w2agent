import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allChecks } from "../src/audit/checks/index.js";
import { reachChecks, reachGoogle, reachPerplexity } from "../src/audit/checks/reach.js";
import {
  applyNaCascade,
  clearChecks,
  computeCategoryScore,
  computeOverallScore,
  getRegisteredChecks,
  registerChecks,
  runAudit,
} from "../src/audit/engine.js";
import type {
  AuditReport,
  CategoryResult,
  Check,
  CheckResult,
  FetchedPage,
  MultiUaResponse,
  SiteMetadata,
} from "../src/audit/types.js";
import { mapFailedChecksToFormats } from "../src/generate/from-audit.js";

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

// Mock fetch globally so checks that probe remote URLs don't make real network
// calls (and don't hang on AbortSignal.timeout delays). Use mockImplementation
// (not mockResolvedValue) so each call gets a fresh Response body — a shared
// Response body is only readable once, which causes concurrent reads to hang.
let fetchMock: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("", { status: 404 }));
});
afterEach(() => {
  fetchMock?.mockRestore();
});

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
      expect(["pass", "fail", "partial", "skip", "error"]).toContain(r.status);
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
    const checks = [makeCheck({ status: "skip" }), makeCheck({ status: "skip" })];
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
      makeCategoryResult(100, 0.1),
      makeCategoryResult(null, 0.2),
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

function r(id: string, status: CheckResult["status"], category = "agent-auth"): CheckResult {
  return {
    id,
    name: id,
    category: category as CheckResult["category"],
    status,
    score: status === "pass" ? 100 : status === "partial" ? 50 : 0,
    maxScore: 100,
    weight: 1,
    message: "x",
    severity: "info",
  };
}

const NO_MCP = { mcpEndpoint: undefined };
const WITH_MCP = { mcpEndpoint: "https://example.com/mcp" };

describe("applyNaCascade (§5.6)", () => {
  it("A1 fail → openapi-spec/developer-portal/oauth-support/oauth-protected-resource/api-catalog become skip", () => {
    const results = [
      r("public-api", "fail"),
      r("openapi-spec", "fail"),
      r("developer-portal", "fail"),
      r("oauth-support", "fail"),
      r("oauth-protected-resource", "fail"),
      r("api-catalog-rfc9727", "fail"),
    ];
    applyNaCascade(results, NO_MCP);
    for (const id of [
      "openapi-spec",
      "developer-portal",
      "oauth-support",
      "oauth-protected-resource",
      "api-catalog-rfc9727",
    ]) {
      expect(results.find((x) => x.id === id)?.status).toBe("skip");
    }
  });

  it("no confirmed MCP endpoint → MCP-tier checks become skip (mcp-auth-mechanism, mcp-oauth-metadata, oauth-metadata-rfc9728, mcp-server-card)", () => {
    const results = [
      r("mcp-discovery", "fail"),
      r("mcp-auth-mechanism", "fail"),
      r("mcp-oauth-metadata", "fail"),
      r("oauth-metadata-rfc9728", "fail"),
      r("mcp-server-card", "fail"),
    ];
    applyNaCascade(results, NO_MCP);
    for (const id of [
      "mcp-auth-mechanism",
      "mcp-oauth-metadata",
      "oauth-metadata-rfc9728",
      "mcp-server-card",
    ]) {
      expect(results.find((x) => x.id === id)?.status).toBe("skip");
    }
  });

  it("confirmed MCP endpoint → MCP-tier checks stay fail (no skip when MCP is present)", () => {
    const results = [
      r("mcp-discovery", "pass"),
      r("mcp-auth-mechanism", "fail"),
      r("mcp-server-card", "fail"),
    ];
    applyNaCascade(results, WITH_MCP);
    expect(results.find((x) => x.id === "mcp-auth-mechanism")?.status).toBe("fail");
    expect(results.find((x) => x.id === "mcp-server-card")?.status).toBe("fail");
  });

  it("MCP-tier cascade keys on the endpoint sentinel, not mcp-discovery's status", () => {
    // A partial mcp-discovery (e.g. legacy HTTP+SSE) must not decide applicability on its own:
    // without a confirmed endpoint the MCP-tier rows are NA whatever mcp-discovery says.
    const results = [r("mcp-discovery", "partial"), r("mcp-auth-mechanism", "fail")];
    applyNaCascade(results, NO_MCP);
    expect(results.find((x) => x.id === "mcp-auth-mechanism")?.status).toBe("skip");
  });

  it("no MCP endpoint demotes MCP-tier rows that scored pass/partial and zeroes their score (a stub mcp.json must not score on a non-MCP site)", () => {
    const results = [
      r("mcp-server-card", "pass"),
      r("mcp-auth-mechanism", "partial"),
      r("mcp-oauth-metadata", "pass"),
      r("oauth-metadata-rfc9728", "partial"),
    ];
    applyNaCascade(results, NO_MCP);
    for (const x of results) {
      expect({ id: x.id, status: x.status, score: x.score }).toEqual({
        id: x.id,
        status: "skip",
        score: 0,
      });
    }
  });

  it("with an MCP endpoint, pass/partial MCP-tier rows keep their status and score", () => {
    const results = [r("mcp-server-card", "pass"), r("mcp-auth-mechanism", "partial")];
    applyNaCascade(results, WITH_MCP);
    expect(results.map((x) => [x.status, x.score])).toEqual([
      ["pass", 100],
      ["partial", 50],
    ]);
  });

  it("A3 fail (developer-portal) → agent-auth-docs/scoped-permissions become skip", () => {
    const results = [
      r("public-api", "pass"),
      r("developer-portal", "fail"),
      r("agent-auth-docs", "fail"),
      r("scoped-permissions", "fail"),
    ];
    applyNaCascade(results, NO_MCP);
    expect(results.find((x) => x.id === "agent-auth-docs")?.status).toBe("skip");
    expect(results.find((x) => x.id === "scoped-permissions")?.status).toBe("skip");
  });

  it("does not override pass or partial", () => {
    const results = [
      r("public-api", "fail"),
      r("openapi-spec", "pass"),
      r("developer-portal", "partial"),
    ];
    applyNaCascade(results, NO_MCP);
    expect(results.find((x) => x.id === "openapi-spec")?.status).toBe("pass");
    expect(results.find((x) => x.id === "developer-portal")?.status).toBe("partial");
  });

  it("B5 (pkce-s256) requires BOTH oauth-support AND developer-portal to fail before skipping", () => {
    // oauth-support pass alone → pkce-s256 stays fail (not skipped)
    const r1 = [r("oauth-support", "pass"), r("developer-portal", "fail"), r("pkce-s256", "fail")];
    applyNaCascade(r1, NO_MCP);
    expect(r1.find((x) => x.id === "pkce-s256")?.status).toBe("fail");

    // both fail → skip
    const r2 = [r("oauth-support", "fail"), r("developer-portal", "fail"), r("pkce-s256", "fail")];
    applyNaCascade(r2, NO_MCP);
    expect(r2.find((x) => x.id === "pkce-s256")?.status).toBe("skip");
  });

  it("C3 (mcp-pkce-s256) cascades off C2 (mcp-oauth-metadata)", () => {
    const results = [r("mcp-oauth-metadata", "fail"), r("mcp-pkce-s256", "fail")];
    applyNaCascade(results, WITH_MCP);
    expect(results.find((x) => x.id === "mcp-pkce-s256")?.status).toBe("skip");
  });

  it("C3 does not cascade when mcp-oauth-metadata passes", () => {
    const results = [r("mcp-oauth-metadata", "pass"), r("mcp-pkce-s256", "fail")];
    applyNaCascade(results, WITH_MCP);
    expect(results.find((x) => x.id === "mcp-pkce-s256")?.status).toBe("fail");
  });

  it("skip in byId is treated as NA (already cascaded checks propagate further)", () => {
    // developer-portal starts fail → cascade marks it skip (it's in cascade list as downstream of public-api)
    // agent-auth-docs depends on developer-portal → should also skip
    const results = [
      r("public-api", "fail"),
      r("developer-portal", "fail"),
      r("agent-auth-docs", "fail"),
    ];
    applyNaCascade(results, NO_MCP);
    expect(results.find((x) => x.id === "developer-portal")?.status).toBe("skip");
    expect(results.find((x) => x.id === "agent-auth-docs")?.status).toBe("skip");
  });

  it("all-skip agent-auth category → category score null + overallScore is finite", async () => {
    const pages: FetchedPage[] = [makePage("<html><body><p>hi</p></body></html>")];
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
    const authCat = report.categories.find((c) => c.id === "agent-auth");
    expect(authCat).toBeDefined();
    expect(authCat?.checks.length).toBe(15);
    expect(Number.isFinite(report.overallScore)).toBe(true);
  });

  it("integration: Stripe-shaped fixture (api links + OpenAPI + oauth metadata) → agent-auth scores ≥60", async () => {
    const html = `<html><body>
      <a href="/api/">API docs</a><a href="/api/charges">Charges</a>
      <a href="/api/customers">Customers</a><a href="/developers">Developer portal</a>
    </body></html>`;
    const pages: FetchedPage[] = [makePage(html, "https://stripe.test")];
    const metadata: SiteMetadata = {
      baseUrl: "https://stripe.test",
      robotsTxt:
        "User-agent: GPTBot\nAllow: /\nUser-agent: ClaudeBot\nAllow: /\nUser-agent: PerplexityBot\nAllow: /",
      wellKnown: {
        "oauth-authorization-server": JSON.stringify({
          issuer: "https://stripe.test",
          authorization_endpoint: "https://stripe.test/oauth/authorize",
          token_endpoint: "https://stripe.test/oauth/token",
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["read:charges", "write:customers"],
        }),
        "oauth-protected-resource": JSON.stringify({ resource: "https://stripe.test/api" }),
      },
      openapi: {
        url: "https://stripe.test/openapi.json",
        endpoints: [{ path: "/charges", method: "GET" }],
      } as any,
    };
    // Mock fetch: portal paths return content (for A3/A4/B4/B5), all others 404
    const portalContent = "API key for agent bot AI rate limit OAuth scope permission ".repeat(50);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = url.toString();
      if (
        u.includes("/developers") ||
        u.includes("/developer") ||
        u.includes("/api-docs") ||
        u.includes("/docs/api")
      ) {
        return new Response(`<html><body>${portalContent}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (u.includes("/api/") || u.endsWith("/api")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock;
    try {
      const report = await runAudit(
        "https://stripe.test",
        { prefetchedPages: pages, prefetchedMetadata: metadata },
        undefined,
        allChecks,
      );
      const auth = report.categories.find((c) => c.id === "agent-auth")!;
      expect(auth).toBeDefined();
      expect(auth.score).not.toBeNull();
      expect(auth.score!).toBeGreaterThanOrEqual(60);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// C-3: an unmeasured check (our crawler ran out of time) must neither cost the site
// points nor raise its score by dropping out silently — it is excluded and flagged.
describe("error (unmeasured) status", () => {
  const ok = {
    status: 200,
    contentLength: 5000,
    finalUrl: "https://example.com/",
    reachable: true,
  };
  const protocolAnchor: Check = {
    id: "anchor",
    name: "anchor",
    category: "agent-protocols",
    weight: 1,
    severity: "info",
    run: () => ({
      id: "anchor",
      name: "anchor",
      category: "agent-protocols",
      status: "partial",
      score: 50,
      maxScore: 100,
      weight: 1,
      message: "anchor",
      severity: "info",
    }),
  };

  async function audit(openai: MultiUaResponse | undefined, checks: Check[]) {
    const metadata: SiteMetadata = {
      baseUrl: "https://example.com",
      wellKnown: {},
      multiUaResponses: {
        ...(openai && { openai }),
        perplexity: { ...ok, outcome: "ok" },
        google: { ...ok, outcome: "ok" },
      },
    };
    const report = await runAudit(
      "https://example.com",
      { prefetchedPages: [makePage("<html><body>hi</body></html>")], prefetchedMetadata: metadata },
      undefined,
      checks,
    );
    const category = report.categories.find((c) => c.id === "agent-protocols");
    return { report, score: category?.score };
  }

  it("scores a budget-skipped reach check like an absent one, warns, and keeps it out of fixes", async () => {
    const skipped: MultiUaResponse = {
      status: 0,
      contentLength: 0,
      finalUrl: "https://example.com/",
      reachable: false,
      outcome: "budget-skipped",
    };
    const blocked: MultiUaResponse = { ...ok, status: 403, reachable: false, outcome: "ok" };

    const unmeasured = await audit(skipped, [protocolAnchor, ...reachChecks]);
    const absent = await audit(undefined, [protocolAnchor, reachPerplexity, reachGoogle]);
    const failed = await audit(blocked, [protocolAnchor, ...reachChecks]);

    const row = unmeasured.report.categories
      .flatMap((c) => c.checks)
      .find((c) => c.id === "reach-openai-user-agent");
    expect(row?.status).toBe("error");
    expect(unmeasured.score).toBe(absent.score);
    expect(failed.score).toBeLessThan(unmeasured.score as number);

    const warning = unmeasured.report.warnings.find((w) => w.id === "unmeasured-checks");
    expect(warning?.details).toBe("reach-openai-user-agent");
    expect(failed.report.warnings.map((w) => w.id)).not.toContain("unmeasured-checks");
    expect(absent.report.warnings.map((w) => w.id)).not.toContain("unmeasured-checks");

    const issueIds = (r: AuditReport) => r.topIssues.map((i) => i.checkId);
    expect(issueIds(unmeasured.report)).not.toContain("reach-openai-user-agent");
    expect(issueIds(failed.report)).toContain("reach-openai-user-agent");

    const unfixableIds = (r: AuditReport) => mapFailedChecksToFormats(r).unfixable.map((c) => c.id);
    expect(unfixableIds(unmeasured.report)).not.toContain("reach-openai-user-agent");
    expect(unfixableIds(failed.report)).toContain("reach-openai-user-agent");
  });

  it("computeCategoryScore excludes error rows from the denominator", () => {
    const pass = { ...r("a", "pass", "agent-protocols") };
    const err = { ...r("b", "fail", "agent-protocols"), status: "error" as const };
    expect(computeCategoryScore([pass, err])).toBe(100);
  });
});
