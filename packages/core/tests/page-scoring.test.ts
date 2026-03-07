import { describe, expect, it } from "vitest";
import { scoreUrl, sortUrlsByScore } from "../src/shared/page-scoring.js";

describe("scoreUrl", () => {
  it("scores homepage highest", () => {
    expect(scoreUrl("https://example.com/")).toBeGreaterThanOrEqual(20);
  });

  it("scores pricing pages high", () => {
    expect(scoreUrl("https://example.com/pricing")).toBeGreaterThan(
      scoreUrl("https://example.com/blog/some-post"),
    );
  });

  it("scores docs higher than blog", () => {
    expect(scoreUrl("https://example.com/docs/getting-started")).toBeGreaterThan(
      scoreUrl("https://example.com/blog/2024/some-post"),
    );
  });

  it("scores shallow pages higher than deep pages", () => {
    expect(scoreUrl("https://example.com/about")).toBeGreaterThan(
      scoreUrl("https://example.com/blog/2024/01/some-post"),
    );
  });

  it("scores legal pages low", () => {
    expect(scoreUrl("https://example.com/privacy")).toBeLessThan(
      scoreUrl("https://example.com/features"),
    );
  });

  it("scores pagination pages lowest", () => {
    const paginationScore = scoreUrl("https://example.com/blog/page/3");
    expect(paginationScore).toBeLessThanOrEqual(3);
  });

  it("gives unknown paths a default score", () => {
    const score = scoreUrl("https://example.com/random-page");
    expect(score).toBeGreaterThan(0);
  });

  it("handles invalid URLs", () => {
    expect(scoreUrl("not-a-url")).toBe(0);
  });
});

describe("sortUrlsByScore", () => {
  it("sorts homepage first", () => {
    const urls = [
      "https://example.com/blog/old-post",
      "https://example.com/privacy",
      "https://example.com/",
      "https://example.com/docs/intro",
    ];
    const sorted = sortUrlsByScore(urls);
    expect(sorted[0]).toBe("https://example.com/");
  });

  it("sorts high-value pages before low-value pages", () => {
    const urls = [
      "https://example.com/tag/javascript",
      "https://example.com/pricing",
      "https://example.com/blog/page/5",
      "https://example.com/docs/api",
      "https://example.com/terms",
    ];
    const sorted = sortUrlsByScore(urls);
    // pricing and docs should be near top, terms and tag near bottom
    const pricingIdx = sorted.indexOf("https://example.com/pricing");
    const termsIdx = sorted.indexOf("https://example.com/terms");
    expect(pricingIdx).toBeLessThan(termsIdx);
  });

  it("does not mutate original array", () => {
    const urls = ["https://example.com/z", "https://example.com/a"];
    const original = [...urls];
    sortUrlsByScore(urls);
    expect(urls).toEqual(original);
  });

  it("handles empty array", () => {
    expect(sortUrlsByScore([])).toEqual([]);
  });
});
