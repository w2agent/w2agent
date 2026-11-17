import { describe, expect, it } from "vitest";
import { formToolSpec } from "../src/generate/form-tools.js";
import { htmlToMarkdown } from "../src/generate/html-to-markdown.js";
import { generateLlmsTxt } from "../src/generate/llms-txt.js";
import { findSearchAction } from "../src/generate/search-action.js";

const forms = (body: string) =>
  htmlToMarkdown(`<html><body><main>${body}</main></body></html>`, "https://example.com/").forms ??
  [];

describe("llms.txt headings from crawled text (D)", () => {
  it("escapes link and HTML syntax in the H1", () => {
    const out = generateLlmsTxt([], {
      siteName: 'Acme [Login](https://evil.example/) <img src=x onerror="1">',
      siteDescription: "",
    });
    const h1 = out.split("\n")[0];
    expect(h1).not.toMatch(/(^|[^\\])\[/);
    expect(h1).not.toMatch(/(^|[^\\])</);
  });

  it("escapes a section name taken from a crawled path segment", () => {
    const out = generateLlmsTxt(
      [
        {
          url: "https://example.com/[go](https:%2F%2Fevil.example)/p",
          title: "P",
          description: "",
          markdown: "body",
        },
      ],
      { siteName: "Acme", siteDescription: "" },
    );
    const h2 = out.split("\n").find((l) => l.startsWith("## ")) ?? "";
    expect(h2).toContain("\\[go\\]");
    expect(h2).not.toMatch(/(^|[^\\])\[/);
  });
});

describe("SearchAction target nesting (E)", () => {
  it("a target nested far deeper than the walk limit yields null instead of throwing", () => {
    let deep: unknown = "https://example.com/s?q={search_term_string}";
    for (let i = 0; i < 20000; i++) deep = [deep];
    const jsonLd = [
      { "@type": "SearchAction", target: deep, "query-input": "name=search_term_string" },
    ];
    expect(findSearchAction(jsonLd, "https://example.com", undefined)).toBeNull();
  });

  it("a shallow array target still works", () => {
    const jsonLd = [
      {
        "@type": "SearchAction",
        target: [["https://example.com/s?q={search_term_string}"]],
        "query-input": "name=search_term_string",
      },
    ];
    expect(findSearchAction(jsonLd, "https://example.com", undefined)?.template).toContain("/s?q=");
  });
});

describe("required file control with a repeated or missing name (F)", () => {
  it.each([
    ["repeated name", `<input name="x"><input name="x" type="file" required>`],
    ["no name", `<input name="x"><input type="file" required>`],
  ])("%s still disqualifies the form", (_label, inner) => {
    const extracted = forms(`<form action="/u" method="post">${inner}</form>`);
    for (const f of extracted) expect(formToolSpec(f)).toBeNull();
  });

  it("an optional file control does not", () => {
    const extracted = forms(
      `<form action="/u" method="post"><input name="x"><input name="x" type="file"></form>`,
    );
    expect(extracted).toHaveLength(1);
    expect(formToolSpec(extracted[0])).not.toBeNull();
  });
});
