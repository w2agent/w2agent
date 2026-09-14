import { afterEach, describe, expect, it, vi } from "vitest";
import { aiAgentAccess } from "../src/audit/checks/bot-accessibility.js";
import { probeSiteMetadata } from "../src/audit/crawler.js";
import { DEFAULT_OPTIONS } from "../src/audit/types.js";

const SITE = "https://example.com";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function probeWithRobots(respond: () => Response) {
  vi.useFakeTimers();
  let robotsHits = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/robots.txt") {
      robotsHits++;
      return respond();
    }
    return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
  });
  const promise = probeSiteMetadata(SITE, {
    ...DEFAULT_OPTIONS,
    maxPages: 1,
    requestDelay: 0,
    timeout: 1000,
  });
  await vi.runAllTimersAsync();
  return { metadata: await promise, robotsHits };
}

describe("robots.txt fetch status through the real fetcher", () => {
  // RFC 9309 §2.3.1.4: a server that keeps answering 5xx is unreachable, not unmeasured.
  it("records a 503 that persists through every retry as 503, which ai-agent-access fails", async () => {
    const { metadata, robotsHits } = await probeWithRobots(() => new Response("", { status: 503 }));
    expect(robotsHits).toBe(4);
    expect(metadata.robotsTxt).toBeUndefined();
    expect(metadata.robotsTxtStatus).toBe(503);
    expect(aiAgentAccess.run([], metadata)).toMatchObject({ status: "fail", score: 0 });
  });

  // A 429 is not RFC 9309's "unavailable" 4xx: the auditor was rate-limited and never saw the file.
  it("records a persistent 429 as 429, which ai-agent-access reports as unmeasured", async () => {
    const { metadata, robotsHits } = await probeWithRobots(() => new Response("", { status: 429 }));
    expect(robotsHits).toBe(4);
    expect(metadata.robotsTxtStatus).toBe(429);
    expect(aiAgentAccess.run([], metadata)).toMatchObject({ status: "error", score: 0 });
  });

  it("still passes a genuine 404 (no robots.txt)", async () => {
    const { metadata } = await probeWithRobots(() => new Response("", { status: 404 }));
    expect(metadata.robotsTxtStatus).toBe(404);
    expect(aiAgentAccess.run([], metadata)).toMatchObject({ status: "pass", score: 100 });
  });

  it("records 0 when robots.txt never answers", async () => {
    const { metadata } = await probeWithRobots(() => {
      throw new TypeError("ECONNREFUSED");
    });
    expect(metadata.robotsTxtStatus).toBe(0);
    expect(aiAgentAccess.run([], metadata).status).toBe("error");
  });
});
