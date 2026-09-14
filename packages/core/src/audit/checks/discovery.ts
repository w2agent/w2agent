import { fetchText } from "../../shared/fetcher.js";
import { parseHTML } from "../../shared/html-parser.js";
import { parseJsonObject } from "../shared/json.js";
import type { Check } from "../types.js";

export const llmsTxtExists: Check = {
  id: "llms-txt-exists",
  name: "llms.txt exists",
  category: "agent-discovery",
  weight: 0.5,
  severity: "warning",
  run: (_pages, metadata) => ({
    id: "llms-txt-exists",
    name: "llms.txt exists",
    category: "agent-discovery",
    status: metadata.llmsTxt ? "pass" : "fail",
    score: metadata.llmsTxt ? 100 : 0,
    maxScore: 100,
    weight: 0.5,
    message: metadata.llmsTxt
      ? "llms.txt found"
      : "No llms.txt found — coding agents and AI tools that read llms.txt have no curated index of your docs",
    severity: metadata.llmsTxt ? "info" : "warning",
    fixSnippet: !metadata.llmsTxt
      ? `# Create /llms.txt at your site root:\n# Your Site Name\n\n> Brief description of your site\n\n## Docs\n\n- [Page Title](https://yoursite.com/page): Description\n- [Another Page](https://yoursite.com/other): Description`
      : undefined,
  }),
};

export const llmsTxtValid: Check = {
  id: "llms-txt-valid",
  name: "llms.txt follows spec",
  category: "agent-discovery",
  weight: 0.5,
  severity: "info",
  run: (_pages, metadata) => {
    if (!metadata.llmsTxt) {
      return {
        id: "llms-txt-valid",
        name: "llms.txt follows spec",
        category: "agent-discovery",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 0.5,
        message: "No llms.txt to validate",
        severity: "info",
      };
    }

    const text = metadata.llmsTxt;
    let score = 0;

    // Has H1 title (line starting with #)
    if (/^#\s+.+/m.test(text)) score += 30;
    // Has blockquote description
    if (/^>\s+.+/m.test(text)) score += 20;
    // Has URL links
    if (/https?:\/\/\S+/.test(text)) score += 30;
    // Has section headers (##)
    if (/^##\s+.+/m.test(text)) score += 20;

    return {
      id: "llms-txt-valid",
      name: "llms.txt follows spec",
      category: "agent-discovery",
      status: score >= 70 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message:
        score >= 70
          ? "llms.txt follows the specification"
          : `llms.txt partially follows spec (${score}% complete)`,
      severity: "info",
    };
  },
};

export const llmsTxtLinksResolve: Check = {
  id: "llms-txt-links-resolve",
  name: "llms.txt links resolve",
  category: "agent-discovery",
  weight: 0.5,
  severity: "warning",
  run: async (_pages, metadata, ctx) => {
    if (!metadata.llmsTxt) {
      return {
        id: "llms-txt-links-resolve",
        name: "llms.txt links resolve",
        category: "agent-discovery",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 0.5,
        message: "No llms.txt to check links",
        severity: "info",
      };
    }

    const urlRegex = /https?:\/\/[^\s)>\],:]+/g;
    const urls = metadata.llmsTxt.match(urlRegex) || [];

    if (urls.length === 0) {
      return {
        id: "llms-txt-links-resolve",
        name: "llms.txt links resolve",
        category: "agent-discovery",
        status: "fail",
        score: 0,
        maxScore: 100,
        weight: 0.5,
        message: "No URLs found in llms.txt",
        severity: "warning",
      };
    }

    // Check up to 10 links
    const toCheck = urls.slice(0, 10);
    const results = await Promise.all(
      toCheck.map(async (url) => {
        const result = await fetchText(url, {
          timeout: 5000,
          userAgent: "w2agent/0.1",
          isAllowedTarget: ctx?.isAllowedTarget,
        });
        return { url, ok: result !== null && result.status >= 200 && result.status < 400 };
      }),
    );

    const resolved = results.filter((r) => r.ok).length;
    const score = Math.round((resolved / toCheck.length) * 100);

    return {
      id: "llms-txt-links-resolve",
      name: "llms.txt links resolve",
      category: "agent-discovery",
      status: score === 100 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message: `${resolved}/${toCheck.length} URLs in llms.txt resolve successfully`,
      details: results
        .filter((r) => !r.ok)
        .map((r) => `Broken: ${r.url}`)
        .join("\n"),
      severity: score < 100 ? "warning" : "info",
    };
  },
};

export const wellKnownAgentCard: Check = {
  id: "well-known-agent-card",
  name: "/.well-known/agent-card.json",
  category: "agent-discovery",
  weight: 1,
  severity: "info",
  run: (_pages, metadata) => {
    const valid = parseJsonObject(metadata.wellKnown["agent-card.json"]) !== null;

    return {
      id: "well-known-agent-card",
      name: "/.well-known/agent-card.json",
      category: "agent-discovery",
      status: valid ? "pass" : "fail",
      score: valid ? 100 : 0,
      maxScore: 100,
      weight: 1,
      message: valid
        ? "agent-card.json found and valid JSON"
        : "No /.well-known/agent-card.json found",
      severity: "info",
    };
  },
};

export const markdownAlternate: Check = {
  id: "markdown-alternate",
  name: "Markdown alternate links",
  category: "agent-discovery",
  weight: 0.5,
  severity: "info",
  run: (pages) => {
    let pagesWithAlt = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const hasMarkdownAlt = parsed.alternateLinks.some((link) => link.type.includes("markdown"));
      if (hasMarkdownAlt) pagesWithAlt++;
    }

    const score = pagesWithAlt > 0 ? Math.min(100, pagesWithAlt * 25) : 0;

    return {
      id: "markdown-alternate",
      name: "Markdown alternate links",
      category: "agent-discovery",
      status: score > 0 ? "pass" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message:
        pagesWithAlt > 0
          ? `${pagesWithAlt} page(s) have markdown alternate links`
          : "No markdown alternate links found",
      severity: "info",
      fixSnippet:
        pagesWithAlt === 0
          ? `<!-- Add to <head> -->\n<link rel="alternate" type="text/markdown" href="/page.md" />`
          : undefined,
    };
  },
};

export const discoveryChecks: Check[] = [
  llmsTxtExists,
  llmsTxtValid,
  llmsTxtLinksResolve,
  wellKnownAgentCard,
  markdownAlternate,
];
