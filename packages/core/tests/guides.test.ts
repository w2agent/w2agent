import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { GUIDES_DIR, loadGuides, OUTPUT, renderModule } from "../scripts/gen-guides.mjs";
import { allChecks } from "../src/audit/checks/index.js";
import { runAudit } from "../src/audit/engine.js";
import { GUIDES } from "../src/audit/guides.generated.js";
import { CHECK_GUIDES } from "../src/audit/guides.js";
import type { Check, CheckStatus, FetchedPage, SiteMetadata } from "../src/audit/types.js";

function stub(id: string, status: CheckStatus): Check {
  return {
    id,
    name: id,
    category: "technical",
    weight: 1,
    severity: "warning",
    run: () => ({
      id,
      name: id,
      category: "technical",
      status,
      score: status === "pass" ? 100 : 0,
      maxScore: 100,
      weight: 1,
      message: `${id} ${status}`,
      severity: "warning",
    }),
  };
}

const page: FetchedPage = {
  url: "https://example.com",
  status: 200,
  html: "<html><head><title>t</title></head><body></body></html>",
  headers: {},
  responseTime: 1,
};
const metadata: SiteMetadata = { baseUrl: "https://example.com", wellKnown: {} };

function frontMatterFixBy(id: string): string {
  const text = readFileSync(resolve(GUIDES_DIR, `${id}.md`), "utf-8");
  return (text.match(/^fixBy:\s*(\S+)\s*$/m) as RegExpMatchArray)[1];
}

describe("guide attachment", () => {
  it("attaches guide and fixBy to mapped non-pass checks and their top issues only", async () => {
    const report = await runAudit(
      "https://example.com",
      { prefetchedPages: [page], prefetchedMetadata: metadata },
      undefined,
      [
        stub("sitemap-exists", "fail"),
        stub("schema-org-type", "partial"),
        stub("canonical-urls", "skip"),
        stub("markdown-alternate", "error"),
        stub("security-headers", "pass"),
        stub("some-unmapped-check", "fail"),
      ],
    );
    const byId = Object.fromEntries(
      report.categories.flatMap((c) => c.checks).map((c) => [c.id, c]),
    );

    expect(byId["sitemap-exists"]).toMatchObject({ guide: "sitemap", fixBy: "agent" });
    expect(byId["schema-org-type"]).toMatchObject({ guide: "schema-org", fixBy: "agent" });
    expect(byId["canonical-urls"]).toMatchObject({ guide: "canonical", fixBy: "agent" });
    expect(byId["markdown-alternate"]).toMatchObject({
      guide: "markdown-alternate",
      fixBy: "integrate",
    });
    expect(byId["security-headers"]).not.toHaveProperty("guide");
    expect(byId["security-headers"]).not.toHaveProperty("fixBy");
    expect(byId["some-unmapped-check"]).not.toHaveProperty("guide");
    expect(byId["some-unmapped-check"]).not.toHaveProperty("fixBy");

    const issues = Object.fromEntries(report.topIssues.map((i) => [i.checkId, i]));
    expect(issues["sitemap-exists"]).toMatchObject({ guide: "sitemap", fixBy: "agent" });
    expect(issues["schema-org-type"]).toMatchObject({ guide: "schema-org", fixBy: "agent" });
    expect(issues["some-unmapped-check"]).not.toHaveProperty("guide");
  });

  it("copies fixBy from the guide front matter for every mapped check", async () => {
    const ids = Object.keys(CHECK_GUIDES);
    const report = await runAudit(
      "https://example.com",
      { prefetchedPages: [page], prefetchedMetadata: metadata },
      undefined,
      ids.map((id) => stub(id, "fail")),
    );
    const results = report.categories.flatMap((c) => c.checks);
    expect(results).toHaveLength(ids.length);
    for (const result of results) {
      expect(result.guide).toBe(CHECK_GUIDES[result.id]);
      expect(result.fixBy).toBe(frontMatterFixBy(CHECK_GUIDES[result.id]));
    }
    expect(new Set(results.map((r) => r.fixBy))).toEqual(new Set(["agent", "integrate"]));
  });
});

describe("guide map", () => {
  it("maps real checks to guides that list them", () => {
    const registry = new Set(allChecks.map((c) => c.id));
    for (const [checkId, guideId] of Object.entries(CHECK_GUIDES)) {
      expect(registry.has(checkId), checkId).toBe(true);
      expect(GUIDES.find((g) => g.id === guideId)?.checks, guideId).toContain(checkId);
    }
    for (const guide of GUIDES) {
      for (const checkId of guide.checks) expect(CHECK_GUIDES[checkId]).toBe(guide.id);
    }
  });
});

describe("generated guides module", () => {
  it("is current with the guide files", () => {
    const committed = readFileSync(OUTPUT, "utf-8");
    expect(committed).toBe(renderModule(loadGuides()));
    expect(GUIDES.map((g) => g.id)).toEqual(
      readdirSync(GUIDES_DIR)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => f.slice(0, -3)),
    );
  });
});
