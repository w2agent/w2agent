import robotsParser from "robots-parser";
import { BOT_TOKENS, type BotPurpose } from "./bot-tokens.js";

export function findBlockedTokens(
  robotsTxt: string,
  baseUrl: string,
): Record<BotPurpose, string[]> {
  const robots = robotsParser(`${baseUrl}/robots.txt`, robotsTxt);
  const blocked: Record<BotPurpose, string[]> = { user: [], search: [], training: [] };
  for (const bot of BOT_TOKENS) {
    if (bot.robotsToken && robots.isAllowed(`${baseUrl}/`, bot.token) === false) {
      blocked[bot.purpose].push(bot.token);
    }
  }
  return blocked;
}

interface RobotsRule {
  directive: "Allow" | "Disallow";
  value: string;
  line: number;
}

interface RobotsGroup {
  agentLines: Array<{ agent: string; line: number }>;
  rules: RobotsRule[];
  crawlDelay?: string;
  scopedLines: number[];
}

export interface RobotsAccessFix {
  removals: Array<{ line: number; text: string }>;
  groups: string[][];
}

const LINE_BREAK = /\r\n|\r|\n/;

function normalizeAgent(agent: string): string {
  const lower = agent.toLowerCase();
  const slash = lower.indexOf("/");
  return (slash > -1 ? lower.slice(0, slash) : lower).trim();
}

function parseGroups(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;

  robotsTxt.split(LINE_BREAK).forEach((raw, i) => {
    const hash = raw.indexOf("#");
    const text = hash > -1 ? raw.slice(0, hash) : raw;
    const colon = text.indexOf(":");
    if (colon < 0) return;
    const key = text.slice(0, colon).trim().toLowerCase();
    const value = text.slice(colon + 1).trim();
    if (!key) return;

    if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agentLines: [], rules: [], scopedLines: [] };
        groups.push(current);
      }
      if (value) current.agentLines.push({ agent: normalizeAgent(value), line: i + 1 });
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (!current) return;
    if (key === "allow" || key === "disallow") {
      current.rules.push({ directive: key === "allow" ? "Allow" : "Disallow", value, line: i + 1 });
      current.scopedLines.push(i + 1);
    } else if (key === "crawl-delay") {
      current.crawlDelay = value;
      current.scopedLines.push(i + 1);
    }
  });

  return groups;
}

function blocksRoot(rule: RobotsRule, baseUrl: string): boolean {
  if (rule.directive !== "Disallow" || !rule.value) return false;
  const probe = robotsParser(`${baseUrl}/robots.txt`, `User-agent: *\nDisallow: ${rule.value}`);
  return probe.isAllowed(`${baseUrl}/`, "probe") === false;
}

export interface RobotsAccessFixOptions {
  namedBlocks?: "move" | "keep";
}

export function planRobotsAccessFix(
  robotsTxt: string,
  baseUrl: string,
  options: RobotsAccessFixOptions = {},
): RobotsAccessFix | undefined {
  const blocked = findBlockedTokens(robotsTxt, baseUrl);
  const candidates = [...blocked.user, ...blocked.search];
  if (candidates.length === 0) return undefined;

  const groups = parseGroups(robotsTxt);
  const removeLines = new Set<number>();
  const byRules = new Map<string, string[]>();
  const wildcardRules = groups.filter((g) => g.agentLines.some((a) => a.agent === "*"));

  const lastCrawlDelay = (from: RobotsGroup[]) =>
    from.filter((g) => g.crawlDelay !== undefined).pop()?.crawlDelay;

  const addGroup = (token: string, rules: RobotsRule[], crawlDelay: string | undefined) => {
    const key = [
      ...rules
        .filter((r) => r.value && r.value !== "/" && !blocksRoot(r, baseUrl))
        .map((r) => `${r.directive}: ${r.value}`),
      ...(crawlDelay !== undefined ? [`Crawl-delay: ${crawlDelay}`] : []),
      "Allow: /",
    ].join("\n");
    byRules.set(key, [...(byRules.get(key) ?? []), token]);
  };

  for (const token of candidates) {
    const agent = normalizeAgent(token);
    const naming = groups.filter((g) => g.agentLines.some((a) => a.agent === agent));
    if (options.namedBlocks === "keep" && naming.length > 0) continue;
    const owners = naming.filter((g) => g.rules.length > 0);
    if (owners.length === 0) {
      addGroup(
        token,
        wildcardRules.flatMap((g) => g.rules),
        lastCrawlDelay(wildcardRules),
      );
      continue;
    }
    for (const g of naming) {
      for (const a of g.agentLines) if (a.agent === agent) removeLines.add(a.line);
    }
    addGroup(
      token,
      owners.flatMap((g) => g.rules),
      lastCrawlDelay(naming),
    );
  }

  for (const g of groups) {
    if (g.agentLines.length > 0 && g.agentLines.every((a) => removeLines.has(a.line))) {
      for (const line of g.scopedLines) removeLines.add(line);
    }
  }

  if (byRules.size === 0) return undefined;

  const rawLines = robotsTxt.split(LINE_BREAK);
  return {
    removals: [...removeLines]
      .sort((a, b) => a - b)
      .map((line) => ({ line, text: rawLines[line - 1].trim() })),
    groups: [...byRules].map(([rules, tokens]) => [
      ...tokens.map((t) => `User-agent: ${t}`),
      ...rules.split("\n"),
    ]),
  };
}

export function applyRobotsAccessFixRemovals(robotsTxt: string, fix: RobotsAccessFix): string[] {
  const removed = new Set(fix.removals.map((r) => r.line));
  return robotsTxt.split(LINE_BREAK).filter((_, i) => !removed.has(i + 1));
}

export function describeRobotsAccessFixRemovals(fix: RobotsAccessFix): string[] {
  return fix.removals.map((r) => `#    line ${r.line}: ${r.text}`);
}

export function robotsAccessFixSnippet(fix: RobotsAccessFix): string {
  const lines = ["# Allow AI agents and search fetchers in robots.txt:"];
  if (fix.removals.length > 0) {
    lines.push(
      "# 1. Delete these lines (only the agents below move out; every other agent keeps its rules):",
      ...describeRobotsAccessFixRemovals(fix),
      "# 2. Append:",
    );
  }
  fix.groups.forEach((g, i) => {
    if (i > 0) lines.push("");
    lines.push(...g);
  });
  return lines.join("\n");
}
