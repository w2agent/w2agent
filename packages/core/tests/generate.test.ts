import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { htmlToMarkdown } from "../src/generate/html-to-markdown.js";
import { generateLlmsTxt, extractSiteInfo } from "../src/generate/llms-txt.js";
import { generateLlmsFullTxt } from "../src/generate/llms-full-txt.js";
import type { PageMarkdown } from "../src/generate/types.js";

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, "fixtures", name), "utf-8");
}

// --- HTML → Markdown ---

describe("htmlToMarkdown", () => {
  it("extracts main content from a basic page", () => {
    const html = loadFixture("basic-page.html");
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.title).toBe("Test Page - Basic");
    expect(result.description).toBe("A basic test page for w2agent audit checks");
    expect(result.url).toBe("https://example.com");
    expect(result.markdown).toContain("Welcome to the Test Page");
    expect(result.markdown).toContain("Section One");
    expect(result.markdown).toContain("Section Two");
  });

  it("preserves headings as markdown", () => {
    const html = loadFixture("basic-page.html");
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.markdown).toMatch(/^# Welcome to the Test Page$/m);
    expect(result.markdown).toMatch(/^## Section One$/m);
    expect(result.markdown).toMatch(/^## Section Two$/m);
  });

  it("preserves lists", () => {
    const html = loadFixture("basic-page.html");
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.markdown).toContain("- Unit testing");
    expect(result.markdown).toContain("- Integration testing");
    expect(result.markdown).toContain("- End-to-end testing");
  });

  it("preserves tables", () => {
    const html = loadFixture("basic-page.html");
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.markdown).toContain("| Type | Speed |");
    expect(result.markdown).toContain("| --- | --- |");
    expect(result.markdown).toContain("| Unit | Fast |");
  });

  it("strips nav, footer, sidebar boilerplate", () => {
    const html = loadFixture("page-with-boilerplate.html");
    const result = htmlToMarkdown(html, "https://example.com/docs/getting-started");

    // Should have main content
    expect(result.markdown).toContain("Getting Started");
    expect(result.markdown).toContain("Installation");
    expect(result.markdown).toContain("npm install our-package");

    // Should NOT have nav/footer content
    expect(result.markdown).not.toContain("Privacy");
    expect(result.markdown).not.toContain("All rights reserved");
  });

  it("preserves code blocks with language hints", () => {
    const html = loadFixture("page-with-boilerplate.html");
    const result = htmlToMarkdown(html, "https://example.com/docs/getting-started");

    expect(result.markdown).toContain("```bash");
    expect(result.markdown).toContain("npm install our-package");
    expect(result.markdown).toContain("```js");
  });

  it("handles minimal HTML gracefully", () => {
    const result = htmlToMarkdown(
      "<html><body><p>Hello world</p></body></html>",
      "https://example.com",
    );
    expect(result.markdown).toContain("Hello world");
    expect(result.title).toBe("");
  });

  it("extracts links as markdown links", () => {
    const html = '<html><body><main><p>See <a href="/docs">the docs</a> for more.</p></main></body></html>';
    const result = htmlToMarkdown(html, "https://example.com");
    expect(result.markdown).toContain("[the docs](/docs)");
  });
});

// --- llms.txt generation ---

describe("generateLlmsTxt", () => {
  const pages: PageMarkdown[] = [
    { url: "https://example.com/", title: "Example Site", description: "A great site", markdown: "Welcome to Example." },
    { url: "https://example.com/docs/getting-started", title: "Getting Started", description: "How to get started", markdown: "First steps." },
    { url: "https://example.com/docs/api", title: "API Reference", description: "Complete API docs", markdown: "API details." },
    { url: "https://example.com/blog/hello-world", title: "Hello World", description: "Our first post", markdown: "Hello!" },
    { url: "https://example.com/about", title: "About Us", description: "", markdown: "We are Example." },
  ];

  it("follows the llmstxt.org spec format", () => {
    const result = generateLlmsTxt(pages, {
      siteName: "Example Site",
      siteDescription: "A great site for examples",
    });

    expect(result).toMatch(/^# Example Site\n/);
    expect(result).toContain("> A great site for examples");
    expect(result).toContain("## Docs");
    expect(result).toContain("## Blog");
    expect(result).toContain("- [Getting Started](https://example.com/docs/getting-started): How to get started");
    expect(result).toContain("- [API Reference](https://example.com/docs/api): Complete API docs");
    expect(result).toContain("- [Hello World](https://example.com/blog/hello-world): Our first post");
  });

  it("groups pages by URL path segments", () => {
    const result = generateLlmsTxt(pages, {
      siteName: "Example",
      siteDescription: "",
    });

    // Docs should come before Blog (priority ordering)
    const docsIdx = result.indexOf("## Docs");
    const blogIdx = result.indexOf("## Blog");
    expect(docsIdx).toBeLessThan(blogIdx);
  });

  it("filters by sections when specified", () => {
    const result = generateLlmsTxt(pages, {
      siteName: "Example",
      siteDescription: "",
      sections: ["docs"],
    });

    expect(result).toContain("## Docs");
    expect(result).not.toContain("## Blog");
    expect(result).not.toContain("Hello World");
  });

  it("handles pages with no description", () => {
    const result = generateLlmsTxt(pages, {
      siteName: "Example",
      siteDescription: "",
    });

    // "About Us" has no description — should use first sentence from markdown
    expect(result).toContain("[About Us]");
  });
});

describe("extractSiteInfo", () => {
  it("extracts site name from homepage title", () => {
    const pages: PageMarkdown[] = [
      { url: "https://example.com/", title: "My Cool Site", description: "The best site", markdown: "Welcome." },
    ];

    const info = extractSiteInfo(pages, "https://example.com");
    expect(info.siteName).toBe("My Cool Site");
    expect(info.siteDescription).toBe("The best site");
  });

  it("falls back to hostname when no homepage", () => {
    const pages: PageMarkdown[] = [
      { url: "https://example.com/about", title: "About", description: "", markdown: "About us." },
    ];

    const info = extractSiteInfo(pages, "https://example.com");
    expect(info.siteName).toBe("example.com");
  });
});

// --- llms-full.txt generation ---

describe("generateLlmsFullTxt", () => {
  it("concatenates pages with frontmatter separators", () => {
    const pages: PageMarkdown[] = [
      { url: "https://example.com/", title: "Home", description: "", markdown: "Welcome home." },
      { url: "https://example.com/about", title: "About", description: "", markdown: "About us." },
    ];

    const result = generateLlmsFullTxt(pages);

    expect(result).toContain("---\nurl: https://example.com/\ntitle: Home\n---");
    expect(result).toContain("Welcome home.");
    expect(result).toContain("---\nurl: https://example.com/about\ntitle: About\n---");
    expect(result).toContain("About us.");
  });

  it("preserves markdown content in each section", () => {
    const pages: PageMarkdown[] = [
      { url: "https://example.com/docs", title: "Docs", description: "", markdown: "# Documentation\n\n- Item 1\n- Item 2" },
    ];

    const result = generateLlmsFullTxt(pages);
    expect(result).toContain("# Documentation");
    expect(result).toContain("- Item 1");
    expect(result).toContain("- Item 2");
  });
});
