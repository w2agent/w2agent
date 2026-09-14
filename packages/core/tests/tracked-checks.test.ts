import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentAuthChecks } from "../src/audit/checks/agent-auth.js";
import { computeCategoryScore, runAudit } from "../src/audit/engine.js";
import type {
  AuditReport,
  CategoryId,
  Check,
  CheckResult,
  FetchedPage,
  SiteMetadata,
} from "../src/audit/types.js";
import { mapFailedChecksToFormats } from "../src/generate/from-audit.js";

// Tracked checks (rubric §4.2) are reported but must never move the score, the
// ranked fix list, warnings, or generate formats — otherwise an emerging standard
// changing its path mid-cycle moves everyone's score.

let fetchMock: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("", { status: 404 }));
});
afterEach(() => {
  fetchMock?.mockRestore();
});

function result(overrides: Partial<CheckResult> & { id: string }): CheckResult {
  return {
    name: overrides.id,
    category: "bot-accessibility",
    status: "fail",
    score: 0,
    maxScore: 100,
    weight: 1,
    message: `${overrides.id} message`,
    severity: "error",
    ...overrides,
  };
}

function check(opts: {
  id: string;
  score: number;
  weight?: number;
  category?: CategoryId;
  tracked?: boolean;
}): Check {
  const category = opts.category ?? "bot-accessibility";
  const weight = opts.weight ?? 1;
  return {
    id: opts.id,
    name: opts.id,
    category,
    weight,
    severity: "error",
    ...(opts.tracked && { tracked: true }),
    // run() never self-reports tracked: the engine must stamp it from the definition.
    run: () =>
      result({
        id: opts.id,
        category,
        weight,
        score: opts.score,
        status: opts.score >= 100 ? "pass" : opts.score === 0 ? "fail" : "partial",
      }),
  };
}

async function audit(checks: Check[]): Promise<AuditReport> {
  const pages: FetchedPage[] = [
    {
      url: "https://example.com",
      status: 200,
      html: "<html><head><title>T</title></head><body><p>hi</p></body></html>",
      headers: { "content-type": "text/html" },
      responseTime: 100,
    },
  ];
  const metadata: SiteMetadata = { baseUrl: "https://example.com", wellKnown: {} };
  return runAudit(
    "https://example.com",
    { prefetchedPages: pages, prefetchedMetadata: metadata },
    undefined,
    checks,
  );
}

function findResult(report: AuditReport, id: string): CheckResult | undefined {
  return report.categories.flatMap((c) => c.checks).find((c) => c.id === id);
}

describe("computeCategoryScore with tracked checks", () => {
  it("a passing heavy tracked check does not lift a failing scored check", () => {
    const score = computeCategoryScore([
      result({ id: "scored", status: "fail", score: 0, weight: 1 }),
      result({ id: "tracked", status: "pass", score: 100, weight: 5, tracked: true }),
    ]);
    expect(score).toBe(0);
  });

  it("a failing tracked check does not lower a passing scored check", () => {
    const score = computeCategoryScore([
      result({ id: "scored", status: "pass", score: 100, weight: 1 }),
      result({ id: "tracked", status: "fail", score: 0, weight: 5, tracked: true }),
    ]);
    expect(score).toBe(100);
  });

  it("a category with only tracked checks scores null", () => {
    expect(
      computeCategoryScore([result({ id: "tracked", score: 100, status: "pass", tracked: true })]),
    ).toBeNull();
  });
});

describe("runAudit with tracked checks", () => {
  it("stamps tracked: true from the definition when run() omits it", async () => {
    const report = await audit([
      check({ id: "syn-scored", score: 100 }),
      check({ id: "syn-tracked", score: 100, tracked: true }),
    ]);
    expect(findResult(report, "syn-tracked")?.tracked).toBe(true);
    expect(findResult(report, "syn-scored")?.tracked).toBeUndefined();
  });

  it("keeps tracked results in category.checks for rendering", async () => {
    const report = await audit([check({ id: "syn-tracked", score: 0, tracked: true })]);
    const cat = report.categories.find((c) => c.id === "bot-accessibility");
    expect(cat?.checks.map((c) => c.id)).toContain("syn-tracked");
  });

  it("a failing tracked check never appears in topIssues and does not dilute pointsIfFixed", async () => {
    const alone = await audit([check({ id: "syn-scored", score: 0, weight: 1 })]);
    const withTracked = await audit([
      check({ id: "syn-scored", score: 0, weight: 1 }),
      check({ id: "syn-tracked", score: 0, weight: 5, tracked: true }),
    ]);
    const pts = (r: AuditReport) =>
      r.topIssues.find((i) => i.checkId === "syn-scored")?.pointsIfFixed;
    expect(pts(alone)).toBeGreaterThan(0);
    expect(pts(withTracked)).toBe(pts(alone));
    expect(withTracked.topIssues.map((i) => i.checkId)).not.toContain("syn-tracked");
    expect(withTracked.categories.find((c) => c.id === "bot-accessibility")?.score).toBe(0);
  });

  it("an all-tracked category scores null and is ignored by the overall score", async () => {
    const report = await audit([
      check({ id: "syn-scored", score: 100, category: "technical" }),
      check({ id: "syn-tracked", score: 0, category: "agent-discovery", tracked: true }),
    ]);
    expect(report.categories.find((c) => c.id === "agent-discovery")?.score).toBeNull();
    expect(report.overallScore).toBe(100);
  });

  it("a tracked no-js-dependency scoring 0 does not raise the js-heavy warning", async () => {
    const tracked = await audit([check({ id: "no-js-dependency", score: 0, tracked: true })]);
    expect(tracked.warnings.map((w) => w.id)).not.toContain("js-heavy-site");
    // Control: the same result, scored, does raise it.
    const scored = await audit([check({ id: "no-js-dependency", score: 0 })]);
    expect(scored.warnings.map((w) => w.id)).toContain("js-heavy-site");
  });
});

describe("mapFailedChecksToFormats with tracked checks", () => {
  it("skips a failing tracked check — neither a format nor unfixable", () => {
    const report: AuditReport = {
      url: "https://example.com",
      timestamp: new Date().toISOString(),
      duration: 1,
      pagesScanned: 1,
      overallScore: 0,
      grade: "F",
      rubricVersion: "2.0",
      categories: [
        {
          id: "agent-discovery",
          name: "Agent Discovery",
          weight: 0.12,
          score: null,
          checks: [
            result({ id: "llms-txt-exists", tracked: true }),
            result({ id: "sitemap-exists", tracked: true }),
          ],
        },
      ],
      topIssues: [],
      warnings: [],
    };
    const mapped = mapFailedChecksToFormats(report);
    expect(mapped.formats).toEqual([]);
    expect(mapped.unfixable).toEqual([]);
  });
});

describe("agent-operator-signing is tracked (P1-4)", () => {
  // A Web Bot Auth directory identifies a bot operator; publishing one or not
  // must never move the audited site's agent-auth score.
  const signing = agentAuthChecks.find((c) => c.id === "agent-operator-signing") as Check;
  const openapiSpec = agentAuthChecks.find((c) => c.id === "openapi-spec") as Check;
  const directory = JSON.stringify({
    keys: [{ kty: "OKP", crv: "Ed25519", x: "7F_3jDlxaquwh291MiACkcS3Opq88NksyHiakzS-Y1g" }],
    signature_agent: "https://chatgpt.com",
  });

  async function auditSigning(baseUrl: string, dir: string | undefined): Promise<AuditReport> {
    const metadata: SiteMetadata = {
      baseUrl,
      wellKnown: { "http-message-signatures-directory": dir },
      openapi: { specUrl: `${baseUrl}/openapi.json`, version: "3.1.0", endpoints: [] },
    };
    const pages: FetchedPage[] = [
      {
        url: baseUrl,
        status: 200,
        html: "<html><head><title>T</title></head><body><p>hi</p></body></html>",
        headers: { "content-type": "text/html" },
        responseTime: 100,
      },
    ];
    return runAudit(baseUrl, { prefetchedPages: pages, prefetchedMetadata: metadata }, undefined, [
      signing,
      openapiSpec,
    ]);
  }

  it("pass, fail and absent directories leave the agent-auth score and top issues unchanged", async () => {
    const variants = [
      { report: await auditSigning("https://chatgpt.com", directory), status: "pass" },
      { report: await auditSigning("https://example.com", directory), status: "fail" },
      { report: await auditSigning("https://example.com", undefined), status: "skip" },
    ];
    for (const { report, status } of variants) {
      expect(findResult(report, "agent-operator-signing")).toMatchObject({ status, tracked: true });
      expect(findResult(report, "openapi-spec")).toMatchObject({ status: "partial", score: 50 });
      expect(report.categories.find((c) => c.id === "agent-auth")?.score).toBe(50);
      expect(report.topIssues.map((i) => i.checkId)).not.toContain("agent-operator-signing");
    }
  });
});
