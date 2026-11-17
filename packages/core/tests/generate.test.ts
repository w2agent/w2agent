import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import robotsParser from "robots-parser";
import { describe, expect, it, vi } from "vitest";
import "../src/adapters/index.js";
import { aiAgentAccess } from "../src/audit/checks/bot-accessibility.js";
import { wellKnownAgentCard } from "../src/audit/checks/discovery.js";
import { validateAgentCard } from "../src/audit/shared/agent-card.js";
import { BOT_TOKENS } from "../src/audit/shared/bot-tokens.js";
import type { FetchedPage } from "../src/audit/types.js";
import { generateAgentCard } from "../src/generate/agent-card.js";
import { generateAgentsMd } from "../src/generate/agents-md.js";
import { runGenerate } from "../src/generate/engine.js";
import { generateFaq } from "../src/generate/faq.js";
import { htmlToMarkdown } from "../src/generate/html-to-markdown.js";
import { generateLlmsFullTxt } from "../src/generate/llms-full-txt.js";
import { extractSiteInfo, generateLlmsTxt } from "../src/generate/llms-txt.js";
import { generateRobotsTxt } from "../src/generate/robots-txt.js";
import { generateSchemaOrg } from "../src/generate/schema-org.js";
import { generateSkillMd } from "../src/generate/skill-md.js";
import { generateOpenClawSkillMd } from "../src/generate/skill-md-openclaw.js";
import type { GenerateContext, PageMarkdown } from "../src/generate/types.js";
import { parseHTML } from "../src/shared/html-parser.js";

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
    const html =
      '<html><body><main><p>See <a href="/docs">the docs</a> for more.</p></main></body></html>';
    const result = htmlToMarkdown(html, "https://example.com");
    expect(result.markdown).toContain("[the docs](/docs)");
  });

  it("extracts forms with fields and validation attributes", () => {
    const html = `<html><body>
      <form action="/search" method="GET">
        <label for="q">Search</label>
        <input id="q" name="q" type="text" required maxlength="100" />
      </form>
    </body></html>`;
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.forms).toBeDefined();
    expect(result.forms).toHaveLength(1);
    expect(result.forms?.[0].action).toBe("/search");
    expect(result.forms?.[0].method).toBe("GET");
    expect(result.forms?.[0].fields[0]).toEqual({
      name: "q",
      type: "text",
      required: true,
      label: "Search",
      maxlength: 100,
    });
  });

  it("extracts aria-label when no <label> element exists", () => {
    const html = `<html><body>
      <form action="/api/subscribe" method="POST">
        <input name="email" type="email" aria-label="Email address" required />
      </form>
    </body></html>`;
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.forms).toHaveLength(1);
    expect(result.forms?.[0].fields[0].label).toBe("Email address");
  });

  it("extracts pattern, min, max validation attributes", () => {
    const html = `<html><body>
      <form action="/register" method="POST">
        <input name="age" type="number" min="18" max="120" />
        <input name="zip" type="text" pattern="[0-9]{5}" />
      </form>
    </body></html>`;
    const result = htmlToMarkdown(html, "https://example.com");

    const fields = result.forms?.[0].fields;
    expect(fields[0]).toMatchObject({ name: "age", min: "18", max: "120" });
    expect(fields[1]).toMatchObject({ name: "zip", pattern: "[0-9]{5}" });
  });

  it("extracts select options", () => {
    const html = `<html><body>
      <form action="/filter" method="GET">
        <select name="category">
          <option value="books">Books</option>
          <option value="movies">Movies</option>
        </select>
      </form>
    </body></html>`;
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.forms?.[0].fields[0].options).toEqual(["books", "movies"]);
  });

  it("skips forms without action attribute", () => {
    const html = `<html><body>
      <form>
        <input name="q" type="text" />
      </form>
    </body></html>`;
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.forms).toBeUndefined();
  });

  it("skips hidden and submit inputs", () => {
    const html = `<html><body>
      <form action="/submit" method="POST">
        <input name="csrf" type="hidden" value="abc" />
        <input name="email" type="email" required />
        <input type="submit" value="Send" />
      </form>
    </body></html>`;
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.forms?.[0].fields).toHaveLength(1);
    expect(result.forms?.[0].fields[0].name).toBe("email");
  });

  it("returns undefined forms when page has no forms", () => {
    const html = "<html><body><p>No forms here</p></body></html>";
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.forms).toBeUndefined();
  });

  it("extracts forms from header/footer (not just main content)", () => {
    const html = `<html><body>
      <header>
        <form action="/search" method="GET">
          <input name="q" type="search" aria-label="Search" />
        </form>
      </header>
      <main><p>Main content here with enough text to be selected as main.</p></main>
      <footer>
        <form action="/subscribe" method="POST">
          <input name="email" type="email" aria-label="Newsletter email" />
        </form>
      </footer>
    </body></html>`;
    const result = htmlToMarkdown(html, "https://example.com");

    expect(result.forms).toHaveLength(2);
    expect(result.forms?.[0].action).toBe("/search");
    expect(result.forms?.[1].action).toBe("/subscribe");
  });
});

// --- llms.txt generation ---

describe("generateLlmsTxt", () => {
  const pages: PageMarkdown[] = [
    {
      url: "https://example.com/",
      title: "Example Site",
      description: "A great site",
      markdown: "Welcome to Example.",
    },
    {
      url: "https://example.com/docs/getting-started",
      title: "Getting Started",
      description: "How to get started",
      markdown: "First steps.",
    },
    {
      url: "https://example.com/docs/api",
      title: "API Reference",
      description: "Complete API docs",
      markdown: "API details.",
    },
    {
      url: "https://example.com/blog/hello-world",
      title: "Hello World",
      description: "Our first post",
      markdown: "Hello!",
    },
    {
      url: "https://example.com/about",
      title: "About Us",
      description: "",
      markdown: "We are Example.",
    },
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
    expect(result).toContain(
      "- [Getting Started](https://example.com/docs/getting-started): How to get started",
    );
    expect(result).toContain("- [API Reference](https://example.com/docs/api): Complete API docs");
    expect(result).toContain(
      "- [Hello World](https://example.com/blog/hello-world): Our first post",
    );
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
      {
        url: "https://example.com/",
        title: "My Cool Site",
        description: "The best site",
        markdown: "Welcome.",
      },
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

    expect(result).toContain('---\nurl: "https://example.com/"\ntitle: "Home"\n---');
    expect(result).toContain("Welcome home.");
    expect(result).toContain('---\nurl: "https://example.com/about"\ntitle: "About"\n---');
    expect(result).toContain("About us.");
  });

  it("preserves markdown content in each section", () => {
    const pages: PageMarkdown[] = [
      {
        url: "https://example.com/docs",
        title: "Docs",
        description: "",
        markdown: "# Documentation\n\n- Item 1\n- Item 2",
      },
    ];

    const result = generateLlmsFullTxt(pages);
    expect(result).toContain("# Documentation");
    expect(result).toContain("- Item 1");
    expect(result).toContain("- Item 2");
  });
});

// --- Helper for building GenerateContext in tests ---

function makeCtx(overrides: Partial<GenerateContext> = {}): GenerateContext {
  return {
    pages: overrides.pages ?? [],
    rawPages: overrides.rawPages ?? [],
    metadata: overrides.metadata ?? {
      baseUrl: "https://example.com",
      wellKnown: {},
    },
    baseUrl: overrides.baseUrl ?? "https://example.com",
  };
}

function makeFetchedPage(url: string, html: string): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}

// --- robots-txt generation ---

describe("generateRobotsTxt", () => {
  const withRobots = (robotsTxt: string, sitemapXml?: string) =>
    generateRobotsTxt(
      makeCtx({
        metadata: { baseUrl: "https://example.com", robotsTxt, sitemapXml, wellKnown: {} },
      }),
    );
  const SITEMAP =
    '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>';
  const LLMS = "# llms.txt: https://example.com/llms.txt\n";
  const SM = "Sitemap: https://example.com/sitemap.xml\n";
  const TAIL = `\n${SM}${LLMS}`;
  const blockedFor = (robotsTxt: string, token: string, path = "/") =>
    robotsParser("https://example.com/robots.txt", robotsTxt).isAllowed(
      `https://example.com${path}`,
      token,
    ) === false;
  const accessOf = (robotsTxt: string) =>
    aiAgentAccess.run([], { baseUrl: "https://example.com", robotsTxt, wellKnown: {} });
  const delayOf = (robotsTxt: string, token: string) =>
    robotsParser("https://example.com/robots.txt", robotsTxt).getCrawlDelay(token);
  const aiUserSearch = BOT_TOKENS.filter((b) => b.robotsToken && b.purpose !== "training");

  it("generates a plain allow-all robots.txt with no per-token groups and no sitemap when none was found", () => {
    const result = generateRobotsTxt(makeCtx());
    expect(result).toBe(`User-agent: *\nAllow: /\n\n${LLMS}`);
  });

  it("no robots.txt: asserts the Sitemap only when a sitemap was found", () => {
    const meta = (sitemapXml?: string) =>
      makeCtx({ metadata: { baseUrl: "https://example.com", sitemapXml, wellKnown: {} } });
    expect(generateRobotsTxt(meta(SITEMAP))).toBe(`User-agent: *\nAllow: /\n\n${SM}${LLMS}`);
    expect(generateRobotsTxt(meta("<html>soft 404</html>"))).not.toContain("Sitemap:");
    expect(generateRobotsTxt(meta(undefined))).not.toContain("Sitemap:");
  });

  it("existing robots.txt: Sitemap added only when found and not already declared", () => {
    const existing = "User-agent: *\nDisallow: /private/\n";
    expect(withRobots(existing)).not.toContain("Sitemap:");
    expect(withRobots(existing, "<html>soft 404</html>")).not.toContain("Sitemap:");
    expect(withRobots(existing, SITEMAP)).toContain(SM);
    const declared = `${existing}Sitemap: https://example.com/other.xml\n`;
    const result = withRobots(declared, SITEMAP);
    expect(result).not.toContain("sitemap.xml");
    expect(result.match(/^Sitemap:/gm)).toHaveLength(1);
  });

  it("wildcard block: appends one group for user/search tokens that keeps the site's * path rules", () => {
    const existing = `User-agent: *\nDisallow: /*\nDisallow: /private/\n${TAIL}`;
    const result = withRobots(existing);

    expect(accessOf(existing).status).toBe("fail");
    expect(accessOf(result)).toMatchObject({ status: "pass", score: 100 });
    expect(result.startsWith(existing.trimEnd())).toBe(true);
    expect(result.match(/^Allow: \/$/gm)).toHaveLength(1);
    for (const bot of aiUserSearch) {
      expect(result).toContain(`User-agent: ${bot.token}\n`);
      expect(blockedFor(result, bot.token, "/"), bot.token).toBe(false);
      expect(blockedFor(result, bot.token, "/private/x"), bot.token).toBe(true);
    }
  });

  it("wildcard block only: training tokens and unknown bots stay blocked, * Crawl-delay is kept", () => {
    const existing = "User-agent: *\nCrawl-delay: 30\nDisallow: /\nDisallow: /private/\n";
    const result = withRobots(existing);
    for (const bot of aiUserSearch) {
      expect(blockedFor(result, bot.token), bot.token).toBe(false);
      expect(blockedFor(result, bot.token, "/private/x"), bot.token).toBe(true);
      expect(delayOf(result, bot.token), bot.token).toBe(30);
    }
    for (const bot of BOT_TOKENS.filter((b) => b.purpose === "training")) {
      expect(result).not.toContain(`User-agent: ${bot.token}`);
      expect(blockedFor(result, bot.token), bot.token).toBe(true);
    }
    expect(blockedFor(result, "SomeOtherBot")).toBe(true);
    for (const stale of ["Claude-Web", "anthropic-ai", "cohere-ai", "Bytespider", "Google-Agent"]) {
      expect(result).not.toContain(`User-agent: ${stale}`);
    }
  });

  it("appends no group when nothing user/search is blocked, even with * path rules", () => {
    const existing = `User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /\n${TAIL}`;
    expect(withRobots(existing)).toBe(existing);
  });

  it("owner blocks GPTBot by name + wildcard block: GPTBot stays blocked, user tokens allowed, unknown bots blocked", () => {
    const existing = `User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /\n${TAIL}`;
    const result = withRobots(existing);
    expect(result.startsWith(existing.trimEnd())).toBe(true);
    expect(blockedFor(result, "GPTBot")).toBe(true);
    expect(blockedFor(result, "ChatGPT-User")).toBe(false);
    expect(blockedFor(result, "Claude-User")).toBe(false);
    expect(blockedFor(result, "SomeOtherBot")).toBe(true);
  });

  const namedCases: Array<[string, string]> = [
    ["alone", "User-agent: ChatGPT-User\nDisallow: /\n\nUser-agent: *\nDisallow: /\n"],
    ["named after *", "User-agent: *\nDisallow: /\n\nUser-agent: ChatGPT-User\nDisallow: /\n"],
    ["in a shared * group", "User-agent: *\nUser-agent: ChatGPT-User\nDisallow: /\n"],
    ["versioned", "User-agent: *\nDisallow: /\n\nUser-agent: ChatGPT-User/1.0\nDisallow: /\n"],
    [
      "with a narrower rule",
      "User-agent: *\nDisallow: /\n\nUser-agent: ChatGPT-User\nDisallow: /*\n",
    ],
  ];
  it.each(
    namedCases,
  )("owner blocks ChatGPT-User by name (%s): it stays blocked, Claude-User gets Allow", (_n, existing) => {
    const result = withRobots(existing, SITEMAP);
    expect(result.startsWith(existing.trimEnd())).toBe(true);
    expect(blockedFor(result, "ChatGPT-User")).toBe(true);
    expect(blockedFor(result, "Claude-User")).toBe(false);
    expect(blockedFor(result, "SomeOtherBot")).toBe(true);
    expect(result).not.toContain("Moved out");
    expect(result.match(/User-agent: ChatGPT-User/g)).toHaveLength(1);
  });

  it("a named group with an empty rule set still counts as naming the token", () => {
    const existing =
      "User-agent: ChatGPT-User\nSitemap: https://example.com/s.xml\n\nUser-agent: *\nDisallow: /\n";
    const result = withRobots(existing);
    expect(result.match(/User-agent: ChatGPT-User/g)).toHaveLength(1);
    expect(blockedFor(result, "Claude-User")).toBe(false);
  });

  it("never rewrites or removes an owner line", () => {
    const existing = `User-agent: GPTBot\nUser-agent: ChatGPT-User\nDisallow: /*\nDisallow: /private/\n\nUser-agent: *\nDisallow: /\n${TAIL}`;
    const result = withRobots(existing);
    expect(result.startsWith(existing.trimEnd())).toBe(true);
    expect(blockedFor(result, "ChatGPT-User")).toBe(true);
    expect(blockedFor(result, "GPTBot")).toBe(true);
    expect(blockedFor(result, "Claude-User")).toBe(false);
  });

  it("keeps the * Crawl-delay for added tokens and groups them by identical rules", () => {
    const existing = `User-agent: *\nCrawl-delay: 5\nDisallow: /*\nDisallow: /tmp/\n\nUser-agent: ChatGPT-User\nCrawl-delay: 30\nDisallow: /\n${TAIL}`;
    const result = withRobots(existing);
    expect(delayOf(result, "ChatGPT-User")).toBe(30);
    expect(delayOf(result, "Claude-User")).toBe(5);
    expect(blockedFor(result, "Claude-User")).toBe(false);
    expect(blockedFor(result, "Claude-User", "/tmp/a")).toBe(true);
  });

  it("keeps CRLF line endings and the owner's text", () => {
    const existing = "User-agent: *\r\nDisallow: /private/\r\nDisallow: /\r\n";
    const result = withRobots(existing);
    expect(result.replace(/\r\n/g, "")).not.toContain("\n");
    expect(result.startsWith(existing)).toBe(true);
    expect(blockedFor(result, "ChatGPT-User")).toBe(false);
    expect(accessOf(result)).toMatchObject({ status: "pass", score: 100 });
  });

  it("matches groups by exact token, so an Applebot-Extended group does not cover Applebot", () => {
    const existing = `User-agent: *\nDisallow: /\n\nUser-agent: Applebot-Extended\nAllow: /\n${TAIL}`;
    const result = withRobots(existing);
    expect(result).toContain("User-agent: Applebot\n");
    expect(result.match(/User-agent: Applebot-Extended/g)).toHaveLength(1);
    expect(blockedFor(result, "Applebot")).toBe(false);
  });

  it("an input ending in a User-agent line with no rules gets no Allow group, so the agent stays blocked", () => {
    const tails = ["\n", "\n# end\n\n", "\n\n\n"];
    for (const agent of ["ChatGPT-User", "GPTBot"]) {
      for (const tail of tails) {
        const existing = `User-agent: *\nDisallow: /\n\nUser-agent: ${agent}${tail}`;
        const result = withRobots(existing, SITEMAP);
        expect(blockedFor(existing, agent)).toBe(true);
        expect(blockedFor(result, agent)).toBe(true);
        expect(result).not.toMatch(/^Allow: \/$/m);
        expect(result).not.toMatch(/^User-agent: Claude-User$/m);
      }
    }
  });

  it.each([
    ["* with Crawl-delay", "User-agent: *\nDisallow: /\n\nUser-agent: *\nCrawl-delay: 5\n"],
    [
      "* with Sitemap",
      "User-agent: *\nDisallow: /\n\nUser-agent: *\nSitemap: https://example.com/s.xml\n",
    ],
    [
      "GPTBot with Sitemap",
      "User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nSitemap: https://example.com/s.xml\n",
    ],
  ])("a trailing run closed only by Sitemap or Crawl-delay is open under Google, so nothing is added (%s)", (_n, existing) => {
    const result = withRobots(existing);
    expect(result.startsWith(existing.trimEnd())).toBe(true);
    expect(result).not.toMatch(/^User-agent: Claude-User$/m);
    expect(result).not.toMatch(/^Allow: \/$/m);
  });

  it("ignores an empty Crawl-delay and keeps the last non-empty one", () => {
    const existing = "User-agent: *\nDisallow: /\nCrawl-delay: 5\nCrawl-delay:\n";
    const result = withRobots(existing);
    const added = result.slice(existing.length);
    expect(added).toContain("Crawl-delay: 5\nAllow: /");
    expect(added).not.toMatch(/^Crawl-delay: *$/m);
  });

  describe("sitemap detection", () => {
    const meta = (sitemapXml: string) =>
      makeCtx({ metadata: { baseUrl: "https://example.com", sitemapXml, wellKnown: {} } });
    const has = (xml: string) => generateRobotsTxt(meta(xml)).includes("Sitemap:");

    it("accepts only a sitemap root element after BOM, whitespace, declaration and comments", () => {
      expect(has(SITEMAP)).toBe(true);
      expect(has('﻿\n<?xml version="1.0" encoding="UTF-8"?>\n<!-- gen --><urlset/>')).toBe(true);
      expect(has('<?xml version="1.0"?><sitemapindex xmlns="x"><sitemap/></sitemapindex>')).toBe(
        true,
      );
      expect(has("<urlset>")).toBe(true);
    });

    it("accepts a stylesheet instruction before the root and stays fast on hostile input", () => {
      expect(
        has('<?xml version="1.0"?><?xml-stylesheet href="s.xsl"?>\n<sitemapindex xmlns="x"/>'),
      ).toBe(true);
      for (const hostile of [`${"<!--a-->".repeat(40)}<html>`, `${"<?x?>".repeat(40)}<html>`]) {
        const start = Date.now();
        expect(has(hostile)).toBe(false);
        expect(Date.now() - start).toBeLessThan(500);
      }
      expect(has("<!--".repeat(20000))).toBe(false);
    });

    it("rejects soft-404 HTML that only mentions a sitemap tag", () => {
      expect(has("<html><!-- <urlset --></html>")).toBe(false);
      expect(has("<html><body><urlset></urlset></body></html>")).toBe(false);
      expect(has("<!doctype html><p>no <sitemapindex> here</p>")).toBe(false);
      expect(has("<urlsetfoo/>")).toBe(false);
      expect(has("")).toBe(false);
    });
  });
});

// --- schema-org generation ---

describe("generateSchemaOrg", () => {
  it("generates WebPage schema for basic pages", () => {
    const html =
      '<html><head><title>About</title><meta name="description" content="About us"></head><body><p>Content</p></body></html>';
    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/about", html)],
      pages: [
        {
          url: "https://example.com/about",
          title: "About",
          description: "About us",
          markdown: "Content",
        },
      ],
    });

    const result = generateSchemaOrg(ctx);
    expect(result).not.toBeNull();
    expect(result?.[0].jsonLd["@type"]).toBe("WebPage");
    expect(result?.[0].jsonLd.name).toBe("About");
    expect(result?.[0].jsonLd.url).toBe("https://example.com/about");
  });

  it("detects Article type from article:published_time", () => {
    const html = `<html><head><title>Blog Post</title>
      <meta property="article:published_time" content="2024-01-01">
      <meta property="article:modified_time" content="2024-06-01">
    </head><body><p>Blog content</p></body></html>`;
    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/blog/post", html)],
      pages: [
        {
          url: "https://example.com/blog/post",
          title: "Blog Post",
          description: "",
          markdown: "Blog content",
        },
      ],
    });

    const result = generateSchemaOrg(ctx);
    expect(result).not.toBeNull();
    expect(result?.[0].jsonLd["@type"]).toBe("Article");
    expect(result?.[0].jsonLd.datePublished).toBe("2024-01-01");
    expect(result?.[0].jsonLd.dateModified).toBe("2024-06-01");
  });

  it("skips pages that already have JSON-LD", () => {
    const html = `<html><head><title>Page</title>
      <script type="application/ld+json">{"@type":"Organization","name":"Test"}</script>
    </head><body><p>Content</p></body></html>`;
    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com", html)],
      pages: [{ url: "https://example.com", title: "Page", description: "", markdown: "Content" }],
    });

    const result = generateSchemaOrg(ctx);
    expect(result).toBeNull();
  });

  it("returns null when no pages need schema", () => {
    const ctx = makeCtx({ rawPages: [] });
    const result = generateSchemaOrg(ctx);
    expect(result).toBeNull();
  });
});

// --- agent-card generation ---

describe("generateAgentCard", () => {
  const A2A = "https://example.com/a2a/v1";
  const cardWithEndpoint = (ctx: GenerateContext) => {
    const card = generateAgentCard(ctx, { a2aEndpoint: A2A });
    if (!card) throw new Error("expected an agent card when an A2A endpoint is given");
    return card;
  };

  it("creates agent card with site info", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/",
          title: "My Site",
          description: "A great site",
          markdown: "Welcome",
        },
      ],
      rawPages: [],
    });

    const card = cardWithEndpoint(ctx);
    expect(card.name).toBe("My Site");
    expect(card.description).toBe("A great site");
    expect(card.version).toBe("1.0.0");
    expect(card.provider).toEqual({ organization: "My Site", url: "https://example.com" });
  });

  it("emits the A2A v1.0 shape, not the v0.3 url/preferredTransport fields or invented capability flags", () => {
    const card = cardWithEndpoint(
      makeCtx({
        pages: [{ url: "https://example.com/", title: "My Site", description: "D", markdown: "" }],
        rawPages: [],
      }),
    ) as unknown as Record<string, unknown>;
    expect(card).toMatchObject({
      supportedInterfaces: [{ url: A2A, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: {},
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
    });
    expect(card).not.toHaveProperty("url");
    expect(card).not.toHaveProperty("preferredTransport");
    expect(card.capabilities).toEqual({});
  });

  it("without an A2A endpoint no card is generated: a homepage-interface card is a stub the check can never pass", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "My Site", description: "D", markdown: "" }],
      rawPages: [],
    });
    expect(generateAgentCard(ctx)).toBeNull();
    expect(generateAgentCard(ctx, { a2aEndpoint: "" })).toBeNull();
  });

  it("with an A2A endpoint the card round-trips through the checker as a passing v1.0 card", () => {
    const html =
      '<html><head><script type="application/ld+json">{"@type":"WebSite","potentialAction":{"@type":"SearchAction"}}</script></head></html>';
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "My Site", description: "D", markdown: "" }],
      rawPages: [makeFetchedPage("https://example.com", html)],
      metadata: { baseUrl: "https://example.com", llmsTxt: "# My Site", wellKnown: {} },
    });
    const card = cardWithEndpoint(ctx);
    expect(card.supportedInterfaces[0].url).toBe("https://example.com/a2a/v1");
    expect(validateAgentCard(card, "https://example.com")).toEqual({
      shape: "v1.0",
      missing: [],
      stubUrls: [],
    });
    const result = wellKnownAgentCard.run([], {
      baseUrl: "https://example.com",
      wellKnown: { "agent-card.json": JSON.stringify(card) },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("detects llms.txt skill", () => {
    const ctx = makeCtx({
      pages: [
        { url: "https://example.com/", title: "My Site", description: "Desc", markdown: "Content" },
      ],
      rawPages: [],
      metadata: {
        baseUrl: "https://example.com",
        llmsTxt: "# My Site",
        wellKnown: {},
      },
    });

    const card = cardWithEndpoint(ctx);
    expect(card.skills.find((s) => s.id === "llms-txt")?.tags).toContain("llms-txt");
  });

  it("detects SearchAction and structured-data skills", () => {
    const html =
      '<html><head><script type="application/ld+json">{"@type":"WebSite","potentialAction":{"@type":"SearchAction"}}</script></head><body></body></html>';
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "My Site", description: "", markdown: "" }],
      rawPages: [makeFetchedPage("https://example.com", html)],
    });

    const card = cardWithEndpoint(ctx);
    expect(card.skills.map((s) => s.id)).toEqual(["search", "structured-data"]);
    for (const skill of card.skills) expect(skill.tags.length).toBeGreaterThan(0);
  });

  it("runGenerate passes options.a2aEndpoint into agent-card.json", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return url === "https://example.com/"
        ? new Response("<html><head><title>My Site</title></head><body><p>hi</p></body></html>", {
            headers: { "content-type": "text/html" },
          })
        : new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    });
    try {
      const result = await runGenerate("https://example.com/", {
        maxPages: 1,
        formats: ["agent-card"],
        a2aEndpoint: "https://example.com/a2a/v1",
      });
      const file = result.files.find((f) => f.filename === "agent-card.json");
      expect(JSON.parse(file?.content ?? "{}").supportedInterfaces[0].url).toBe(
        "https://example.com/a2a/v1",
      );

      const withoutEndpoint = await runGenerate("https://example.com/", {
        maxPages: 1,
        formats: ["agent-card"],
      });
      expect(withoutEndpoint.files.map((f) => f.filename)).not.toContain("agent-card.json");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("runGenerate platformFiles:false omits platform files but still reports detection", async () => {
    const nextHtml =
      '<html><head><title>My Site</title></head><body><p>hi</p><script id="__NEXT_DATA__" type="application/json">{}</script><script src="/_next/static/chunks/main.js"></script></body></html>';
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return url === "https://example.com/"
        ? new Response(nextHtml, { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    });
    try {
      const withPlatform = await runGenerate("https://example.com/", {
        maxPages: 1,
        formats: ["llms-txt"],
      });
      expect(withPlatform.platform?.platform).toBe("nextjs");
      expect(withPlatform.files.some((f) => f.filename.startsWith("nextjs/"))).toBe(true);

      const without = await runGenerate("https://example.com/", {
        maxPages: 1,
        formats: ["llms-txt"],
        platformFiles: false,
      });
      expect(without.platform?.platform).toBe("nextjs");
      expect(without.files.map((f) => f.filename)).toEqual(["llms.txt"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("runGenerate pagesFetched is 0 when nothing is reachable and counts empty-body pages", async () => {
    const emptyHtml = "<html><head><title>Catalog</title></head><body></body></html>";
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        throw new TypeError("fetch failed");
      });
      const dead = await runGenerate("https://example.com/", {
        maxPages: 1,
        formats: ["llms-txt"],
      });
      expect(dead.pagesFetched).toBe(0);
      expect(dead.pagesProcessed).toBe(0);
      vi.restoreAllMocks();

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        return url === "https://example.com/"
          ? new Response(emptyHtml, { headers: { "content-type": "text/html" } })
          : new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
      });
      const empty = await runGenerate("https://example.com/", {
        maxPages: 1,
        formats: ["schema-org"],
        platformFiles: false,
      });
      expect(empty.pagesProcessed).toBe(0);
      expect(empty.pagesFetched).toBe(1);
      expect(empty.files.map((f) => f.filename)).toContain("schema-org.json");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("provides fallback description when none exists", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "My Site", description: "", markdown: "" }],
      rawPages: [],
    });

    const card = cardWithEndpoint(ctx);
    expect(card.description).toContain("My Site");
  });
});

// --- FAQ extraction ---

describe("generateFaq", () => {
  it("extracts FAQ from dt/dd elements", () => {
    const html = loadFixture("faq-page.html");
    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", html)],
    });

    const result = generateFaq(ctx);
    expect(result).not.toBeNull();
    expect(result?.["@type"]).toBe("FAQPage");
    expect(result?.["@context"]).toBe("https://schema.org");

    const questions = result?.mainEntity.map((e) => e.name);
    expect(questions).toContain("What is Example Company?");
    expect(questions).toContain("How do I get started?");
    expect(questions).toContain("What pricing plans are available?");
  });

  it("extracts FAQ from headings ending with ?", () => {
    const html = `<html><head><title>FAQ</title></head><body>
      <h1>Frequently Asked Questions</h1>
      <h2>What is this?</h2>
      <p>This is a test product for testing purposes.</p>
      <h2>How does it work?</h2>
      <p>It works by processing your data and returning results.</p>
      <h2>Can I use it for free?</h2>
      <p>Yes you can use a free tier.</p>
    </body></html>`;

    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", html)],
    });

    const result = generateFaq(ctx);
    expect(result).not.toBeNull();

    const questions = result?.mainEntity.map((e) => e.name);
    expect(questions).toContain("What is this?");
    expect(questions).toContain("How does it work?");
  });

  it("extracts FAQ from details/summary elements", () => {
    const html = `<html><head><title>FAQ</title></head><body>
      <details><summary>What is the return policy?</summary><p>30-day money back guarantee.</p></details>
      <details><summary>Do you ship internationally?</summary><p>Yes, we ship worldwide.</p></details>
    </body></html>`;

    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", html)],
    });

    const result = generateFaq(ctx);
    expect(result).not.toBeNull();

    const questions = result?.mainEntity.map((e) => e.name);
    expect(questions).toContain("What is the return policy?");
    expect(questions).toContain("Do you ship internationally?");
  });

  it("extracts FAQ from existing FAQPage JSON-LD", () => {
    const html = `<html><head><title>Frequently Asked Questions</title>
      <script type="application/ld+json">{
        "@type": "FAQPage",
        "mainEntity": [
          {"@type": "Question", "name": "Is it free?", "acceptedAnswer": {"@type": "Answer", "text": "Yes, it is completely free to use."}}
        ]
      }</script>
    </head><body><p>Here are our frequently asked questions and answers.</p></body></html>`;

    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", html)],
    });

    const result = generateFaq(ctx);
    expect(result).not.toBeNull();
    expect(result?.mainEntity[0].name).toBe("Is it free?");
    expect(result?.mainEntity[0].acceptedAnswer.text).toBe("Yes, it is completely free to use.");
  });

  it("deduplicates questions by text", () => {
    const html = `<html><head><title>FAQ</title></head><body>
      <dl>
        <dt>What is this product?</dt><dd>Answer one: it is a comprehensive testing framework.</dd>
        <dt>What is this product?</dt><dd>Answer two: it is a comprehensive testing framework.</dd>
        <dt>How does it work exactly?</dt><dd>It processes your input and returns the computed result.</dd>
      </dl>
    </body></html>`;

    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", html)],
    });

    const result = generateFaq(ctx);
    expect(result).not.toBeNull();
    const questions = result?.mainEntity.map((e) => e.name);
    expect(questions.filter((q) => q === "What is this product?")).toHaveLength(1);
  });

  it("filters entries with question <= 10 chars", () => {
    const html = `<html><head><title>FAQ</title></head><body>
      <dl>
        <dt>Resources</dt><dd>Links to documentation, tutorials, and community support resources.</dd>
        <dt>What browsers are officially supported by this library?</dt><dd>All modern browsers including Chrome, Firefox, Safari, and Edge are supported.</dd>
      </dl>
    </body></html>`;

    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", html)],
    });

    const result = generateFaq(ctx);
    expect(result).not.toBeNull();
    const questions = result?.mainEntity.map((e) => e.name);
    expect(questions).not.toContain("Resources");
    expect(questions).toContain("What browsers are officially supported by this library?");
  });

  it("filters entries with answer <= 20 chars", () => {
    const html = `<html><head><title>FAQ</title></head><body>
      <dl>
        <dt>What is the license type?</dt><dd>MIT</dd>
        <dt>How do I install this package?</dt><dd>Run npm install to add this package to your project dependencies.</dd>
      </dl>
    </body></html>`;

    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", html)],
    });

    const result = generateFaq(ctx);
    expect(result).not.toBeNull();
    const questions = result?.mainEntity.map((e) => e.name);
    expect(questions).not.toContain("What is the license type?");
    expect(questions).toContain("How do I install this package?");
  });

  it("preserves entries where question > 10 and answer > 20 chars", () => {
    const html = `<html><head><title>FAQ</title></head><body>
      <dl>
        <dt>What is the pricing model?</dt><dd>We offer a free tier plus paid plans starting at ten dollars per month.</dd>
        <dt>Where can I find documentation?</dt><dd>Full documentation is available on our official website and GitHub repository.</dd>
      </dl>
    </body></html>`;

    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", html)],
    });

    const result = generateFaq(ctx);
    expect(result).not.toBeNull();
    expect(result?.mainEntity).toHaveLength(2);
    expect(result?.mainEntity[0].name).toBe("What is the pricing model?");
  });

  it("returns null when all entries fail quality threshold", () => {
    const html = `<html><head><title>FAQ</title></head><body>
      <dl>
        <dt>Price</dt><dd>Free</dd>
        <dt>Docs</dt><dd>See site</dd>
      </dl>
    </body></html>`;

    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", html)],
    });

    const result = generateFaq(ctx);
    expect(result).toBeNull();
  });

  it("returns null when no FAQ content found", () => {
    const html =
      "<html><head><title>Home</title></head><body><p>Just a regular page.</p></body></html>";
    const ctx = makeCtx({
      rawPages: [makeFetchedPage("https://example.com", html)],
    });

    const result = generateFaq(ctx);
    expect(result).toBeNull();
  });
});

// --- html-parser article:* meta tags ---

describe("parseHTML article meta tags", () => {
  it("captures article:published_time and article:modified_time", () => {
    const html = `<html><head>
      <meta property="og:title" content="My Post">
      <meta property="article:published_time" content="2024-01-15">
      <meta property="article:modified_time" content="2024-06-20">
    </head><body></body></html>`;

    const parsed = parseHTML(html);
    expect(parsed.ogTags["og:title"]).toBe("My Post");
    expect(parsed.ogTags["article:published_time"]).toBe("2024-01-15");
    expect(parsed.ogTags["article:modified_time"]).toBe("2024-06-20");
  });
});

// --- SKILL.md generation ---

describe("generateSkillMd", () => {
  const pages: PageMarkdown[] = [
    {
      url: "https://example.com/",
      title: "Example Site",
      description: "A great example site",
      markdown: "Welcome to Example.",
    },
    {
      url: "https://example.com/docs/getting-started",
      title: "Getting Started",
      description: "How to get started",
      markdown: "First steps.",
    },
    {
      url: "https://example.com/docs/api",
      title: "API Reference",
      description: "Complete API docs",
      markdown: "API details.",
    },
    {
      url: "https://example.com/about",
      title: "About Us",
      description: "",
      markdown: "We are Example.",
    },
  ];

  function makeSkillCtx(overrides: Partial<GenerateContext> = {}): GenerateContext {
    return {
      pages: overrides.pages ?? pages,
      rawPages: overrides.rawPages ?? [],
      metadata: overrides.metadata ?? {
        baseUrl: "https://example.com",
        wellKnown: {},
      },
      baseUrl: overrides.baseUrl ?? "https://example.com",
    };
  }

  it("has valid YAML frontmatter with name and description", () => {
    const ctx = makeSkillCtx();
    const result = generateSkillMd(ctx);

    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/\nname: example-com-agent\n/);
    expect(result).toMatch(/\ndescription: ".*Example Site.*"\n/);
    expect(result).toContain("---\n\n#");
  });

  it("derives slug from hostname including subdomains", () => {
    const ctx = makeSkillCtx({
      baseUrl: "https://docs.example.com",
      pages: [
        {
          url: "https://docs.example.com/",
          title: "Docs",
          description: "Docs site",
          markdown: "Welcome.",
        },
      ],
    });
    const result = generateSkillMd(ctx);

    expect(result).toContain("name: docs-example-com-agent");
  });

  it("includes page count in overview", () => {
    const ctx = makeSkillCtx();
    const result = generateSkillMd(ctx);

    expect(result).toContain("Pages indexed: 4");
  });

  it("includes MCP endpoint when provided", () => {
    const ctx = makeSkillCtx();
    const result = generateSkillMd(ctx, {
      mcpEndpoint: "https://w2agent.dev/api/mcp/example-com",
    });

    expect(result).toContain("https://w2agent.dev/api/mcp/example-com");
    expect(result).not.toContain("TODO");
  });

  it("uses localhost placeholder with TODO when no endpoint", () => {
    const ctx = makeSkillCtx();
    const result = generateSkillMd(ctx);

    expect(result).toContain("localhost:3100/mcp");
    expect(result).toContain("TODO");
  });

  it("lists all detected tools", () => {
    const ctx = makeSkillCtx();
    const result = generateSkillMd(ctx);

    expect(result).toContain("### `list-pages`");
    expect(result).toContain("### `get-page`");
    expect(result).toContain("### `search-site`");
  });

  it("lists key pages with links", () => {
    const ctx = makeSkillCtx();
    const result = generateSkillMd(ctx);

    expect(result).toContain("[Example Site](https://example.com/)");
    expect(result).toContain("[Getting Started](https://example.com/docs/getting-started)");
    expect(result).toContain("## Key Content Areas");
  });

  it("includes search-faq tool when FAQ content detected", () => {
    const faqHtml = `<html><head><title>FAQ</title></head><body>
      <h1>Frequently Asked Questions</h1>
      <h2>What is this?</h2>
      <p>This is a test product for testing purposes.</p>
      <h2>How does it work?</h2>
      <p>It works by processing your data and returning results.</p>
    </body></html>`;

    const ctx = makeSkillCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", faqHtml)],
    });
    const result = generateSkillMd(ctx);

    expect(result).toContain("### `search-faq`");
    expect(result).toContain("search-faq");
  });

  it("escapes double quotes in YAML description", () => {
    const ctx = makeSkillCtx({
      pages: [
        {
          url: "https://example.com/",
          title: 'Site "With Quotes"',
          description: 'A "great" site',
          markdown: "Welcome.",
        },
      ],
    });
    const result = generateSkillMd(ctx);

    // Should not have unescaped quotes inside the YAML value
    const descLine = result.split("\n").find((l) => l.startsWith("description:"));
    expect(descLine).toBeDefined();
    expect(descLine).not.toMatch(/description: ".*[^\\]".*[^\\]".*"/);
  });
});

// --- OpenClaw SKILL.md generation ---

describe("generateOpenClawSkillMd", () => {
  const pages: PageMarkdown[] = [
    {
      url: "https://example.com/",
      title: "Example Site",
      description: "A great example site",
      markdown: "Welcome to Example.",
    },
    {
      url: "https://example.com/docs/getting-started",
      title: "Getting Started",
      description: "How to get started",
      markdown: "First steps.",
    },
    {
      url: "https://example.com/docs/api",
      title: "API Reference",
      description: "Complete API docs",
      markdown: "API details.",
    },
    {
      url: "https://example.com/about",
      title: "About Us",
      description: "",
      markdown: "We are Example.",
    },
  ];

  function makeOpenClawCtx(overrides: Partial<GenerateContext> = {}): GenerateContext {
    return {
      pages: overrides.pages ?? pages,
      rawPages: overrides.rawPages ?? [],
      metadata: overrides.metadata ?? {
        baseUrl: "https://example.com",
        wellKnown: {},
      },
      baseUrl: overrides.baseUrl ?? "https://example.com",
    };
  }

  it("has YAML frontmatter with name, version, user-invocable, and homepage", () => {
    const ctx = makeOpenClawCtx();
    const result = generateOpenClawSkillMd(ctx);

    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/\nname: example-com-agent\n/);
    expect(result).toMatch(/\nversion: 1\.0\.0\n/);
    expect(result).toMatch(/\nuser-invocable: true\n/);
    expect(result).toMatch(/\nhomepage: https:\/\/example\.com\n/);
    expect(result).toContain("---\n\n#");
  });

  it("name is lowercase kebab-case with no dots", () => {
    const ctx = makeOpenClawCtx({
      baseUrl: "https://docs.example.com",
      pages: [
        { url: "https://docs.example.com/", title: "Docs", description: "", markdown: "Welcome." },
      ],
    });
    const result = generateOpenClawSkillMd(ctx);

    expect(result).toContain("name: docs-example-com-agent");
    expect(result).not.toMatch(/name:.*\./);
  });

  it("description uses trigger-phrase style mentioning site name", () => {
    const ctx = makeOpenClawCtx();
    const result = generateOpenClawSkillMd(ctx);

    const descLine = result.split("\n").find((l) => l.startsWith("description:"));
    expect(descLine).toBeDefined();
    expect(descLine).toContain("Example Site");
    // Trigger-phrase pattern: starts with "Use when"
    expect(descLine).toMatch(/Use when/);
  });

  it("includes MCP endpoint when provided", () => {
    const ctx = makeOpenClawCtx();
    const result = generateOpenClawSkillMd(ctx, {
      mcpEndpoint: "https://w2agent.dev/api/mcp/example-com",
    });

    expect(result).toContain("https://w2agent.dev/api/mcp/example-com");
    expect(result).not.toContain("TODO");
  });

  it("uses localhost placeholder with TODO when no endpoint", () => {
    const ctx = makeOpenClawCtx();
    const result = generateOpenClawSkillMd(ctx);

    expect(result).toContain("localhost:3100/mcp");
    expect(result).toContain("TODO");
  });

  it("lists all detected tools", () => {
    const ctx = makeOpenClawCtx();
    const result = generateOpenClawSkillMd(ctx);

    expect(result).toContain("### `list-pages`");
    expect(result).toContain("### `get-page`");
    expect(result).toContain("### `search-site`");
  });

  it("lists key pages with links", () => {
    const ctx = makeOpenClawCtx();
    const result = generateOpenClawSkillMd(ctx);

    expect(result).toContain("[Example Site](https://example.com/)");
    expect(result).toContain("[Getting Started](https://example.com/docs/getting-started)");
    expect(result).toContain("## Key Content Areas");
  });

  it("includes search-faq step when FAQ content detected", () => {
    const faqHtml = `<html><head><title>FAQ</title></head><body>
      <h1>Frequently Asked Questions</h1>
      <h2>What is this?</h2>
      <p>This is a test product for testing purposes.</p>
      <h2>How does it work?</h2>
      <p>It works by processing your data and returning results.</p>
    </body></html>`;

    const ctx = makeOpenClawCtx({
      rawPages: [makeFetchedPage("https://example.com/faq", faqHtml)],
    });
    const result = generateOpenClawSkillMd(ctx);

    expect(result).toContain("search-faq");
  });

  it("escapes double quotes in YAML description", () => {
    const ctx = makeOpenClawCtx({
      pages: [
        {
          url: "https://example.com/",
          title: 'Site "With Quotes"',
          description: 'A "great" site',
          markdown: "Welcome.",
        },
      ],
    });
    const result = generateOpenClawSkillMd(ctx);

    const descLine = result.split("\n").find((l) => l.startsWith("description:"));
    expect(descLine).toBeDefined();
    expect(descLine).not.toMatch(/description: ".*[^\\]".*[^\\]".*"/);
  });
});

// --- generateAgentsMd ---

describe("generateAgentsMd", () => {
  const baseCtx: GenerateContext = {
    pages: [
      {
        url: "https://example.com/",
        title: "Example Site",
        description: "A test site",
        markdown: "Welcome.",
      },
      {
        url: "https://example.com/docs",
        title: "Docs",
        description: "Documentation",
        markdown: "Read the docs.",
      },
    ],
    rawPages: [],
    metadata: {
      baseUrl: "https://example.com",
      wellKnown: {},
    },
    baseUrl: "https://example.com",
  };

  it("includes site name as H1", () => {
    const result = generateAgentsMd(baseCtx);
    expect(result).toMatch(/^# Example Site/m);
  });

  it("includes base URL in overview", () => {
    const result = generateAgentsMd(baseCtx);
    expect(result).toContain("https://example.com");
  });

  it("includes page count", () => {
    const result = generateAgentsMd(baseCtx);
    expect(result).toContain("**Pages indexed:** 2");
  });

  it("mentions llms.txt capability when present in metadata", () => {
    const ctx = { ...baseCtx, metadata: { ...baseCtx.metadata, llmsTxt: "# Example" } };
    const result = generateAgentsMd(ctx);
    expect(result).toContain("llms.txt");
  });

  it("mentions OpenAPI when spec present", () => {
    const ctx = {
      ...baseCtx,
      metadata: {
        ...baseCtx.metadata,
        openapi: {
          title: "API",
          version: "1.0",
          endpoints: [
            { path: "/v1/data", method: "GET", summary: "", parameters: [], responses: {} },
          ],
        },
      },
    };
    const result = generateAgentsMd(ctx);
    expect(result).toContain("OpenAPI spec with 1 endpoint");
  });

  it("notes OAuth server when well-known present", () => {
    const ctx = {
      ...baseCtx,
      metadata: {
        ...baseCtx.metadata,
        wellKnown: { "oauth-authorization-server": '{"issuer":"https://example.com"}' },
      },
    };
    const result = generateAgentsMd(ctx);
    expect(result).toContain("OAuth 2.0 authorization server");
  });

  it("includes AI bot permissions from robots.txt when AI bots have explicit entries", () => {
    const ctx = {
      ...baseCtx,
      metadata: {
        ...baseCtx.metadata,
        robotsTxt: "User-agent: GPTBot\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n",
      },
    };
    const result = generateAgentsMd(ctx);
    expect(result).toContain("GPTBot");
    expect(result).toContain("ClaudeBot");
  });

  it("handles empty pages gracefully", () => {
    const ctx = { ...baseCtx, pages: [] };
    expect(() => generateAgentsMd(ctx)).not.toThrow();
  });
});
