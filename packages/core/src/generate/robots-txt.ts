import { robotsAccessFixLines } from "../audit/shared/robots-fix.js";
import type { GenerateContext } from "./types.js";

export function generateRobotsTxt(ctx: GenerateContext): string {
  const { metadata, baseUrl } = ctx;
  const existing = metadata.robotsTxt;

  if (existing) {
    return appendMissingRules(existing, baseUrl);
  }

  return generateFull(baseUrl);
}

function generateFull(baseUrl: string): string {
  const lines: string[] = [];

  lines.push("User-agent: *");
  lines.push("Allow: /");
  lines.push("");

  lines.push(`Sitemap: ${baseUrl}/sitemap.xml`);
  lines.push(`# llms.txt: ${baseUrl}/llms.txt`);
  lines.push("");

  return lines.join("\n");
}

function appendMissingRules(existing: string, baseUrl: string): string {
  const lines = existing.trimEnd().split("\n");
  const content = existing.toLowerCase();
  const additions: string[] = [];

  const accessFix = robotsAccessFixLines(existing, baseUrl);
  if (accessFix.length > 0) {
    additions.push(...accessFix);
    additions.push("");
  }

  if (!content.includes("sitemap:")) {
    additions.push(`Sitemap: ${baseUrl}/sitemap.xml`);
  }

  if (!content.includes("llms.txt")) {
    additions.push(`# llms.txt: ${baseUrl}/llms.txt`);
  }

  if (additions.length === 0) {
    return existing;
  }

  lines.push("");
  lines.push("# --- w2agent: suggested AI bot rules ---");
  lines.push(...additions);

  return `${lines.join("\n").trimEnd()}\n`;
}
