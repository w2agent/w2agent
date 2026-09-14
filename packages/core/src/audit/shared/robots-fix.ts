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
  agents: string[];
  rules: RobotsRule[];
}

function normalizeAgent(agent: string): string {
  const lower = agent.toLowerCase();
  const slash = lower.indexOf("/");
  return (slash > -1 ? lower.slice(0, slash) : lower).trim();
}

function parseGroups(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;

  robotsTxt.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const hash = raw.indexOf("#");
    const text = hash > -1 ? raw.slice(0, hash) : raw;
    const colon = text.indexOf(":");
    if (colon < 0) return;
    const key = text.slice(0, colon).trim().toLowerCase();
    const value = text.slice(colon + 1).trim();
    if (!key) return;

    if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value) current.agents.push(normalizeAgent(value));
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (current && (key === "allow" || key === "disallow")) {
      current.rules.push({ directive: key === "allow" ? "Allow" : "Disallow", value, line: i + 1 });
    }
  });

  return groups;
}

function blocksRoot(rule: RobotsRule, baseUrl: string): boolean {
  if (rule.directive !== "Disallow" || !rule.value) return false;
  const probe = robotsParser(`${baseUrl}/robots.txt`, `User-agent: *\nDisallow: ${rule.value}`);
  return probe.isAllowed(`${baseUrl}/`, "probe") === false;
}

export function robotsAccessFixLines(robotsTxt: string, baseUrl: string): string[] {
  const blocked = findBlockedTokens(robotsTxt, baseUrl);
  const candidates = [...blocked.user, ...blocked.search];
  if (candidates.length === 0) return [];

  const groups = parseGroups(robotsTxt);
  const instructions: string[] = [];
  const inherited: string[] = [];

  for (const token of candidates) {
    const agent = normalizeAgent(token);
    const owners = groups.filter((g) => g.agents.includes(agent) && g.rules.length > 0);
    if (owners.length === 0) {
      inherited.push(token);
      continue;
    }
    const rootLines = owners
      .flatMap((g) => g.rules)
      .filter((r) => blocksRoot(r, baseUrl))
      .map((r) => `"Disallow: ${r.value}" (line ${r.line})`);
    instructions.push(
      `# ${token} is blocked by a group that names it (User-agent: ${token}). Remove from that group: ${rootLines.join(", ")}`,
    );
  }

  const lines = [...instructions];
  if (inherited.length > 0) {
    const wildcardRules = groups
      .filter((g) => g.agents.includes("*"))
      .flatMap((g) => g.rules)
      .filter((r) => r.value && !blocksRoot(r, baseUrl));
    lines.push(
      ...inherited.map((t) => `User-agent: ${t}`),
      ...wildcardRules.map((r) => `${r.directive}: ${r.value}`),
      "Allow: /",
    );
  }
  return lines;
}
