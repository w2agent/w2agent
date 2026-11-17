import robotsParser from "robots-parser";
import { ROBOTS_TOKENS } from "../audit/shared/bot-tokens.js";
import { normalizeAgent, parseGroups } from "../audit/shared/robots-fix.js";
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
        "From robots.txt. Blocked: may not crawl the site root `/`. Partly restricted: a Disallow rule applies and no Allow rule for the same path cancels it.",
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

function aiBotAccess(robotsTxt: string, baseUrl: string): Array<{ label: string; access: Access }> {
  const origin = new URL(baseUrl).origin;
  const robots = robotsParser(`${origin}/robots.txt`, robotsTxt);
  const groups = parseGroups(robotsTxt);
  const named = new Set(groups.flatMap((g) => g.agentLines.map((a) => a.agent)));

  const rulesFor = (agent: string) => {
    const own = groups.filter((g) => g.hasRuleLine && g.agentLines.some((a) => a.agent === agent));
    const applicable =
      own.length > 0
        ? own
        : groups.filter((g) => g.hasRuleLine && g.agentLines.some((a) => a.agent === "*"));
    return applicable.flatMap((g) => g.rules);
  };

  const accessFor = (token: string): Access => {
    if (robots.isAllowed(`${origin}/`, token) === false) return "Blocked";
    const rules = rulesFor(normalizeAgent(token));
    const allows = new Set(rules.filter((r) => r.directive === "Allow").map((r) => r.value));
    const open = rules.some((r) => r.directive === "Disallow" && r.value && !allows.has(r.value));
    return open ? "Partly restricted" : "Allowed";
  };

  const rows: Array<{ label: string; access: Access }> = [];
  for (const token of ROBOTS_TOKENS) {
    if (named.has(normalizeAgent(token))) {
      rows.push({ label: `**${token}**`, access: accessFor(token) });
    }
  }
  if (named.has("*")) {
    rows.push({ label: "**All other agents (`*`)**", access: accessFor("*") });
  }
  return rows;
}
