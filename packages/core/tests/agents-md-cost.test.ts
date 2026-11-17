import robotsParser from "robots-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROBOTS_TOKENS } from "../src/audit/shared/bot-tokens.js";
import { generateAgentsMd } from "../src/generate/agents-md.js";
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

function run(robotsTxt: string): { md: string; calls: number; ms: number } {
  const spy = vi.spyOn(proto, "isAllowed");
  const start = performance.now();
  const md = generateAgentsMd(ctxWith(robotsTxt));
  const ms = performance.now() - start;
  return { md, calls: spy.mock.calls.length, ms };
}

const allAgents = [...ROBOTS_TOKENS, "*"].map((a) => `User-agent: ${a}`);
const pairs = (n: number) =>
  Array.from({ length: n }, (_, i) => [`Disallow: /p${i}`, `Allow: /p${i}`]).flat();

afterEach(() => vi.restoreAllMocks());

describe("agents.md robots.txt cost", () => {
  it("handles one very long wildcard Disallow quickly", () => {
    const { md, ms } = run(`User-agent: GPTBot\nDisallow: /${"*a".repeat(80_000)}`);
    expect(ms).toBeLessThan(500);
    expect(md).toContain("- **GPTBot**: Partly restricted");
  });

  it("handles a 1 MB file of Disallow lines in an unrelated group quickly, with no path probing", () => {
    const lines = [...allAgents, "Allow: /", "", "User-agent: SomeOtherBot"];
    for (let i = 0; i < 50_000; i++) lines.push(`Disallow: /p${i}/*x$`);
    const { md, calls, ms } = run(lines.join("\n"));
    expect(ms).toBeLessThan(500);
    expect(calls).toBe(ROBOTS_TOKENS.length + 1);
    expect(md).toContain("- **GPTBot**: Allowed");
    expect(md).toContain("- **All other agents (`*`)**: Allowed");
  });

  it("handles a 1 MB group of Disallow lines for a listed agent quickly", () => {
    const lines = ["User-agent: GPTBot"];
    for (let i = 0; i < 50_000; i++) lines.push(`Disallow: /p${i}/*x$`);
    const { md, ms } = run(lines.join("\n"));
    expect(ms).toBeLessThan(500);
    expect(md).toContain("- **GPTBot**: Partly restricted");
  });
});

describe("agents.md rule set selection (robots-parser semantics)", () => {
  const out = (robotsTxt: string) => run(robotsTxt).md;

  it("falls back to * for a named group with no rule line", () => {
    const md = out("User-agent: *\nDisallow: /cart\nUser-agent: GPTBot");
    expect(md).toContain("- **GPTBot**: Partly restricted");
    expect(md).toContain("- **All other agents (`*`)**: Partly restricted");
  });

  it("falls back to * when the named group has only a Sitemap line", () => {
    const md = out(
      "User-agent: GPTBot\nSitemap: https://example.com/s.xml\n\nUser-agent: *\nDisallow: /private",
    );
    expect(md).toContain("- **GPTBot**: Partly restricted");
    expect(md).toContain("- **All other agents (`*`)**: Partly restricted");
  });

  it("falls back to a * group that blocks the root", () => {
    const md = out("User-agent: *\nDisallow: /\nUser-agent: GPTBot");
    expect(md).toContain("- **GPTBot**: Blocked");
    expect(md).toContain("- **All other agents (`*`)**: Blocked");
  });

  it("uses the named group when it has an empty Disallow", () => {
    const md = out("User-agent: *\nDisallow: /private\n\nUser-agent: GPTBot\nDisallow:");
    expect(md).toContain("- **GPTBot**: Allowed");
    expect(md).toContain("- **All other agents (`*`)**: Partly restricted");
  });

  it("uses the named group when it has only a Crawl-delay", () => {
    const md = out("User-agent: *\nDisallow: /private\n\nUser-agent: GPTBot\nCrawl-delay: 5");
    expect(md).toContain("- **GPTBot**: Allowed");
  });

  it("uses the named group when its Crawl-delay is empty or not a number", () => {
    for (const delay of ["Crawl-delay:", "Crawl-delay: soon"]) {
      const md = out(`User-agent: *\nDisallow: /private\n\nUser-agent: GPTBot\n${delay}`);
      expect(md).toContain("- **GPTBot**: Allowed");
    }
  });

  it("does not apply wildcard Disallow values to an agent with its own group", () => {
    const md = out("User-agent: *\nDisallow: /cart\n\nUser-agent: GPTBot\nAllow: /");
    expect(md).toContain("- **GPTBot**: Allowed");
    expect(md).toContain("- **All other agents (`*`)**: Partly restricted");
  });

  it("merges rules of every group that names the agent", () => {
    const md = out("User-agent: GPTBot\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /cart");
    expect(md).toContain("- **GPTBot**: Partly restricted");
  });

  it("keeps a Disallow when the Allow exceptions are different paths", () => {
    const md = out("User-agent: GPTBot\nDisallow: /private\nAllow: /private$\nAllow: /privatex$");
    expect(md).toContain("- **GPTBot**: Partly restricted");
  });

  it("does not let an Allow for a longer path cancel a Disallow", () => {
    const md = out("User-agent: GPTBot\nDisallow: /private\nAllow: /private/");
    expect(md).toContain("- **GPTBot**: Partly restricted");
  });

  it("lets an Allow for the identical path cancel a Disallow", () => {
    expect(out("User-agent: GPTBot\nDisallow: /private\nAllow: /private")).toContain(
      "- **GPTBot**: Allowed",
    );
  });

  it("does not invent a restriction from many cancelled Disallow lines", () => {
    expect(out(["User-agent: GPTBot", ...pairs(51)].join("\n"))).toContain("- **GPTBot**: Allowed");
  });
});
