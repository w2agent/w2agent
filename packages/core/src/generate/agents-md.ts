import robotsParser from "robots-parser";
import { ROBOTS_TOKENS } from "../audit/shared/bot-tokens.js";
import { extractSiteInfo } from "./llms-txt.js";
import { mdDescription } from "./markdown-text.js";
import { keyContentLine } from "./skill-md.js";
import type { GenerateContext } from "./types.js";

export function generateAgentsMd(ctx: GenerateContext): string {
  const { siteName, siteDescription } = extractSiteInfo(ctx.pages, ctx.baseUrl);
  const lines: string[] = [];

  lines.push(`# ${mdDescription(siteName)}`);
  lines.push("");
  const description = mdDescription(siteDescription);
  if (description) {
    lines.push(`> ${description}`);
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
    const rows = aiBotAccess(robotsTxt, ctx.baseUrl);
    if (rows.length > 0) {
      lines.push("## AI Bot Permissions");
      lines.push("");
      lines.push(
        "From robots.txt. Blocked: may not crawl the site root `/`. Partly restricted: some paths disallowed.",
      );
      lines.push("");
      for (const row of rows) {
        lines.push(`- ${row.label}: ${row.access}`);
      }
      lines.push("");
    }
  }

  const keyPages = ctx.pages.slice(0, 15);
  if (keyPages.length > 0) {
    lines.push("## Key Pages");
    lines.push("");
    for (const page of keyPages) {
      lines.push(keyContentLine(page));
    }
    lines.push("");
  }

  return lines.join("\n");
}

type Access = "Blocked" | "Partly restricted" | "Allowed";

function parseRobotsLines(robotsTxt: string): { agents: Set<string>; disallows: string[] } {
  const agents = new Set<string>();
  const disallows: string[] = [];
  for (const raw of robotsTxt.split(/\r\n|\r|\n/)) {
    const hash = raw.indexOf("#");
    const text = hash > -1 ? raw.slice(0, hash) : raw;
    const colon = text.indexOf(":");
    if (colon < 0) continue;
    const key = text.slice(0, colon).trim().toLowerCase();
    const value = text.slice(colon + 1).trim();
    if (key === "user-agent") {
      const lower = value.toLowerCase();
      const slash = lower.indexOf("/");
      agents.add((slash > -1 ? lower.slice(0, slash) : lower).trim());
    } else if (key === "disallow" && value) {
      disallows.push(value);
    }
  }
  return { agents, disallows };
}

function aiBotAccess(robotsTxt: string, baseUrl: string): Array<{ label: string; access: Access }> {
  const origin = new URL(baseUrl).origin;
  const robots = robotsParser(`${origin}/robots.txt`, robotsTxt);
  const { agents, disallows } = parseRobotsLines(robotsTxt);
  const probes = disallows.flatMap((d) => {
    const path = d.replace(/[*$]/g, "");
    const url = `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
    return [url, `${url}x`];
  });

  const accessFor = (agent: string): Access => {
    if (robots.isAllowed(`${origin}/`, agent) === false) return "Blocked";
    if (probes.some((url) => robots.isAllowed(url, agent) === false)) return "Partly restricted";
    return "Allowed";
  };

  const rows: Array<{ label: string; access: Access }> = [];
  for (const token of ROBOTS_TOKENS) {
    if (agents.has(token.toLowerCase())) {
      rows.push({ label: `**${token}**`, access: accessFor(token) });
    }
  }
  if (agents.has("*")) {
    rows.push({ label: "**All other agents (`*`)**", access: accessFor("*") });
  }
  return rows;
}
