import {
  applyRobotsAccessFixRemovals,
  describeRobotsAccessFixRemovals,
  planRobotsAccessFix,
} from "../audit/shared/robots-fix.js";
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
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const content = existing.toLowerCase();
  const fix = planRobotsAccessFix(existing, baseUrl);
  const lines = fix ? applyRobotsAccessFixRemovals(existing, fix) : existing.split(/\r\n|\r|\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const additions: string[] = [];

  if (fix) {
    if (fix.removals.length > 0) {
      additions.push("# Moved out of their original groups (other agents keep their rules):");
      additions.push(...describeRobotsAccessFixRemovals(fix));
    }
    for (const group of fix.groups) {
      additions.push(...group);
      additions.push("");
    }
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

  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return `${lines.join(eol)}${eol}`;
}
