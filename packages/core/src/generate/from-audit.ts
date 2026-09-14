import type { AuditReport, CheckResult } from "../audit/types.js";
import type { GenerateFormat } from "./types.js";

export const CHECK_TO_FORMAT: Record<string, GenerateFormat> = {
  "robots-txt-exists": "robots-txt",
  "ai-agent-access": "robots-txt",
  "schema-org-present": "schema-org",
  "schema-org-type": "schema-org",
  "schema-org-completeness": "schema-org",
  "schema-org-valid": "schema-org",
  "llms-txt-exists": "llms-txt",
  "llms-txt-valid": "llms-txt",
  "llms-txt-links-resolve": "llms-txt",
  "faq-content": "faq",
  "webmcp-declarative": "webmcp",
  "forms-structured": "webmcp",
};

export interface FromAuditResult {
  formats: GenerateFormat[];
  unfixable: CheckResult[];
}

export function mapFailedChecksToFormats(report: AuditReport): FromAuditResult {
  const formats = new Set<GenerateFormat>();
  const unfixable: CheckResult[] = [];

  for (const category of report.categories) {
    for (const check of category.checks) {
      if (
        check.status === "skip" ||
        check.status === "error" ||
        check.tracked ||
        check.score >= 100
      )
        continue;
      const format = CHECK_TO_FORMAT[check.id];
      if (format) {
        formats.add(format);
      } else {
        unfixable.push(check);
      }
    }
  }

  return { formats: [...formats], unfixable };
}
