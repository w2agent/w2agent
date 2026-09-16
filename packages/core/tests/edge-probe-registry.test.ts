import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotToken } from "../src/audit/shared/bot-tokens.js";
import { BOT_TOKENS } from "../src/audit/shared/bot-tokens.js";
import type { AuditOptions } from "../src/audit/types.js";

/**
 * G3's acceptance: a new `purpose: "user"` registry entry with a `uaString` is
 * probed on the homepage with **no edit to `crawler.ts`**. `AGENT_UAS` is
 * computed at import, so the registry is mocked and the crawler re-imported.
 *
 * This file owns the module mock on its own: every test resets the module graph
 * and un-mocks the registry afterwards, so no other suite can observe it.
 */

const BOT_TOKENS_MODULE = "../src/audit/shared/bot-tokens.js";

const SYNTHETIC: BotToken = {
  vendor: "Synthetic",
  token: "Synth-User",
  purpose: "user",
  robotsToken: true,
  hasUA: true,
  uaString: "synthetic-agent/9.9 (+https://synthetic.test/bot)",
  sourceUrl: "https://synthetic.test/bot",
};

async function crawlerWith(tokens: readonly BotToken[]) {
  vi.doMock(BOT_TOKENS_MODULE, async () => ({
    ...(await vi.importActual<typeof import("../src/audit/shared/bot-tokens.js")>(
      BOT_TOKENS_MODULE,
    )),
    BOT_TOKENS: tokens,
  }));
  vi.resetModules();
  return import("../src/audit/crawler.js");
}

afterEach(() => {
  vi.doUnmock(BOT_TOKENS_MODULE);
  vi.resetModules();
  vi.restoreAllMocks();
});

const OPTIONS = {
  timeout: 5000,
  requestDelay: 0,
  userAgent: "w2agent-test/1.0",
} as AuditOptions;

describe("AGENT_UAS is derived from the registry", () => {
  it("probes a newly registered user agent on the homepage with no crawler edit", async () => {
    const { AGENT_UAS, fetchUnderUas } = await crawlerWith([...BOT_TOKENS, SYNTHETIC]);

    expect(AGENT_UAS.map((u) => u.token)).toContain("Synth-User");
    expect(AGENT_UAS.find((u) => u.token === "Synth-User")).toEqual({
      key: "synthetic",
      token: "Synth-User",
      ua: SYNTHETIC.uaString,
    });

    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push((init?.headers as Record<string, string>)?.["User-Agent"] ?? "");
      return new Response("<html>ok</html>", { status: 200 });
    });
    const { responses } = await fetchUnderUas("https://synthetic.test/", OPTIONS);

    // Not just present in the list: the fetch really went out under its UA.
    expect(sent).toContain(SYNTHETIC.uaString);
    expect(responses.synthetic).toMatchObject({ token: "Synth-User", status: 200, outcome: "ok" });
  });

  it("never probes a registry entry with no published UA string", async () => {
    const { AGENT_UAS, fetchUnderUas } = await crawlerWith(BOT_TOKENS);
    expect(AGENT_UAS.map((u) => u.token)).not.toContain("Claude-User");
    expect(AGENT_UAS.every((u) => typeof u.ua === "string" && u.ua.length > 0)).toBe(true);

    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push((init?.headers as Record<string, string>)?.["User-Agent"] ?? "");
      return new Response("<html>ok</html>", { status: 200 });
    });
    await fetchUnderUas("https://site.test/", OPTIONS);
    expect(sent.some((ua) => ua === "undefined" || ua === "")).toBe(false);
    // 6 agent UAs + the homepage control, and nothing under a Claude UA.
    expect(sent).toHaveLength(7);
  });

  it("refuses two user tokens from one vendor rather than silently overwriting one", async () => {
    // Both would map to key "openai", and the second would overwrite the first
    // in `multiUaResponses` — `reach-openai-user-agent` would then report the
    // wrong token's result.
    const clash: BotToken = {
      ...SYNTHETIC,
      vendor: "OpenAI",
      token: "ChatGPT-User-2",
    };
    await expect(crawlerWith([...BOT_TOKENS, clash])).rejects.toThrow(
      /Duplicate agent UA key openai/,
    );
  });
});
