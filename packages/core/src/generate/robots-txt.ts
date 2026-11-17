import { endsInOpenGroup, planRobotsAccessFix } from "../audit/shared/robots-fix.js";
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
 * The Allow groups w2agent would add to an existing robots.txt (one line array per group),
 * for AI agents the `*` group blocks and no User-agent line names. Never reverses a block the
 * owner wrote for a named agent. `[]` when there is no robots.txt or nothing to add, and when
 * the file ends in a `User-agent` line with no rules (appended agents would join that group).
 */
export function robotsAllowGroups(robotsTxt: string | undefined, baseUrl: string): string[][] {
  if (!robotsTxt || endsInOpenGroup(robotsTxt)) return [];
  return planRobotsAccessFix(robotsTxt, baseUrl)?.groups ?? [];
}

const SITEMAP_ROOT = /^<(?:urlset|sitemapindex)[\s>/]/;

// The root element must be urlset or sitemapindex, after only whitespace, processing
// instructions (the XML declaration) and comments. Linear scan: crawled input is untrusted.
function hasSitemap(sitemapXml: string | undefined): boolean {
  if (!sitemapXml) return false;
  let i = 0;
  while (i < sitemapXml.length) {
    if (/\s/.test(sitemapXml[i])) {
      i++;
      continue;
    }
    const close = sitemapXml.startsWith("<?", i)
      ? "?>"
      : sitemapXml.startsWith("<!--", i)
        ? "-->"
        : undefined;
    if (!close) break;
    const end = sitemapXml.indexOf(close, i + 2);
    if (end < 0) return false;
    i = end + close.length;
  }
  return SITEMAP_ROOT.test(sitemapXml.slice(i, i + 16));
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
