import { planRobotsAccessFix } from "../audit/shared/robots-fix.js";
import type { GenerateContext } from "./types.js";

const HEADER = "# --- w2agent: suggested AI bot rules ---";
const LINE_BREAK = /\r\n|\r|\n/;

export function generateRobotsTxt(ctx: GenerateContext): string {
  const existing = ctx.metadata.robotsTxt;
  const additions = planAdditions(ctx);

  if (!existing) {
    return `${additions.join("\n")}\n`;
  }
  if (additions.length === 0) {
    return existing;
  }

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(LINE_BREAK);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push("", ...additions);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return `${lines.join(eol)}${eol}`;
}

/**
 * Only the text w2agent adds to the site's robots.txt, with "\n" line endings and a trailing
 * newline; "" when there is nothing to add. Without an existing robots.txt this is the whole
 * generated file. Appending it to the existing file (after a blank line) reproduces
 * generateRobotsTxt, except for CRLF conversion.
 */
export function generateRobotsAdditions(ctx: GenerateContext): string {
  const additions = planAdditions(ctx);
  return additions.length === 0 ? "" : `${additions.join("\n")}\n`;
}

/**
 * The Allow groups w2agent would add to an existing robots.txt (one line array per group),
 * for AI agents the `*` group blocks and no User-agent line names. Never reverses a block the
 * owner wrote for a named agent. `[]` when there is no robots.txt or nothing to add.
 */
export function robotsAllowGroups(robotsTxt: string | undefined, baseUrl: string): string[][] {
  if (!robotsTxt) return [];
  return planRobotsAccessFix(robotsTxt, baseUrl, { namedBlocks: "keep" })?.groups ?? [];
}

function hasSitemap(sitemapXml: string | undefined): boolean {
  return !!sitemapXml && (sitemapXml.includes("<urlset") || sitemapXml.includes("<sitemapindex"));
}

function planAdditions(ctx: GenerateContext): string[] {
  const { metadata, baseUrl } = ctx;
  const existing = metadata.robotsTxt;
  const found = hasSitemap(metadata.sitemapXml);
  const sitemapLine = `Sitemap: ${baseUrl}/sitemap.xml`;
  const llmsLine = `# llms.txt: ${baseUrl}/llms.txt`;

  if (!existing) {
    const lines = ["User-agent: *", "Allow: /", ""];
    if (found) lines.push(sitemapLine);
    lines.push(llmsLine);
    return lines;
  }

  const content = existing.toLowerCase();
  const additions: string[] = [];

  for (const group of robotsAllowGroups(existing, baseUrl)) {
    additions.push(...group, "");
  }
  if (found && !content.includes("sitemap:")) additions.push(sitemapLine);
  if (!content.includes("llms.txt")) additions.push(llmsLine);

  while (additions.length > 0 && additions[additions.length - 1] === "") additions.pop();
  return additions.length === 0 ? additions : [HEADER, ...additions];
}
