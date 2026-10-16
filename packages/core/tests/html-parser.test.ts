import { describe, expect, it } from "vitest";
import { answerFirst } from "../src/audit/checks/content-quality.js";
import type { FetchedPage, SiteMetadata } from "../src/audit/types.js";
import { parseHTML } from "../src/shared/html-parser.js";

const meta: SiteMetadata = { baseUrl: "https://example.com", wellKnown: {} };
const page = (html: string): FetchedPage => ({
  url: "https://example.com",
  status: 200,
  html,
  headers: {},
  responseTime: 1,
});

const bigLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "Headline",
  description: "word ".repeat(400),
});
const answer = Array.from({ length: 40 }, (_, i) => `answer${i}`).join(" ");

describe("visible text excludes non-rendered content", () => {
  it("answer-first passes when JSON-LD is the first body child", () => {
    const html = `<html><head><meta name="description" content="d"></head><body><script type="application/ld+json">${bigLd}</script><p>${answer}</p></body></html>`;
    const parsed = parseHTML(html);
    expect(parsed.text.startsWith("answer0")).toBe(true);
    expect(answerFirst.run([page(html)], meta)).toMatchObject({ status: "pass", score: 100 });
  });

  it("answer-first does not pass and wordCount is ~0 with only an inline script", () => {
    const html = `<html><head><meta name="description" content="d"></head><body><script>var data = "${"lorem ipsum ".repeat(200)}";</script></body></html>`;
    const parsed = parseHTML(html);
    expect(parsed.wordCount).toBe(0);
    expect(parsed.textLength).toBe(0);
    expect(answerFirst.run([page(html)], meta).status).not.toBe("pass");
  });

  it("excludes style, noscript, template, and script text but keeps them in $", () => {
    const html = `<html><body><style>.x{color:red}</style><noscript>enable js please</noscript><template><p>tmpl text</p></template><script>var s="jsword";</script><script type="application/ld+json">{"@type":"Product"}</script><p>visible</p></body></html>`;
    const parsed = parseHTML(html);
    expect(parsed.text).toBe("visible");
    expect(parsed.wordCount).toBe(1);
    expect(parsed.$("script").length).toBe(2);
    expect(parsed.$("style").length).toBe(1);
    expect(parsed.jsonLd).toEqual([{ "@type": "Product" }]);
  });

  it("does not derive FAQ indicators from script text", () => {
    const html = `<html><body><script>var q="a? b? c? d? frequently asked";</script><p>hello</p></body></html>`;
    expect(parseHTML(html).hasFaqContent).toBe(false);
  });
});

describe("noscriptWordCount", () => {
  it("counts words in noscript with markup stripped, excluded from wordCount", () => {
    const html = `<html><body><p>one two</p><noscript><article><p>alpha</p><p>beta</p><p>gamma</p></article><script>var z=1;</script></noscript></body></html>`;
    const parsed = parseHTML(html);
    expect(parsed.wordCount).toBe(2);
    expect(parsed.noscriptWordCount).toBe(3);
  });

  it("skips template content and decodes character references inside noscript", () => {
    const tmpl = `<html><body><noscript><template>${"word ".repeat(60)}</template></noscript></body></html>`;
    expect(parseHTML(tmpl).noscriptWordCount).toBe(0);
    const ents = `<html><body><noscript>${"word&#32;".repeat(60)}</noscript></body></html>`;
    expect(parseHTML(ents).noscriptWordCount).toBe(60);
  });
});
