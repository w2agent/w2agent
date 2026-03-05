import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { allChecks } from "../src/audit/checks/index.js";
import { clearChecks, getRegisteredChecks, registerChecks } from "../src/audit/engine.js";
import type { FetchedPage, SiteMetadata } from "../src/audit/types.js";

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
      expect(["pass", "fail", "partial", "skip"]).toContain(r.status);
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
  it("has checks for all 6 categories", () => {
    const categories = new Set(allChecks.map((c) => c.category));
    expect(categories.size).toBe(6);
    expect(categories).toContain("bot-accessibility");
    expect(categories).toContain("structured-data");
    expect(categories).toContain("content-quality");
    expect(categories).toContain("agent-discovery");
    expect(categories).toContain("agent-protocols");
    expect(categories).toContain("technical");
  });

  it("has at least 35 checks total", () => {
    expect(allChecks.length).toBeGreaterThanOrEqual(35);
  });

  it("all checks have unique IDs", () => {
    const ids = allChecks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
