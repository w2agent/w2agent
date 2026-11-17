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

/** Distinct Disallow values probed per applicable rule set; more than this reads as Partly restricted. */
export const MAX_DISALLOW_PROBES = 50;

function aiBotAccess(robotsTxt: string, baseUrl: string): Array<{ label: string; access: Access }> {
  const origin = new URL(baseUrl).origin;
  const robots = robotsParser(`${origin}/robots.txt`, robotsTxt);
  const groups = parseGroups(robotsTxt);
  const named = new Set(groups.flatMap((g) => g.agentLines.map((a) => a.agent)));

  const cache = new Map<string, Access>();
  const accessFor = (token: string): Access => {
    const agent = normalizeAgent(token);
    let applicable = groups.flatMap((g, i) =>
      g.agentLines.some((a) => a.agent === agent) ? [i] : [],
    );
    if (applicable.length === 0) {
      applicable = groups.flatMap((g, i) => (g.agentLines.some((a) => a.agent === "*") ? [i] : []));
    }
    const key = applicable.join(",");
    const cached = cache.get(key);
    if (cached) return cached;

    let access: Access = "Allowed";
    if (robots.isAllowed(`${origin}/`, token) === false) {
      access = "Blocked";
    } else {
      const values = new Set<string>();
      for (const i of applicable) {
        for (const rule of groups[i].rules) {
          if (rule.directive === "Disallow" && rule.value) values.add(rule.value);
        }
      }
      let probed = 0;
      for (const value of values) {
        if (probed === MAX_DISALLOW_PROBES) {
          access = "Partly restricted";
          break;
        }
        probed++;
        const path = value.replace(/[*$]/g, "");
        const url = `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
        if (
          robots.isAllowed(url, token) === false ||
          robots.isAllowed(`${url}x`, token) === false
        ) {
          access = "Partly restricted";
          break;
        }
      }
    }
    cache.set(key, access);
    return access;
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
