import robotsParser from "robots-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROBOTS_TOKENS } from "../src/audit/shared/bot-tokens.js";
import { generateAgentsMd, MAX_DISALLOW_PROBES } from "../src/generate/agents-md.js";
import type { GenerateContext } from "../src/generate/types.js";

function ctxWith(robotsTxt: string): GenerateContext {
  return {
    pages: [{ url: "https://example.com/", title: "E", description: "d", markdown: "x" }],
    rawPages: [],
    metadata: { baseUrl: "https://example.com", wellKnown: {}, robotsTxt },
    baseUrl: "https://example.com",
  };
}

const proto = Object.getPrototypeOf(robotsParser("https://example.com/robots.txt", ""));

function run(robotsTxt: string): { md: string; calls: number } {
  const spy = vi.spyOn(proto, "isAllowed");
  const md = generateAgentsMd(ctxWith(robotsTxt));
  return { md, calls: spy.mock.calls.length };
}

const allAgents = [...ROBOTS_TOKENS, "*"].map((a) => `User-agent: ${a}`);
const pairs = (n: number) =>
  Array.from({ length: n }, (_, i) => [`Disallow: /p${i}`, `Allow: /p${i}`]).flat();

afterEach(() => vi.restoreAllMocks());

describe("agents.md robots.txt probe cost", () => {
  it("does not probe Disallow lines of groups that do not apply to a listed agent", () => {
    const lines = [...allAgents, "Allow: /", "", "User-agent: SomeOtherBot"];
    for (let i = 0; i < 50_000; i++) lines.push(`Disallow: /p${i}/*x$`);
    const { md, calls } = run(lines.join("\n"));
    expect(calls).toBe(1);
    expect(md).toContain("- **GPTBot**: Allowed");
    expect(md).toContain("- **All other agents (`*`)**: Allowed");
  });

  it("probes at most the cap per rule set when Allow ties override every Disallow", () => {
    const { md, calls } = run(["User-agent: GPTBot", ...pairs(5000)].join("\n"));
    expect(calls).toBeLessThanOrEqual(1 + 2 * MAX_DISALLOW_PROBES);
    expect(md).toContain("- **GPTBot**: Partly restricted");
  });

  it("reads exactly the cap's worth of overridden Disallow values as Allowed", () => {
    const at = run(["User-agent: GPTBot", ...pairs(MAX_DISALLOW_PROBES)].join("\n"));
    expect(at.md).toContain("- **GPTBot**: Allowed");
    const over = run(["User-agent: GPTBot", ...pairs(MAX_DISALLOW_PROBES + 1)].join("\n"));
    expect(over.md).toContain("- **GPTBot**: Partly restricted");
  });

  it("computes access once for agents that share a group", () => {
    const { calls } = run([...allAgents, ...pairs(MAX_DISALLOW_PROBES)].join("\n"));
    expect(calls).toBe(1 + 2 * MAX_DISALLOW_PROBES);
  });

  it("probes a repeated Disallow value once", () => {
    const { md, calls } = run(
      ["User-agent: GPTBot", ...Array(2000).fill("Disallow: /cart\nAllow: /cart")].join("\n"),
    );
    expect(calls).toBe(3);
    expect(md).toContain("- **GPTBot**: Allowed");
  });

  it("does not apply wildcard Disallow values to an agent with its own group", () => {
    const { md } = run("User-agent: *\nDisallow: /cart\n\nUser-agent: GPTBot\nAllow: /");
    expect(md).toContain("- **GPTBot**: Allowed");
    expect(md).toContain("- **All other agents (`*`)**: Partly restricted");
  });

  it("merges rules of every group that names the agent", () => {
    const { md } = run("User-agent: GPTBot\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /cart");
    expect(md).toContain("- **GPTBot**: Partly restricted");
  });
});
