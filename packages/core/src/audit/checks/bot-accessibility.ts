import { randomUUID } from "node:crypto";
import { guardedFetch, type IsAllowedTarget, readBodyCapped } from "../../shared/fetcher.js";
import { BOT_TOKENS } from "../shared/bot-tokens.js";
import { mediaTypeEssence } from "../shared/json.js";
import {
  findBlockedTokens,
  planRobotsAccessFix,
  robotsAccessFixSnippet,
} from "../shared/robots-fix.js";
import type { Check, FetchedPage } from "../types.js";

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

const MARKDOWN_TIMEOUT_MS = 10000;
const MAX_MARKDOWN_BYTES = 64 * 1024;
const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);

interface MarkdownTarget {
  label: "homepage" | "docs page";
  url: string;
  html?: string;
}

interface MarkdownProbe {
  target: MarkdownTarget;
  method: "accept" | "suffix";
  url: string;
  hit: boolean;
  vary: boolean;
  reason: string;
}

const stripWww = (host: string) => host.replace(/^www\./, "");

function hrefOf(url: string): string | undefined {
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
}

function findDocsPage(pages: FetchedPage[], base: URL, homepage: string): FetchedPage | undefined {
  const siteHost = stripWww(base.hostname);
  return pages.find((page) => {
    if (page.status < 200 || page.status >= 300) return false;
    let url: URL;
    try {
      url = new URL(page.url);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.href === homepage) return false;
    if (stripWww(url.hostname) !== siteHost && url.hostname !== `docs.${siteHost}`) return false;
    return url.hostname.startsWith("docs.") || /^\/(docs|documentation)(\/|$)/.test(url.pathname);
  });
}

function markdownSuffixUrl(target: string): string {
  const url = new URL(target);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname === "/" ? "/index.md" : `${url.pathname.replace(/\/$/, "")}.md`;
  return url.href;
}

const HTML_START = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SOFT_404_REASON = "nonexistent .md path also returns markdown (catch-all)";

const variesOnAccept = (res: Response) =>
  (res.headers.get("vary") ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .some((v) => v === "accept" || v === "*");

async function markdownMissReason(res: Response, echoOf?: string): Promise<string | undefined> {
  const type = mediaTypeEssence(res.headers.get("content-type") ?? "");
  if (res.status < 200 || res.status >= 300 || !MARKDOWN_TYPES.has(type)) {
    await res.body?.cancel().catch(() => {});
    return `status ${res.status}, content-type ${type || "none"}`;
  }
  const body = await readBodyCapped(res, MAX_MARKDOWN_BYTES);
  if (body.trim() === "") return "empty body";
  if (HTML_START.test(body.trimStart().slice(0, 1024))) return "HTML body labelled as markdown";
  if (echoOf !== undefined) {
    const truncated = new TextEncoder().encode(body).byteLength >= MAX_MARKDOWN_BYTES;
    const echoes = truncated ? echoOf.startsWith(body.slice(0, -4)) : body === echoOf;
    if (echoes) return "catch-all: same body as the crawled page";
  }
  return undefined;
}

async function probeMarkdown(
  target: MarkdownTarget,
  method: MarkdownProbe["method"],
  signal: AbortSignal,
  catchAll: boolean,
  isAllowedTarget?: IsAllowedTarget,
): Promise<MarkdownProbe> {
  const url = method === "accept" ? target.url : markdownSuffixUrl(target.url);
  const miss = (reason: string): MarkdownProbe => ({
    target,
    method,
    url,
    hit: false,
    vary: false,
    reason,
  });
  try {
    let res: Response;
    let vary = false;
    if (method === "accept") {
      const headers = { Accept: "text/markdown" };
      res = await guardedFetch(url, { signal, redirect: "manual", headers }, isAllowedTarget);
      vary = variesOnAccept(res);
      const location = res.headers.get("location");
      if (REDIRECT_STATUSES.has(res.status) && location !== null) {
        await res.body?.cancel().catch(() => {});
        const next = new URL(location, url).href;
        res = await guardedFetch(next, { signal, redirect: "follow", headers }, isAllowedTarget);
      }
    } else {
      res = await guardedFetch(url, { signal, redirect: "follow" }, isAllowedTarget);
    }
    const reason = await markdownMissReason(res, catchAll ? target.html : undefined);
    if (reason !== undefined) return miss(reason);
    return { target, method, url, hit: true, vary, reason: "" };
  } catch {
    return miss("request failed, timed out or was refused");
  }
}

async function nonexistentMarkdownServed(
  origin: string,
  signal: AbortSignal,
  isAllowedTarget?: IsAllowedTarget,
): Promise<boolean> {
  try {
    const res = await guardedFetch(
      `${origin}/${randomUUID()}.md`,
      { signal, redirect: "follow" },
      isAllowedTarget,
    );
    return (await markdownMissReason(res)) === undefined;
  } catch {
    return false;
  }
}

export const contentNegotiation: Check = {
  id: "content-negotiation",
  name: "Content negotiation (Markdown)",
  category: "bot-accessibility",
  weight: 0.5,
  severity: "info",
  run: async (pages, metadata, ctx) => {
    const base = {
      id: "content-negotiation",
      name: "Content negotiation (Markdown)",
      category: "bot-accessibility" as const,
      maxScore: 100,
      weight: 0.5,
      severity: "info" as const,
    };

    const homepage = `${metadata.baseUrl}/`;
    const homepageHref = hrefOf(homepage);
    const targets: MarkdownTarget[] = [];
    if (homepageHref) {
      const crawled = pages.find((p) => hrefOf(p.url) === homepageHref);
      targets.push({ label: "homepage", url: homepageHref, html: crawled?.html });
      const docs = findDocsPage(pages, new URL(homepageHref), homepageHref);
      if (docs) targets.push({ label: "docs page", url: docs.url, html: docs.html });
    }

    const signal = AbortSignal.timeout(MARKDOWN_TIMEOUT_MS);
    const catchAll = metadata.catchAll === true;
    const probes = await Promise.all(
      targets.flatMap((t) =>
        (["accept", "suffix"] as const).map((m) =>
          probeMarkdown(t, m, signal, catchAll, ctx?.isAllowedTarget),
        ),
      ),
    );
    const suffixOrigins = [
      ...new Set(
        probes.filter((p) => p.hit && p.method === "suffix").map((p) => new URL(p.url).origin),
      ),
    ];
    const soft404Origins = new Set<string>();
    await Promise.all(
      suffixOrigins.map(async (origin) => {
        if (await nonexistentMarkdownServed(origin, signal, ctx?.isAllowedTarget)) {
          soft404Origins.add(origin);
        }
      }),
    );
    for (const p of probes) {
      if (p.hit && p.method === "suffix" && soft404Origins.has(new URL(p.url).origin)) {
        Object.assign(p, { hit: false, reason: SOFT_404_REASON });
      }
    }

    const labelsOf = (list: MarkdownProbe[]) =>
      [...new Set(list.map((p) => p.target.label))].join(" and ");
    const suffixHits = probes.filter((p) => p.hit && p.method === "suffix");
    const acceptHits = probes.filter((p) => p.hit && p.method === "accept");
    const acceptNoVary = acceptHits.filter((p) => !p.vary);

    const details = probes
      .map((p) => {
        const how = p.method === "accept" ? "Accept: text/markdown" : ".md URL";
        const outcome = p.hit
          ? p.method === "accept"
            ? `hit (${p.vary ? "Vary: Accept" : "no Vary: Accept"})`
            : "hit"
          : `miss (${p.reason})`;
        return `${p.target.label} ${how} ${p.url}: ${outcome}`;
      })
      .join("\n");

    const parts: string[] = [];
    if (suffixHits.length > 0) parts.push(`.md URL (${labelsOf(suffixHits)})`);
    if (acceptHits.length > 0) parts.push(`Accept: text/markdown (${labelsOf(acceptHits)})`);
    const varyNote =
      acceptNoVary.length > 0
        ? `; add Vary: Accept to the first Accept: text/markdown response, the redirect if it redirects (${labelsOf(acceptNoVary)}) so caches don't serve markdown to browsers`
        : "";
    const snippetPath = targets[targets.length - 1]
      ? new URL(markdownSuffixUrl(targets[targets.length - 1].url)).pathname
      : "/index.md";

    if (suffixHits.length > 0 || acceptHits.some((p) => p.vary)) {
      return {
        ...base,
        status: "pass",
        score: 100,
        message: `Markdown served via ${parts.join(" and ")}${varyNote}`,
        details,
      };
    }

    if (acceptHits.length > 0) {
      return {
        ...base,
        status: "partial",
        score: 50,
        message: `Markdown served via ${parts.join(" and ")} but without Vary: Accept${varyNote}`,
        details,
        fixSnippet:
          "# On responses that vary by the Accept header, add:\nVary: Accept\n# Or also serve the markdown at a .md URL, e.g. " +
          snippetPath,
      };
    }

    return {
      ...base,
      status: "fail",
      score: 0,
      message: `No markdown served via Accept: text/markdown or .md URLs (checked ${targets.map((t) => t.label).join(" and ") || "no valid homepage URL"})`,
      details: details || undefined,
      fixSnippet: `# Serve markdown for agents, either:\n# 1. For requests with Accept: text/markdown, respond with\nContent-Type: text/markdown; charset=utf-8\nVary: Accept\n# 2. Or serve the page as markdown at ${snippetPath}`,
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
