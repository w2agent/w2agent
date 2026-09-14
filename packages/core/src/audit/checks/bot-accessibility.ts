import { checkContentNegotiation } from "../../shared/fetcher.js";
import { BOT_TOKENS } from "../shared/bot-tokens.js";
import {
  findBlockedTokens,
  planRobotsAccessFix,
  robotsAccessFixSnippet,
} from "../shared/robots-fix.js";
import type { Check } from "../types.js";

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

const GOOGLE_AGENT_NOTE =
  "Google-Agent: no robots.txt token — Google says user-triggered fetchers generally ignore robots.txt";

export const aiAgentAccess: Check = {
  id: "ai-agent-access",
  name: "AI agent access",
  category: "bot-accessibility",
  weight: 2,
  severity: "error",
  run: (_pages, metadata) => {
    const base = {
      id: "ai-agent-access",
      name: "AI agent access",
      category: "bot-accessibility" as const,
      maxScore: 100,
      weight: 2,
    };

    if (!metadata.robotsTxt) {
      const status = metadata.robotsTxtStatus;
      if (status === 0) {
        return {
          ...base,
          status: "error",
          score: 0,
          message: "Unmeasured — robots.txt fetch failed (network error or timeout)",
          details: GOOGLE_AGENT_NOTE,
          severity: "info",
        };
      }
      if (status === 429) {
        return {
          ...base,
          status: "error",
          score: 0,
          message: "Unmeasured — robots.txt kept returning 429 (rate-limited) through every retry",
          details: GOOGLE_AGENT_NOTE,
          severity: "info",
        };
      }
      if (status !== undefined && status >= 500) {
        return {
          ...base,
          status: "fail",
          score: 0,
          message: `robots.txt returned ${status}; per RFC 9309 crawlers must assume complete disallow`,
          details: GOOGLE_AGENT_NOTE,
          severity: "error",
        };
      }
      return {
        ...base,
        status: "pass",
        score: 100,
        message: "No robots.txt — crawlers may access everything",
        details: GOOGLE_AGENT_NOTE,
        severity: "info",
      };
    }

    const blocked = findBlockedTokens(metadata.robotsTxt, metadata.baseUrl);
    const trainingAllowed = BOT_TOKENS.filter(
      (b) => b.robotsToken && b.purpose === "training" && !blocked.training.includes(b.token),
    ).map((b) => b.token);

    const details = [
      blocked.user.length > 0 ? `User-initiated blocked: ${blocked.user.join(", ")}` : undefined,
      blocked.search.length > 0 ? `Search blocked: ${blocked.search.join(", ")}` : undefined,
      `Training (informational, not scored) — allowed: ${trainingAllowed.join(", ") || "none"}; blocked: ${blocked.training.join(", ") || "none"}`,
      GOOGLE_AGENT_NOTE,
    ]
      .filter(Boolean)
      .join("\n");

    const fix = planRobotsAccessFix(metadata.robotsTxt, metadata.baseUrl);
    const fixSnippet = fix ? robotsAccessFixSnippet(fix) : undefined;

    if (blocked.user.length > 0) {
      return {
        ...base,
        status: "fail",
        score: 0,
        message: `robots.txt declares intent to block user-initiated AI agents: ${blocked.user.join(", ")}`,
        details,
        severity: "error",
        fixSnippet,
      };
    }

    if (blocked.search.length > 0) {
      return {
        ...base,
        status: "partial",
        score: 50,
        message: `AI search fetchers blocked: ${blocked.search.join(", ")}`,
        details,
        severity: "warning",
        fixSnippet,
      };
    }

    return {
      ...base,
      status: "pass",
      score: 100,
      message: "User-initiated AI agents and AI search fetchers are not blocked",
      details,
      severity: "info",
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
    const measured = pages.filter((p) => p.responseTime > 0);
    if (measured.length === 0) {
      return {
        id: "response-time",
        name: "Response time",
        category: "bot-accessibility",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 1,
        message:
          pages.length === 0
            ? "No pages to measure"
            : "Response time not measured (crawl backend reported no timings)",
        severity: "warning",
      };
    }

    const avgTime = measured.reduce((sum, p) => sum + p.responseTime, 0) / measured.length;
    let score: number;
    let status: "pass" | "partial" | "fail";
    if (avgTime < 500) [score, status] = [100, "pass"];
    else if (avgTime < 1500) [score, status] = [70, "pass"];
    else if (avgTime < 3000) [score, status] = [35, "partial"];
    else [score, status] = [0, "fail"];

    const unmeasured = pages.length - measured.length;
    return {
      id: "response-time",
      name: "Response time",
      category: "bot-accessibility",
      status,
      score,
      maxScore: 100,
      weight: 1,
      message: `Average response time: ${Math.round(avgTime)}ms${unmeasured > 0 ? ` (${unmeasured} unmeasured page(s) excluded)` : ""}`,
      details: measured.map((p) => `${p.url}: ${p.responseTime}ms`).join("\n"),
      severity: status === "pass" ? "info" : "warning",
    };
  },
};

export const contentNegotiation: Check = {
  id: "content-negotiation",
  name: "Content negotiation (Markdown)",
  category: "bot-accessibility",
  weight: 0.5,
  severity: "info",
  run: async (_pages, metadata, ctx) => {
    const supports = await checkContentNegotiation(`${metadata.baseUrl}/`, {
      timeout: 10000,
      userAgent: "w2agent/0.1",
      isAllowedTarget: ctx?.isAllowedTarget,
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
  aiAgentAccess,
  sitemapExists,
  responseTime,
  contentNegotiation,
  statusCodes,
];
