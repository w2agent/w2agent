import type { Check, FetchedPage, SiteMetadata } from "../../audit/types.js";

export const wpRestApiCheck: Check = {
  id: "wp-rest-api-accessible",
  name: "WordPress REST API Accessible",
  category: "agent-protocols",
  weight: 1,
  severity: "warning",
  run(pages: FetchedPage[], _metadata: SiteMetadata) {
    const hasWpJson = pages.some(
      (p) => p.headers.link?.includes("wp-json") || p.html.includes('rel="https://api.w.org/"'),
    );
    const restEndpointPage = pages.find((p) => p.url.includes("/wp-json/"));
    const accessible = hasWpJson || !!restEndpointPage;

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: accessible ? "pass" : "fail",
      score: accessible ? 100 : 0,
      maxScore: 100,
      message: accessible
        ? "WordPress REST API is accessible — AI agents can query content programmatically"
        : "WordPress REST API not detected. AI agents won't be able to query content via /wp-json/",
      details: accessible
        ? "The REST API enables AI agents to discover and retrieve structured content."
        : "Ensure the REST API is not disabled. Check Settings > Permalinks and any security plugins.",
    };
  },
};

export const wpSecurityBlockingCheck: Check = {
  id: "wp-security-blocking-bots",
  name: "Security Plugin Bot Blocking",
  category: "bot-accessibility",
  weight: 1,
  severity: "warning",
  run(pages: FetchedPage[]) {
    const blockingSignals = [
      "wordfence",
      "sucuri",
      "ithemes-security",
      "all-in-one-wp-security",
      "shield-security",
    ];
    const html = pages.map((p) => p.html.toLowerCase()).join(" ");
    const found = blockingSignals.filter((s) => html.includes(s));

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: found.length === 0 ? "pass" : "partial",
      score: found.length === 0 ? 100 : 50,
      maxScore: 100,
      message:
        found.length === 0
          ? "No aggressive security plugins detected that might block AI bots"
          : `Security plugin(s) detected: ${found.join(", ")}. May block AI crawlers.`,
      details:
        found.length > 0
          ? "Check plugin settings to whitelist AI bot user agents (GPTBot, ClaudeBot, etc.)"
          : undefined,
    };
  },
};

export const wpRobotsBlockingCheck: Check = {
  id: "wp-robots-default-blocking",
  name: "WordPress Robots.txt AI Bot Rules",
  category: "bot-accessibility",
  weight: 1,
  severity: "warning",
  run(_pages: FetchedPage[], metadata: SiteMetadata) {
    const robots = metadata.robotsTxt || "";
    const aiBots = ["gptbot", "claudebot", "anthropic", "chatgpt", "google-extended", "ccbot"];
    const blocked = aiBots.filter(
      (bot) =>
        robots.toLowerCase().includes(`user-agent: ${bot}`) &&
        robots.toLowerCase().includes("disallow: /"),
    );

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: blocked.length === 0 ? "pass" : "fail",
      score: blocked.length === 0 ? 100 : Math.max(0, 100 - blocked.length * 20),
      maxScore: 100,
      message:
        blocked.length === 0
          ? "robots.txt does not block known AI crawlers"
          : `robots.txt blocks ${blocked.length} AI bot(s): ${blocked.join(", ")}`,
      details:
        blocked.length > 0
          ? "Consider selectively allowing AI bots to index your content for AI discovery."
          : undefined,
    };
  },
};

export const wpPageBuilderSoupCheck: Check = {
  id: "wp-page-builder-soup",
  name: "Page Builder Markup Quality",
  category: "content-quality",
  weight: 1,
  severity: "info",
  run(pages: FetchedPage[]) {
    const builderSignals = [
      { name: "Elementor", pattern: "elementor-widget" },
      { name: "Divi", pattern: "et_pb_" },
      { name: "WPBakery", pattern: "vc_row" },
      { name: "Beaver Builder", pattern: "fl-builder" },
    ];

    const detected: string[] = [];
    for (const page of pages) {
      for (const sig of builderSignals) {
        if (page.html.includes(sig.pattern) && !detected.includes(sig.name)) {
          detected.push(sig.name);
        }
      }
    }

    const divHeavy = pages.some((p) => {
      const divCount = (p.html.match(/<div/gi) || []).length;
      const textLength = p.html.replace(/<[^>]+>/g, "").length;
      return divCount > 0 && textLength / divCount < 20;
    });

    const hasSoup = detected.length > 0 && divHeavy;

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: hasSoup ? "partial" : "pass",
      score: hasSoup ? 50 : 100,
      maxScore: 100,
      message: hasSoup
        ? `Page builder detected (${detected.join(", ")}) with heavy div nesting — AI may struggle to extract content`
        : detected.length > 0
          ? `Page builder detected (${detected.join(", ")}) but markup structure is reasonable`
          : "No heavy page builder markup detected — content should be easily parseable by AI",
    };
  },
};

export const wordpressChecks: Check[] = [
  wpRestApiCheck,
  wpSecurityBlockingCheck,
  wpRobotsBlockingCheck,
  wpPageBuilderSoupCheck,
];
