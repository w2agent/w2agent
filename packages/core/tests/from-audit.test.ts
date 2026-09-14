import { describe, expect, it } from "vitest";
import type { AuditReport, CategoryId, CheckResult } from "../src/audit/types.js";
import { CHECK_TO_FORMAT, mapFailedChecksToFormats } from "../src/generate/from-audit.js";

function makeCheck(overrides: Partial<CheckResult> & { id: string }): CheckResult {
  return {
    name: overrides.id,
    category: "bot-accessibility",
    status: "fail",
    score: 0,
    maxScore: 100,
    weight: 1,
    message: "",
    severity: "error",
    ...overrides,
  };
}

function makeReport(checks: CheckResult[]): AuditReport {
  return {
    url: "https://example.com",
    timestamp: new Date().toISOString(),
    duration: 100,
    pagesScanned: 1,
    overallScore: 50,
    grade: "F",
    categories: [
      { id: "bot-accessibility" as CategoryId, name: "Bot", weight: 0.2, score: 50, checks },
    ],
    topIssues: [],
  };
}

describe("mapFailedChecksToFormats", () => {
  it("returns empty when all checks pass", () => {
    const report = makeReport([
      makeCheck({ id: "robots-txt-exists", status: "pass", score: 100 }),
      makeCheck({ id: "schema-org-present", status: "pass", score: 100 }),
    ]);
    const result = mapFailedChecksToFormats(report);
    expect(result.formats).toEqual([]);
    expect(result.unfixable).toEqual([]);
  });

  it("maps a single failed check to its format", () => {
    const report = makeReport([makeCheck({ id: "llms-txt-exists", status: "fail", score: 0 })]);
    const result = mapFailedChecksToFormats(report);
    expect(result.formats).toEqual(["llms-txt"]);
    expect(result.unfixable).toEqual([]);
  });

  it("deduplicates formats from multiple checks in same category", () => {
    const report = makeReport([
      makeCheck({ id: "schema-org-present", status: "fail", score: 0 }),
      makeCheck({ id: "schema-org-type", status: "fail", score: 0 }),
      makeCheck({ id: "schema-org-completeness", status: "fail", score: 30 }),
      makeCheck({ id: "schema-org-valid", status: "fail", score: 0 }),
    ]);
    const result = mapFailedChecksToFormats(report);
    expect(result.formats).toEqual(["schema-org"]);
  });

  it("puts unmapped failed checks in unfixable", () => {
    const report = makeReport([
      makeCheck({ id: "sitemap-exists", status: "fail", score: 0 }),
      makeCheck({ id: "robots-txt-exists", status: "fail", score: 0 }),
    ]);
    const result = mapFailedChecksToFormats(report);
    expect(result.formats).toEqual(["robots-txt"]);
    expect(result.unfixable).toHaveLength(1);
    expect(result.unfixable[0].id).toBe("sitemap-exists");
  });

  it("includes checks with partial scores (< 100)", () => {
    const report = makeReport([
      makeCheck({ id: "llms-txt-valid", status: "partial", score: 50 }),
      makeCheck({ id: "faq-content", status: "partial", score: 75 }),
    ]);
    const result = mapFailedChecksToFormats(report);
    expect(result.formats).toContain("llms-txt");
    expect(result.formats).toContain("faq");
  });

  it("never auto-generates an agent card: a failing or stub agent card is a manual fix", () => {
    // Generation cannot know the site's A2A endpoint, so a regenerated card would be the
    // same homepage stub the check scores partial — an endless suggest/regenerate loop.
    const report = makeReport([
      makeCheck({ id: "well-known-agent-card", status: "fail", score: 0 }),
      makeCheck({ id: "well-known-agent-card", status: "partial", score: 50 }),
    ]);
    const result = mapFailedChecksToFormats(report);
    expect(result.formats).not.toContain("agent-card");
    expect(result.unfixable.map((c) => c.id)).toEqual([
      "well-known-agent-card",
      "well-known-agent-card",
    ]);
  });

  it("excludes skipped checks entirely", () => {
    const report = makeReport([
      makeCheck({ id: "robots-txt-exists", status: "skip", score: 0 }),
      makeCheck({ id: "sitemap-exists", status: "skip", score: 0 }),
    ]);
    const result = mapFailedChecksToFormats(report);
    expect(result.formats).toEqual([]);
    expect(result.unfixable).toEqual([]);
  });
});

describe("CHECK_TO_FORMAT", () => {
  it("contains entries for all expected check IDs", () => {
    const expectedMappings: Record<string, string> = {
      "robots-txt-exists": "robots-txt",
      "ai-agent-access": "robots-txt",
      "schema-org-present": "schema-org",
      "llms-txt-exists": "llms-txt",
      "faq-content": "faq",
      "forms-structured": "webmcp",
    };
    for (const [checkId, format] of Object.entries(expectedMappings)) {
      expect(CHECK_TO_FORMAT[checkId]).toBe(format);
    }
  });

  it("has no entries for tracked WebMCP checks (skipped by mapFailedChecksToFormats); forms-structured drives webmcp generation", () => {
    expect(CHECK_TO_FORMAT).not.toHaveProperty("webmcp-declarative");
    expect(CHECK_TO_FORMAT).not.toHaveProperty("webmcp-imperative");
    expect(Object.entries(CHECK_TO_FORMAT).filter(([, f]) => f === "webmcp")).toEqual([
      ["forms-structured", "webmcp"],
    ]);
  });
});
