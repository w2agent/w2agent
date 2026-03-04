import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";
import {
  schemaOrgPresent,
  ogMetaTags,
  headingHierarchy,
  semanticHtml,
} from "../../src/audit/checks/structured-data.js";

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, "../fixtures", name), "utf-8");
}

function makePage(html: string, url = "https://example.com"): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}

describe("schema-org-present", () => {
  it("passes when JSON-LD is present", () => {
    const html = loadFixture("with-schema.html");
    const result = schemaOrgPresent.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when no JSON-LD", () => {
    const html = "<html><body><h1>No schema</h1></body></html>";
    const result = schemaOrgPresent.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("og-meta-tags", () => {
  it("passes when OG tags present", () => {
    const html = loadFixture("basic-page.html");
    const result = ogMetaTags.run([makePage(html)], baseMeta);
    expect(result.score).toBe(100);
  });

  it("fails with no OG tags", () => {
    const result = ogMetaTags.run(
      [makePage("<html><head></head><body>test</body></html>")],
      baseMeta,
    );
    expect(result.score).toBe(0);
  });
});

describe("heading-hierarchy", () => {
  it("passes with proper hierarchy", () => {
    const html = loadFixture("basic-page.html");
    const result = headingHierarchy.run([makePage(html)], baseMeta);
    expect(result.score).toBe(100);
  });

  it("fails with skipped levels", () => {
    const html = "<html><body><h1>Title</h1><h4>Skipped</h4></body></html>";
    const result = headingHierarchy.run([makePage(html)], baseMeta);
    expect(result.score).toBe(0);
  });
});

describe("semantic-html", () => {
  it("scores well with semantic elements", () => {
    const html = loadFixture("with-schema.html");
    const result = semanticHtml.run([makePage(html)], baseMeta);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it("scores poorly without semantic elements", () => {
    const html = "<html><body><div>Just divs</div></body></html>";
    const result = semanticHtml.run([makePage(html)], baseMeta);
    expect(result.score).toBe(0);
  });
});
