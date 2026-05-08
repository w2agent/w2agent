import { extractSiteInfo } from "./llms-txt.js";
import type { GenerateContext } from "./types.js";

export function generateAgentsMd(ctx: GenerateContext): string {
  const { siteName, siteDescription } = extractSiteInfo(ctx.pages, ctx.baseUrl);
  const lines: string[] = [];

  lines.push(`# ${siteName}`);
  lines.push("");
  if (siteDescription) {
    lines.push(`> ${siteDescription}`);
    lines.push("");
  }

  lines.push("## Overview");
  lines.push("");
  lines.push(`**URL:** ${ctx.baseUrl}`);
  lines.push(`**Pages indexed:** ${ctx.pages.length}`);
  lines.push("");

  lines.push("## Capabilities");
  lines.push("");
  if (ctx.metadata.llmsTxt) {
    lines.push(`- Content index: [llms.txt](${ctx.baseUrl}/llms.txt) available`);
  }
  if (ctx.metadata.openapi) {
    const count = ctx.metadata.openapi.endpoints.length;
    lines.push(`- API: OpenAPI spec with ${count} endpoint${count !== 1 ? "s" : ""}`);
  }
  if (ctx.metadata.mcpInit?.success) {
    lines.push(`- MCP: Model Context Protocol server available`);
  }
  if (ctx.metadata.sitemapXml) {
    lines.push(`- Sitemap: XML sitemap available`);
  }
  lines.push("");

  lines.push("## Authentication");
  lines.push("");
  const oauthServer = ctx.metadata.wellKnown["oauth-authorization-server"];
  const oauthResource = ctx.metadata.wellKnown["oauth-protected-resource"];
  if (oauthServer) {
    lines.push(
      "OAuth 2.0 authorization server metadata available at `/.well-known/oauth-authorization-server`.",
    );
  } else if (oauthResource) {
    lines.push(
      "OAuth 2.0 protected resource metadata available at `/.well-known/oauth-protected-resource`.",
    );
  } else {
    lines.push(
      "No OAuth server metadata detected. Check the developer portal for authentication details.",
    );
  }
  lines.push("");

  const robotsTxt = ctx.metadata.robotsTxt;
  if (robotsTxt) {
    const aiAgentAllows = parseAiBotPermissions(robotsTxt, ctx.baseUrl);
    if (aiAgentAllows.length > 0) {
      lines.push("## AI Bot Permissions");
      lines.push("");
      for (const entry of aiAgentAllows) {
        lines.push(`- **${entry.agent}**: ${entry.access}`);
      }
      lines.push("");
    }
  }

  const keyPages = ctx.pages.slice(0, 15);
  if (keyPages.length > 0) {
    lines.push("## Key Pages");
    lines.push("");
    for (const page of keyPages) {
      const title = page.title || page.url;
      const desc = page.description ? `: ${page.description}` : "";
      lines.push(`- [${title}](${page.url})${desc}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

const AI_BOTS = [
  "GPTBot",
  "ClaudeBot",
  "Claude-Web",
  "Anthropic-AI",
  "PerplexityBot",
  "Google-Extended",
  "CCBot",
  "Bytespider",
];

function parseAiBotPermissions(
  robotsTxt: string,
  _baseUrl: string,
): Array<{ agent: string; access: string }> {
  const results: Array<{ agent: string; access: string }> = [];
  const lines = robotsTxt.split("\n");
  let currentAgents: string[] = [];
  let hasAllow = false;
  let hasDisallow = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith("user-agent:")) {
      if (currentAgents.length > 0) {
        flushBlock(currentAgents, hasAllow, hasDisallow, results);
      }
      currentAgents = [trimmed.slice("user-agent:".length).trim()];
      hasAllow = false;
      hasDisallow = false;
    } else if (trimmed.toLowerCase().startsWith("allow:")) {
      hasAllow = true;
    } else if (trimmed.toLowerCase().startsWith("disallow:")) {
      if (trimmed.slice("disallow:".length).trim()) {
        hasDisallow = true;
      }
    } else if (!trimmed) {
      if (currentAgents.length > 0) {
        flushBlock(currentAgents, hasAllow, hasDisallow, results);
        currentAgents = [];
        hasAllow = false;
        hasDisallow = false;
      }
    }
  }
  if (currentAgents.length > 0) {
    flushBlock(currentAgents, hasAllow, hasDisallow, results);
  }

  return results.filter((r) =>
    AI_BOTS.some((b) => r.agent === "*" || r.agent.toLowerCase() === b.toLowerCase()),
  );
}

function flushBlock(
  agents: string[],
  hasAllow: boolean,
  hasDisallow: boolean,
  out: Array<{ agent: string; access: string }>,
): void {
  for (const agent of agents) {
    if (!AI_BOTS.some((b) => b.toLowerCase() === agent.toLowerCase()) && agent !== "*") {
      continue;
    }
    const access = hasDisallow ? "Restricted" : hasAllow ? "Allowed" : "Allowed (default)";
    out.push({ agent, access });
  }
}
