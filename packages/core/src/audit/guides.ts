import { GUIDES } from "./guides.generated.js";
import type { CheckResult } from "./types.js";

export const CHECK_GUIDES: Readonly<Record<string, string>> = {
  "sitemap-exists": "sitemap",
  "schema-org-present": "schema-org",
  "schema-org-type": "schema-org",
  "schema-org-completeness": "schema-org",
  "schema-org-valid": "schema-org",
  "canonical-urls": "canonical",
  "security-headers": "security-headers",
  "markdown-alternate": "markdown-alternate",
  "robots-txt-exists": "robots",
  "ai-agent-access": "robots-access",
  "local-business-booking-accessible": "robots-access",
  "og-meta-tags": "og-meta-tags",
  "semantic-html": "semantic-html",
  "heading-hierarchy": "semantic-html",
  "local-business-nap-structured": "local-business",
  "local-business-hours-jsonld": "local-business",
  "llms-txt-exists": "llms-txt",
  "llms-txt-valid": "llms-txt",
  "llms-txt-links-resolve": "llms-txt",
  "content-negotiation": "content-negotiation",
  "forms-structured": "forms-structured",
};

export function withGuide(result: CheckResult): CheckResult {
  if (result.status === "pass") return result;
  const guideId = CHECK_GUIDES[result.id];
  const guide = guideId ? GUIDES.find((g) => g.id === guideId) : undefined;
  return guide ? { ...result, guide: guide.id, fixBy: guide.fixBy } : result;
}
