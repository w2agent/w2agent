import robotsParser from "robots-parser";
import { checkContentNegotiation } from "../../shared/fetcher.js";
import type { Check } from "../types.js";

const AI_BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Bytespider"];

export const robotsTxtExists: Check = {
  id: "robots-txt-exists",
  name: "robots.txt exists",
  category: "bot-accessibility",
  weight: 1,
  severity: "warning",
  run: (_pages, metadata) => ({
    id: "robots-txt-exists",
    name: "robots.txt exists",
    category: "bot-accessibility",
    status: metadata.robotsTxt ? "pass" : "fail",
    score: metadata.robotsTxt ? 100 : 0,
    maxScore: 100,
    weight: 1,
    message: metadata.robotsTxt
      ? "robots.txt found and accessible"
      : "No robots.txt found — AI crawlers may not know what's allowed",
    severity: "warning",
    fixSnippet: !metadata.robotsTxt
      ? `# Create a robots.txt file at your site root:\nUser-agent: *\nAllow: /\n\nSitemap: https://yoursite.com/sitemap.xml`
      : undefined,
  }),
};

export const robotsTxtAiBots: Check = {
  id: "robots-txt-ai-bots",
  name: "AI bots not blocked",
  category: "bot-accessibility",
  weight: 2,
  severity: "error",
  run: (_pages, metadata) => {
    if (!metadata.robotsTxt) {
      return {
        id: "robots-txt-ai-bots",
        name: "AI bots not blocked",
        category: "bot-accessibility",
        status: "skip",
        score: 50,
        maxScore: 100,
        weight: 2,
        message: "No robots.txt — bots are implicitly allowed but intent is unclear",
        severity: "warning",
      };
    }

    const robots = robotsParser(`${metadata.baseUrl}/robots.txt`, metadata.robotsTxt);
    const blocked: string[] = [];
    const allowed: string[] = [];

    for (const bot of AI_BOTS) {
      if (!robots.isAllowed(`${metadata.baseUrl}/`, bot)) {
        blocked.push(bot);
      } else {
        allowed.push(bot);
      }
    }

    const score = Math.round((allowed.length / AI_BOTS.length) * 100);
    const status =
      blocked.length === 0 ? "pass" : blocked.length === AI_BOTS.length ? "fail" : "partial";

    return {
      id: "robots-txt-ai-bots",
      name: "AI bots not blocked",
      category: "bot-accessibility",
      status,
      score,
      maxScore: 100,
      weight: 2,
      message:
        blocked.length === 0 ? "All major AI bots are allowed" : `Blocked: ${blocked.join(", ")}`,
      details: `Allowed: ${allowed.join(", ")}${blocked.length > 0 ? `\nBlocked: ${blocked.join(", ")}` : ""}`,
      severity: blocked.length > 0 ? "error" : "info",
      fixSnippet:
        blocked.length > 0
          ? `# Remove or update these rules in robots.txt:\n${blocked.map((b) => `# User-agent: ${b}\n# Disallow: /  <-- remove this`).join("\n")}`
          : undefined,
    };
  },
};

export const sitemapExists: Check = {
  id: "sitemap-exists",
  name: "XML sitemap exists",
  category: "bot-accessibility",
  weight: 1.5,
  severity: "warning",
  run: (_pages, metadata) => {
    const exists = !!metadata.sitemapXml;
    const valid =
      exists &&
      (metadata.sitemapXml?.includes("<urlset") || metadata.sitemapXml?.includes("<sitemapindex"));

    return {
      id: "sitemap-exists",
      name: "XML sitemap exists",
      category: "bot-accessibility",
      status: valid ? "pass" : "fail",
      score: valid ? 100 : 0,
      maxScore: 100,
      weight: 1.5,
      message: valid ? "XML sitemap found and valid" : "No valid XML sitemap found",
      severity: "warning",
      fixSnippet: !valid
        ? `<!-- Create sitemap.xml at your site root -->\n<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://yoursite.com/</loc>\n  </url>\n</urlset>`
        : undefined,
    };
  },
};

export const responseTime: Check = {
  id: "response-time",
  name: "Response time",
  category: "bot-accessibility",
  weight: 1,
  severity: "warning",
  run: (pages) => {
    if (pages.length === 0) {
      return {
        id: "response-time",
        name: "Response time",
        category: "bot-accessibility",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 1,
        message: "No pages to measure",
        severity: "warning",
      };
    }

    const avgTime = pages.reduce((sum, p) => sum + p.responseTime, 0) / pages.length;
    let score: number;
    if (avgTime <= 500) score = 100;
    else if (avgTime <= 1000) score = 80;
    else if (avgTime <= 2000) score = 60;
    else if (avgTime <= 3000) score = 30;
    else score = 0;

    return {
      id: "response-time",
      name: "Response time",
      category: "bot-accessibility",
      status: score >= 60 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: `Average response time: ${Math.round(avgTime)}ms`,
      details: pages.map((p) => `${p.url}: ${p.responseTime}ms`).join("\n"),
      severity: score < 60 ? "warning" : "info",
    };
  },
};

export const contentNegotiation: Check = {
  id: "content-negotiation",
  name: "Content negotiation (Markdown)",
  category: "bot-accessibility",
  weight: 0.5,
  severity: "info",
  run: async (_pages, metadata) => {
    const supports = await checkContentNegotiation(`${metadata.baseUrl}/`, {
      timeout: 10000,
      userAgent: "w2agent/0.1",
    });

    return {
      id: "content-negotiation",
      name: "Content negotiation (Markdown)",
      category: "bot-accessibility",
      status: supports ? "pass" : "fail",
      score: supports ? 100 : 0,
      maxScore: 100,
      weight: 0.5,
      message: supports
        ? "Site responds to Accept: text/markdown"
        : "No markdown content negotiation support",
      severity: "info",
    };
  },
};

export const statusCodes: Check = {
  id: "status-codes",
  name: "No error status codes",
  category: "bot-accessibility",
  weight: 1,
  severity: "error",
  run: (pages) => {
    const errors = pages.filter((p) => p.status >= 400 || p.status === 0);
    const score =
      pages.length > 0 ? Math.round(((pages.length - errors.length) / pages.length) * 100) : 0;

    return {
      id: "status-codes",
      name: "No error status codes",
      category: "bot-accessibility",
      status: errors.length === 0 ? "pass" : "partial",
      score,
      maxScore: 100,
      weight: 1,
      message:
        errors.length === 0
          ? "All pages return successful status codes"
          : `${errors.length} page(s) returned errors`,
      details:
        errors.length > 0
          ? errors.map((p) => `${p.url}: ${p.status || "timeout"}`).join("\n")
          : undefined,
      severity: errors.length > 0 ? "error" : "info",
    };
  },
};

export const botAccessibilityChecks: Check[] = [
  robotsTxtExists,
  robotsTxtAiBots,
  sitemapExists,
  responseTime,
  contentNegotiation,
  statusCodes,
];
