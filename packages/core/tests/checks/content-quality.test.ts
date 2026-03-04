import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";
import {
  contentLength,
  listAndTableUsage,
  faqContent,
  freshnessSignals,
  authorAttribution,
} from "../../src/audit/checks/content-quality.js";

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, "../fixtures", name), "utf-8");
}

function makePage(html: string): FetchedPage {
  return { url: "https://example.com", status: 200, html, headers: {}, responseTime: 100 };
}

describe("content-length", () => {
  it("passes with 200+ words", () => {
    const html = loadFixture("basic-page.html");
    const result = contentLength.run([makePage(html)], baseMeta);
    expect(result.score).toBe(100);
  });

  it("fails with short content", () => {
    const result = contentLength.run([makePage("<html><body>Short</body></html>")], baseMeta);
    expect(result.score).toBe(0);
  });
});

describe("list-and-table-usage", () => {
  it("passes when lists/tables present", () => {
    const html = loadFixture("basic-page.html");
    const result = listAndTableUsage.run([makePage(html)], baseMeta);
    expect(result.score).toBe(100);
  });

  it("fails with no lists or tables", () => {
    const result = listAndTableUsage.run(
      [makePage("<html><body><p>Just paragraphs</p></body></html>")],
      baseMeta,
    );
    expect(result.score).toBe(0);
  });
});

describe("faq-content", () => {
  it("detects FAQ content", () => {
    const html = loadFixture("with-schema.html");
    const result = faqContent.run([makePage(html)], baseMeta);
    expect(result.score).toBeGreaterThan(0);
  });
});

describe("freshness-signals", () => {
  it("detects date signals", () => {
    const html = loadFixture("basic-page.html");
    const result = freshnessSignals.run([makePage(html)], baseMeta);
    expect(result.score).toBe(100);
  });

  it("fails without date signals", () => {
    const result = freshnessSignals.run(
      [makePage("<html><body><p>No dates</p></body></html>")],
      baseMeta,
    );
    expect(result.score).toBe(0);
  });
});

describe("author-attribution", () => {
  it("detects author", () => {
    const html = loadFixture("basic-page.html");
    const result = authorAttribution.run([makePage(html)], baseMeta);
    expect(result.score).toBe(100);
  });
});
