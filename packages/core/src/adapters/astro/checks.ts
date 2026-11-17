import {
  findBlockedTokens,
  planRobotsAccessFix,
  type RobotsAccessFix,
} from "../../audit/shared/robots-fix.js";
import type { Check, FetchedPage, SiteMetadata } from "../../audit/types.js";

export const astroSitemapIntegrationCheck: Check = {
  id: "astro-sitemap-integration",
  name: "Astro Sitemap Integration",
  category: "bot-accessibility",
  weight: 1,
  severity: "warning",
  run(_pages: FetchedPage[], metadata: SiteMetadata) {
    const hasSitemap =
      !!metadata.wellKnown["sitemap.xml"] || !!metadata.wellKnown["sitemap-index.xml"];

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: hasSitemap ? "pass" : "fail",
      score: hasSitemap ? 100 : 0,
      maxScore: 100,
      message: hasSitemap
        ? "Sitemap detected — AI crawlers can discover all pages"
        : "No sitemap found. Install @astrojs/sitemap for automatic sitemap generation.",
      details: hasSitemap ? undefined : "Run: npx astro add sitemap",
    };
  },
};

function robotsBlockDetails(fix: RobotsAccessFix | undefined): string {
  const keep = (names: string[]) =>
    `${names.join(", ")} ${names.length === 1 ? "is" : "are"} blocked by ${names.length === 1 ? "its" : "their"} own User-agent group. That is the owner's choice and w2agent does not reverse it; edit the group only if the block is unintended.`;
  if (!fix) return "Allow the AI crawlers that robots.txt blocks to enable agent discovery.";
  const parts: string[] = [];
  if (fix.wildcard.length > 0) {
    parts.push(
      "Agents blocked only by the User-agent: * group need an Allow group of their own (see the ai-agent-access fix snippet).",
    );
  }
  if (fix.openGroup) {
    parts.push(
      "robots.txt ends in a User-agent line with no rules, so appended groups would join it: add that group's rules (or remove the line) before adding Allow groups.",
    );
  }
  if (fix.named.length > 0) parts.push(keep(fix.named));
  return parts.join(" ");
}

export const astroRobotsTxtCheck: Check = {
  id: "astro-robots-txt",
  name: "Astro robots.txt",
  category: "agent-discovery",
  weight: 1,
  severity: "warning",
  run(_pages: FetchedPage[], metadata: SiteMetadata) {
    const robotsTxt = metadata.robotsTxt || "";
    const hasRobots = robotsTxt.length > 0;

    if (!hasRobots) {
      return {
        id: this.id,
        name: this.name,
        category: this.category,
        weight: this.weight,
        severity: this.severity,
        status: "fail" as const,
        score: 0,
        maxScore: 100,
        message: "No robots.txt found. Add one to public/ or use astro-robots-txt integration.",
      };
    }

    const { user, search } = findBlockedTokens(robotsTxt, metadata.baseUrl);
    const blocked = [...user, ...search];

    if (blocked.length > 0) {
      return {
        id: this.id,
        name: this.name,
        category: this.category,
        weight: this.weight,
        severity: this.severity,
        status: "fail" as const,
        score: 0,
        maxScore: 100,
        message: `robots.txt blocks AI bots: ${blocked.join(", ")}`,
        details: robotsBlockDetails(planRobotsAccessFix(robotsTxt, metadata.baseUrl)),
      };
    }

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: "pass" as const,
      score: 100,
      maxScore: 100,
      message: "robots.txt exists and does not block AI bots",
    };
  },
};

export const astroSsrModeCheck: Check = {
  id: "astro-ssr-mode",
  name: "Astro Rendering Mode",
  category: "technical",
  weight: 1,
  severity: "info",
  run(pages: FetchedPage[]) {
    // Astro static sites have fully rendered HTML by default
    // SSR mode is detected by server-timing or x-astro-* headers
    const hasSSRHeaders = pages.some(
      (p) => p.headers["x-astro-ssr"] || p.headers["server-timing"]?.includes("astro"),
    );

    const isFullyRendered = pages.every((p) => {
      const bodyContent = p.html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").trim();
      return bodyContent.length > 200;
    });

    const isStatic = !hasSSRHeaders && isFullyRendered;

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: isFullyRendered ? "pass" : "partial",
      score: isFullyRendered ? 100 : 60,
      maxScore: 100,
      message: isStatic
        ? "Static site — all pages are pre-rendered, ideal for AI crawlers"
        : hasSSRHeaders
          ? "SSR mode detected — pages are server-rendered on demand"
          : "Some pages may have limited server-rendered content",
      details: isFullyRendered
        ? undefined
        : "Astro's default static mode is ideal for AI crawlers. If using SSR, ensure key pages have substantial HTML content.",
    };
  },
};

export const astroChecks: Check[] = [
  astroSitemapIntegrationCheck,
  astroRobotsTxtCheck,
  astroSsrModeCheck,
];
