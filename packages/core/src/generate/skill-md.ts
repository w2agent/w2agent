import type { EcommerceArtifacts } from "./ecommerce.js";
import { extractSiteInfo, urlToTitle } from "./llms-txt.js";
import type { LocalBusinessArtifacts } from "./local-business.js";
import { mdDescription, mdLine, mdText, mdUrl, oneLine, yamlScalar } from "./markdown-text.js";
import { detectTools } from "./mcp-server.js";
import type { GenerateContext, PageMarkdown } from "./types.js";

export interface SkillMdOptions {
  mcpEndpoint?: string;
  artifacts?: EcommerceArtifacts | null;
  localBusinessArtifacts?: LocalBusinessArtifacts | null;
}

const NAME_SUFFIX = "-agent";
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;

/** Agent Skills name: `[a-z0-9]+(-[a-z0-9]+)*`, at most 64 characters; also the install directory. */
export function skillName(baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    host = "";
  }
  let slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  slug = slug.slice(0, NAME_MAX - NAME_SUFFIX.length).replace(/-+$/, "");
  return `${slug || "site"}${NAME_SUFFIX}`;
}

/** One-line description of at most 1024 code points, with no lone surrogates. */
export function capDescription(value: string): string {
  const clean = oneLine(value).replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
  return Array.from(clean).slice(0, DESCRIPTION_MAX).join("").trimEnd();
}

/**
 * `yamlScalar` for frontmatter. The Agent Skills reference parser finds the frontmatter by
 * splitting on the first two raw `---` substrings, so hyphens in a run of three or more are
 * written as `-` escapes, which a YAML parser reads back as the same text.
 */
export function skillYamlScalar(value: string): string {
  return yamlScalar(value).replace(/-{3,}/g, (run) => "\\u002d".repeat(run.length));
}

/** One Key Content Areas bullet, escaped like `generateLlmsTxt`. */
export function keyContentLine(page: PageMarkdown): string {
  const title = mdText(page.title) || mdText(urlToTitle(page.url));
  const link = `- [${title}](${mdUrl(page.url)})`;
  const desc = mdDescription(page.description);
  return desc ? `${link}: ${desc}` : link;
}

export function generateSkillMd(ctx: GenerateContext, options?: SkillMdOptions): string {
  const { siteName, siteDescription } = extractSiteInfo(ctx.pages, ctx.baseUrl);
  const detected = detectTools(ctx, options?.artifacts, options?.localBusinessArtifacts);
  const endpoint = options?.mcpEndpoint || "http://localhost:3100/mcp";
  const hasExplicitEndpoint = !!options?.mcpEndpoint;
  const displayName = mdDescription(siteName);

  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`name: ${skillName(ctx.baseUrl)}`);
  lines.push(
    `description: ${skillYamlScalar(capDescription(buildDescription(siteName, siteDescription, detected.tools.length)))}`,
  );
  lines.push("---");
  lines.push("");

  // Site overview
  lines.push(`# ${displayName} Agent Skill`);
  lines.push("");
  lines.push("## Site Overview");
  lines.push(`- Site: ${ctx.baseUrl}`);
  lines.push(`- Pages indexed: ${ctx.pages.length}`);
  if (siteDescription) {
    lines.push(`- Description: ${mdDescription(siteDescription)}`);
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
    lines.push(mdLine(tool.description));
    lines.push("");
  }

  // Key content areas
  const keyPages = ctx.pages.slice(0, 20);
  if (keyPages.length > 0) {
    lines.push("## Key Content Areas");
    lines.push("");
    for (const page of keyPages) {
      lines.push(keyContentLine(page));
    }
    lines.push("");
  }

  // Usage instructions
  lines.push("## Usage Instructions");
  lines.push("");
  lines.push(
    `Use this skill when the user asks about ${displayName} or needs information from ${ctx.baseUrl}.`,
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

function buildDescription(siteName: string, siteDescription: string, toolCount: number): string {
  const base = `Use when user asks about ${siteName}. Provides ${toolCount} MCP tools for site content and search.`;
  const desc = siteDescription ? ` ${siteDescription}` : "";
  return base + desc;
}
