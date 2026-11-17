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
};

export function withGuide(result: CheckResult): CheckResult {
  if (result.status === "pass") return result;
  const guideId = CHECK_GUIDES[result.id];
  const guide = guideId ? GUIDES.find((g) => g.id === guideId) : undefined;
  return guide ? { ...result, guide: guide.id, fixBy: guide.fixBy } : result;
}
