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

export interface RobotsRule {
  directive: "Allow" | "Disallow";
  value: string;
}

export interface RobotsGroup {
  agentLines: Array<{ agent: string }>;
  rules: RobotsRule[];
  crawlDelay?: string;
}

export interface RobotsAccessFix {
  openGroup: boolean;
  named: string[];
  groups: string[][];
}

const LINE_BREAK = /\r\n|\r|\n/;

export function normalizeAgent(agent: string): string {
  const lower = agent.toLowerCase();
  const slash = lower.indexOf("/");
  return (slash > -1 ? lower.slice(0, slash) : lower).trim();
}

export function parseGroups(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;

  for (const raw of robotsTxt.split(LINE_BREAK)) {
    const hash = raw.indexOf("#");
    const text = hash > -1 ? raw.slice(0, hash) : raw;
    const colon = text.indexOf(":");
    if (colon < 0) continue;
    const key = text.slice(0, colon).trim().toLowerCase();
    const value = text.slice(colon + 1).trim();
    if (!key) continue;

    if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agentLines: [], rules: [] };
        groups.push(current);
      }
      if (value) current.agentLines.push({ agent: normalizeAgent(value) });
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      current.rules.push({ directive: key === "allow" ? "Allow" : "Disallow", value });
    } else if (key === "crawl-delay" && value) {
      current.crawlDelay = value;
    }
  }

  return groups;
}

/**
 * True when no Allow/Disallow follows the last `User-agent` line: agents appended after it could
 * join that run. This is the stricter of robots-parser (any keyed line ends a run) and Google
 * (only Allow/Disallow ends a run), so it bails whenever either parser would join them.
 */
export function endsInOpenGroup(robotsTxt: string): boolean {
  let open = false;
  for (const raw of robotsTxt.split(LINE_BREAK)) {
    const hash = raw.indexOf("#");
    const text = hash > -1 ? raw.slice(0, hash) : raw;
    const colon = text.indexOf(":");
    if (colon < 0) continue;
    const key = text.slice(0, colon).trim().toLowerCase();
    if (key === "user-agent") open = true;
    else if (key === "allow" || key === "disallow") open = false;
  }
  return open;
}

function blocksRoot(rule: RobotsRule, baseUrl: string): boolean {
  if (rule.directive !== "Disallow" || !rule.value) return false;
  const probe = robotsParser(`${baseUrl}/robots.txt`, `User-agent: *\nDisallow: ${rule.value}`);
  return probe.isAllowed(`${baseUrl}/`, "probe") === false;
}

export function planRobotsAccessFix(
  robotsTxt: string,
  baseUrl: string,
): RobotsAccessFix | undefined {
  const blocked = findBlockedTokens(robotsTxt, baseUrl);
  const candidates = [...blocked.user, ...blocked.search];
  if (candidates.length === 0) return undefined;

  const groups = parseGroups(robotsTxt);
  const byRules = new Map<string, string[]>();
  const named: string[] = [];
  const wildcardRules = groups.filter((g) => g.agentLines.some((a) => a.agent === "*"));
  const wildcardRuleList = wildcardRules.flatMap((g) => g.rules);
  const wildcardCrawlDelay = wildcardRules.filter((g) => g.crawlDelay).pop()?.crawlDelay;

  const key = [
    ...wildcardRuleList
      .filter((r) => r.value && r.value !== "/" && !blocksRoot(r, baseUrl))
      .map((r) => `${r.directive}: ${r.value}`),
    ...(wildcardCrawlDelay !== undefined ? [`Crawl-delay: ${wildcardCrawlDelay}`] : []),
    "Allow: /",
  ].join("\n");

  for (const token of candidates) {
    const agent = normalizeAgent(token);
    if (groups.some((g) => g.agentLines.some((a) => a.agent === agent))) {
      named.push(token);
      continue;
    }
    byRules.set(key, [...(byRules.get(key) ?? []), token]);
  }

  const openGroup = endsInOpenGroup(robotsTxt);
  return {
    openGroup,
    named,
    groups: openGroup
      ? []
      : [...byRules].map(([rules, tokens]) => [
          ...tokens.map((t) => `User-agent: ${t}`),
          ...rules.split("\n"),
        ]),
  };
}

export function robotsAccessFixSnippet(fix: RobotsAccessFix): string {
  const lines: string[] = [];
  if (fix.openGroup) {
    lines.push(
      "# robots.txt ends in a User-agent line with no rules, so appended groups would join it; add that group's rules (or remove the line) before adding Allow groups",
    );
  }
  if (fix.groups.length > 0) {
    lines.push(
      '# These AI agents are blocked only by the "User-agent: *" group; append these groups to allow them:',
    );
  }
  if (fix.named.length > 0) {
    lines.push(
      `# Left as is, blocked by their own named groups (edit those groups only if the block is unintended): ${fix.named.join(", ")}`,
    );
  }
  fix.groups.forEach((g, i) => {
    if (i > 0) lines.push("");
    lines.push(...g);
  });
  return lines.join("\n");
}
