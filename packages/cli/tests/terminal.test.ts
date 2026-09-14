import { describe, expect, it } from "vitest";
import type { AuditReport, CheckResult } from "w2agent-core";
import { formatReport, formatVerboseReport } from "../src/output/terminal.js";

function makeReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    url: "https://example.com",
    timestamp: "2024-01-01T00:00:00.000Z",
    duration: 1000,
    pagesScanned: 5,
    overallScore: 50,
    grade: "C",
    categories: [],
    topIssues: [],
    warnings: [],
    ...overrides,
  };
}

describe("formatReport warnings", () => {
  it("shows no warnings section when empty", () => {
    const output = formatReport(makeReport({ warnings: [] }));
    expect(output).not.toContain("Warnings:");
  });

  it("shows warnings section when warnings present", () => {
    const output = formatReport(
      makeReport({
        warnings: [
          {
            id: "js-heavy-site",
            title: "JavaScript-dependent content detected",
            message: "Most pages require JavaScript to render content.",
          },
        ],
      }),
    );
    expect(output).toContain("Warnings:");
    expect(output).toContain("JavaScript-dependent content detected");
    expect(output).toContain("Most pages require JavaScript");
  });

  it("shows details when present", () => {
    const output = formatReport(
      makeReport({
        warnings: [
          {
            id: "js-heavy-site",
            title: "JS Heavy",
            message: "Content needs JS.",
            details: "Only 1/5 pages have content",
          },
        ],
      }),
    );
    expect(output).toContain("Only 1/5 pages have content");
  });

  it("shows all warnings when multiple present", () => {
    const output = formatReport(
      makeReport({
        warnings: [
          { id: "js-heavy-site", title: "JS Heavy", message: "Content needs JS." },
          { id: "other-warning", title: "Other Warning", message: "Something else." },
        ],
      }),
    );
    expect(output).toContain("JS Heavy");
    expect(output).toContain("Other Warning");
  });
});

function makeCheck(overrides: Partial<CheckResult> & { id: string; name: string }): CheckResult {
  return {
    category: "agent-discovery",
    status: "fail",
    score: 0,
    maxScore: 100,
    weight: 1,
    message: "",
    severity: "error",
    ...overrides,
  };
}

describe("formatVerboseReport tracked checks", () => {
  // Tracked checks are not scored, so they must not read as category failures.
  it("lists tracked checks under a separate heading, not in their category", () => {
    const output = formatVerboseReport(
      makeReport({
        categories: [
          {
            id: "agent-discovery",
            name: "Agent Discovery",
            weight: 0.12,
            score: 100,
            checks: [
              makeCheck({ id: "scored", name: "Scored Check", status: "pass", score: 100 }),
              makeCheck({
                id: "tracked",
                name: "Emerging Standard Check",
                message: "Not found",
                tracked: true,
              }),
            ],
          },
        ],
      }),
    );
    const heading = output.indexOf("Tracked (not scored)");
    expect(heading).toBeGreaterThan(-1);
    expect(output.split("Emerging Standard Check")).toHaveLength(2);
    expect(output.indexOf("Emerging Standard Check")).toBeGreaterThan(heading);
    expect(output.indexOf("Scored Check")).toBeLessThan(heading);
    expect(output.indexOf("Not found")).toBeGreaterThan(heading);
  });

  it("omits the tracked heading when no checks are tracked", () => {
    const output = formatVerboseReport(
      makeReport({
        categories: [
          {
            id: "agent-discovery",
            name: "Agent Discovery",
            weight: 0.12,
            score: 100,
            checks: [makeCheck({ id: "scored", name: "Scored Check", status: "pass", score: 100 })],
          },
        ],
      }),
    );
    expect(output).not.toContain("Tracked (not scored)");
  });
});
