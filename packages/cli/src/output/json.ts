import type { AuditReport } from "@w2agent/core";

export function formatJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}
