import { describe, expect, it } from "vitest";
import type { AuditReport } from "w2agent-core";
import { formatReport } from "../src/output/terminal.js";

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
