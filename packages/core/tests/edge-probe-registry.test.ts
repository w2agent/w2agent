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
      key: "Synth-User",
      token: "Synth-User",
      ua: SYNTHETIC.uaString,
    });
    // It queues behind the scored three, which keep their positions and keys.
    expect(AGENT_UAS.slice(0, 3)).toEqual([
      { key: "openai", token: "ChatGPT-User", ua: expect.any(String) },
      { key: "perplexity", token: "Perplexity-User", ua: expect.any(String) },
      { key: "google", token: "Google-Agent", ua: expect.any(String) },
    ]);
    expect(AGENT_UAS.at(-1)?.token).toBe("Synth-User");

    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push((init?.headers as Record<string, string>)?.["User-Agent"] ?? "");
      return new Response("<html>ok</html>", { status: 200 });
    });
    const { responses } = await fetchUnderUas("https://synthetic.test/", OPTIONS);

    // Not just present in the list: the fetch really went out under its UA.
    expect(sent).toContain(SYNTHETIC.uaString);
    expect(responses["Synth-User"]).toMatchObject({
      token: "Synth-User",
      status: 200,
      outcome: "ok",
    });
    // …and the scored keys are untouched by the new arrival.
    expect(Object.keys(responses).slice(0, 3)).toEqual(["openai", "perplexity", "google"]);
  });

  it("keys a derived entry by its token, so a vendor typo cannot move a scored key", async () => {
    // `vendor` is free text. Derived from it, `"OpenAI "` would store the
    // homepage result under `"openai "` and `reach-openai-user-agent` would
    // report "no fetch was recorded" — a scored check zeroed, with no throw.
    const typo = BOT_TOKENS.map((b) =>
      b.token === "ChatGPT-User" ? { ...b, vendor: "OpenAI " } : b,
    );
    const { AGENT_UAS, fetchUnderUas } = await crawlerWith(typo);
    expect(AGENT_UAS[0]).toMatchObject({ key: "openai", token: "ChatGPT-User" });

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("<html>ok</html>", { status: 200 }),
    );
    const { responses } = await fetchUnderUas("https://site.test/", OPTIONS);
    expect(responses.openai).toMatchObject({ token: "ChatGPT-User", status: 200 });
    expect(Object.keys(responses)).not.toContain("openai ");
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

  it("adds a second token from an existing vendor without crashing the package", async () => {
    // The G3 edit must stay cheap: keying the tail by token means OpenAI's
    // second user agent gets its own slot instead of colliding with `openai`.
    const sibling: BotToken = { ...SYNTHETIC, vendor: "OpenAI", token: "ChatGPT-User-2" };
    const { AGENT_UAS } = await crawlerWith([...BOT_TOKENS, sibling]);
    expect(AGENT_UAS.map((u) => u.key)).toEqual([
      "openai",
      "perplexity",
      "google",
      "Amzn-User",
      "MistralAI-User",
      "Meta-ExternalFetcher",
      "ChatGPT-User-2",
    ]);
  });

  it("refuses to start if a pinned scored token loses its documented UA string", async () => {
    // The pinned head names tokens instead of filtering for `uaString`, so a
    // registry edit that drops one must fail loudly — probing under an empty UA
    // would make a scored check report on a request nobody documented.
    const stripped = BOT_TOKENS.map(({ uaString, ...b }) =>
      b.token === "ChatGPT-User" ? b : { ...b, uaString },
    );
    await expect(crawlerWith(stripped)).rejects.toThrow(/No documented UA string for ChatGPT-User/);
  });

  it("refuses two entries that would share one key rather than overwriting a result", async () => {
    // A duplicate registry token is the only way left to collide; the second
    // would overwrite the first in `multiUaResponses` and the check reading
    // that key would report the wrong token's result.
    const duplicate: BotToken = { ...SYNTHETIC, vendor: "Other" };
    await expect(crawlerWith([...BOT_TOKENS, SYNTHETIC, duplicate])).rejects.toThrow(
      /Duplicate agent UA key Synth-User/,
    );
  });
});
