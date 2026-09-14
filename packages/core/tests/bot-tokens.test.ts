import { describe, expect, it } from "vitest";
import { BOT_TOKENS, ROBOTS_TOKENS } from "../src/audit/shared/bot-tokens.js";

// The table is copied from vendor docs; these invariants catch mis-pastes and
// reintroduced delisted tokens before they reach scoring or the robots generator.
describe("BOT_TOKENS table", () => {
  it("every entry cites an https vendor doc and a known purpose", () => {
    for (const bot of BOT_TOKENS) {
      expect(bot.sourceUrl, bot.token).toMatch(/^https:\/\//);
      expect(["user", "search", "training"], bot.token).toContain(bot.purpose);
    }
  });

  it("a published UA string implies hasUA and contains its own token", () => {
    for (const bot of BOT_TOKENS.filter((b) => b.uaString !== undefined)) {
      expect(bot.hasUA, bot.token).toBe(true);
      expect(bot.uaString?.toLowerCase(), bot.token).toContain(bot.token.toLowerCase());
    }
  });

  it("tokens are unique case-insensitively (robots.txt matching is case-insensitive)", () => {
    const lower = BOT_TOKENS.map((b) => b.token.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it("excludes tokens no vendor currently documents", () => {
    const lower = BOT_TOKENS.map((b) => b.token.toLowerCase());
    for (const stale of [
      "bytespider",
      "deepseekbot",
      "deepseek",
      "cohere-ai",
      "claude-web",
      "anthropic-ai",
    ]) {
      expect(lower).not.toContain(stale);
    }
  });

  it("Google-Agent has no robots.txt token and is excluded from ROBOTS_TOKENS", () => {
    const googleAgent = BOT_TOKENS.find((b) => b.token === "Google-Agent");
    expect(googleAgent).toMatchObject({ purpose: "user", robotsToken: false });
    expect(ROBOTS_TOKENS).not.toContain("Google-Agent");
    expect(BOT_TOKENS.filter((b) => !b.robotsToken).map((b) => b.token)).toEqual(["Google-Agent"]);
  });

  it("covers every purpose tier so the ai-agent-access check can grade each", () => {
    for (const purpose of ["user", "search", "training"] as const) {
      expect(BOT_TOKENS.some((b) => b.purpose === purpose && b.robotsToken)).toBe(true);
    }
  });
});
