import type { EcommerceArtifacts } from "./ecommerce.js";
import { extractSiteInfo } from "./llms-txt.js";
import type { LocalBusinessArtifacts } from "./local-business.js";
import { detectTools } from "./mcp-server.js";
import type { GenerateContext } from "./types.js";

export interface SkillMdOptions {
  mcpEndpoint?: string;
  artifacts?: EcommerceArtifacts | null;
  localBusinessArtifacts?: LocalBusinessArtifacts | null;
}

export function generateSkillMd(ctx: GenerateContext, options?: SkillMdOptions): string {
  const { siteName, siteDescription } = extractSiteInfo(ctx.pages, ctx.baseUrl);
  const detected = detectTools(ctx, options?.artifacts, options?.localBusinessArtifacts);
  const slug = hostnameToSlug(ctx.baseUrl);
  const endpoint = options?.mcpEndpoint || "http://localhost:3100/mcp";
  const hasExplicitEndpoint = !!options?.mcpEndpoint;

  const lines: string[] = [];

  // YAML frontmatter
  const escapedDesc = buildDescription(siteName, siteDescription, detected.tools.length);
  lines.push("---");
  lines.push(`name: ${slug}-agent`);
  lines.push(`description: "${escapedDesc}"`);
  lines.push("---");
  lines.push("");

  // Site overview
  lines.push(`# ${siteName} Agent Skill`);
  lines.push("");
  lines.push("## Site Overview");
  lines.push(`- Site: ${ctx.baseUrl}`);
  lines.push(`- Pages indexed: ${ctx.pages.length}`);
  if (siteDescription) {
    lines.push(`- Description: ${siteDescription}`);
  }
  lines.push("");

  // MCP server connection
  lines.push("## MCP Server Connection");
  lines.push("");
  if (!hasExplicitEndpoint) {
    lines.push("<!-- TODO: Replace with your deployed MCP endpoint -->");
  }
  lines.push("```json");
  lines.push(JSON.stringify({ url: endpoint }, null, 2));
  lines.push("```");
  lines.push("");

  // Available tools
  lines.push("## Available Tools");
  lines.push("");
  for (const tool of detected.tools) {
    lines.push(`### \`${tool.name}\``);
    lines.push(tool.description);
    lines.push("");
  }

  // Key content areas
  const keyPages = ctx.pages.slice(0, 20);
  if (keyPages.length > 0) {
    lines.push("## Key Content Areas");
    lines.push("");
    for (const page of keyPages) {
      const desc = page.description ? `: ${page.description}` : "";
      const title = page.title || page.url;
      lines.push(`- [${title}](${page.url})${desc}`);
    }
    lines.push("");
  }

  // Usage instructions
  lines.push("## Usage Instructions");
  lines.push("");
  lines.push(
    `Use this skill when the user asks about ${siteName} or needs information from ${ctx.baseUrl}.`,
  );
  lines.push("");
  lines.push("Workflow:");
  lines.push("1. Connect to the MCP server using the configuration above");
  lines.push("2. Use `list-pages` to see available content");
  lines.push("3. Use `search-site` to find relevant pages by keyword");
  lines.push("4. Use `get-page` to retrieve full content for specific pages");
  if (detected.hasFaq) {
    lines.push("5. Use `search-faq` for question/answer lookups");
  }
  lines.push("");

  return lines.join("\n");
}

function hostnameToSlug(baseUrl: string): string {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname.replace(/\./g, "-");
  } catch {
    return "site";
  }
}

function buildDescription(siteName: string, siteDescription: string, toolCount: number): string {
  const base = `Use when user asks about ${siteName}. Provides ${toolCount} MCP tools for site content and search.`;
  const desc = siteDescription ? ` ${siteDescription}` : "";
  const full = base + desc;
  return full.replace(/"/g, '\\"');
}
