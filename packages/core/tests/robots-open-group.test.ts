import robotsParser from "robots-parser";
import { describe, expect, it } from "vitest";
import { aiAgentAccess } from "../src/audit/checks/bot-accessibility.js";
import { BOT_TOKENS } from "../src/audit/shared/bot-tokens.js";
import { planRobotsAccessFix, robotsAccessFixSnippet } from "../src/audit/shared/robots-fix.js";
import { generateRobotsTxt } from "../src/generate/robots-txt.js";

const BASE = "https://example.com";

const OPEN_GROUP_FILES = [
  "User-agent: *\nDisallow: /\n\nUser-agent: CCBot\n",
  "User-agent: *\nDisallow: /\n\nUser-agent: *\n",
  "User-agent: GPTBot\nDisallow: /\nUser-agent: *\nDisallow: /\nUser-agent: GPTBot",
];

const agents = [...BOT_TOKENS.filter((b) => b.robotsToken).map((b) => b.token), "SomeRandomBot"];
const verdicts = (robotsTxt: string) => {
  const robots = robotsParser(`${BASE}/robots.txt`, robotsTxt);
  return agents.map((a) => [a, robots.isAllowed(`${BASE}/`, a)]);
};
const run = (robotsTxt: string) =>
  aiAgentAccess.run([], { baseUrl: BASE, robotsTxt, wellKnown: {} });

describe("robots fix advice on a file that ends in an open User-agent group", () => {
  it.each(OPEN_GROUP_FILES)("applying the snippet changes no verdict: %j", (robots) => {
    const fix = planRobotsAccessFix(robots, BASE);
    const snippet = robotsAccessFixSnippet(fix ?? { openGroup: false, named: [], groups: [] });
    expect(fix?.groups).toEqual([]);
    expect(snippet).toContain("ends in a User-agent line with no rules");
    expect(snippet).not.toMatch(/^Allow:/m);
    expect(verdicts(`${robots}\n${snippet}\n`)).toEqual(verdicts(robots));
  });

  it.each(OPEN_GROUP_FILES)("generator output adds no Allow group: %j", (robots) => {
    const out = generateRobotsTxt({
      baseUrl: BASE,
      metadata: { baseUrl: BASE, robotsTxt: robots, wellKnown: {} },
    } as Parameters<typeof generateRobotsTxt>[0]);
    expect(verdicts(out)).toEqual(verdicts(robots));
  });

  it("keeps the named-agents comment alongside the open-group line", () => {
    const robots =
      "User-agent: ChatGPT-User\nDisallow: /\nUser-agent: *\nDisallow: /\nUser-agent: ChatGPT-User";
    const snippet = robotsAccessFixSnippet(planRobotsAccessFix(robots, BASE) as never);
    expect(snippet).toContain("blocked by their own named groups");
    expect(snippet).toContain("ends in a User-agent line");
  });

  it("does not change the ai-agent-access verdict", async () => {
    const closed = "User-agent: *\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n";
    const open = "User-agent: *\nDisallow: /\n\nUser-agent: CCBot\n";
    const a = await run(closed);
    const b = await run(open);
    expect(b.status).toBe(a.status);
    expect(b.score).toBe(a.score);
    expect(b.message).toBe(a.message);
  });

  it("a closed file still gets Allow groups and no open-group line", () => {
    const robots = "User-agent: *\nDisallow: /\n";
    const snippet = robotsAccessFixSnippet(planRobotsAccessFix(robots, BASE) as never);
    expect(snippet).toContain("Allow: /");
    expect(snippet).not.toContain("ends in a User-agent line");
  });
});
