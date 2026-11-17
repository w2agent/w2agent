import { describe, expect, it } from "vitest";
import { generateAgentsMd } from "../src/generate/agents-md.js";
import type { GenerateContext } from "../src/generate/types.js";

function ctxWith(robotsTxt?: string, overrides: Partial<GenerateContext> = {}): GenerateContext {
  return {
    pages: [
      {
        url: "https://example.com/",
        title: "Example Site",
        description: "A test site",
        markdown: "Welcome.",
      },
    ],
    rawPages: [],
    metadata: { baseUrl: "https://example.com", wellKnown: {}, robotsTxt },
    baseUrl: "https://example.com",
    ...overrides,
  };
}

function permissionLines(md: string): string[] {
  const lines = md.split("\n");
  const start = lines.indexOf("## AI Bot Permissions");
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) out.push(line);
  }
  return out;
}

const rows = (robotsTxt: string) => permissionLines(generateAgentsMd(ctxWith(robotsTxt)));

describe("agents.md AI bot permissions", () => {
  it("treats consecutive User-agent lines as one group", () => {
    expect(rows("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /")).toEqual([
      "- **GPTBot**: Blocked",
      "- **ClaudeBot**: Blocked",
    ]);
  });

  it("applies rules after a blank line to the preceding User-agent (robots-parser semantics)", () => {
    expect(rows("User-agent: GPTBot\n\nDisallow: /")).toEqual(["- **GPTBot**: Blocked"]);
  });

  it("handles CRLF line endings", () => {
    expect(
      rows("User-agent: GPTBot\r\nDisallow: /\r\n\r\nUser-agent: ClaudeBot\r\nAllow: /\r\n"),
    ).toEqual(["- **GPTBot**: Blocked", "- **ClaudeBot**: Allowed"]);
  });

  it("reads versioned agent names and ignores comments", () => {
    expect(rows("User-agent: GPTBot/1.0 # main\nDisallow: / # everything")).toEqual([
      "- **GPTBot**: Blocked",
    ]);
    expect(rows("user-agent: google-extended/2\nDisallow: /")).toEqual([
      "- **Google-Extended**: Blocked",
    ]);
  });

  it("lists rows in token order, not file order", () => {
    expect(rows("User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /")).toEqual([
      "- **GPTBot**: Blocked",
      "- **ClaudeBot**: Blocked",
    ]);
  });

  it("lets a named group with only Allow override a wildcard Disallow", () => {
    expect(rows("User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /")).toEqual([
      "- **GPTBot**: Allowed",
      "- **All other agents (`*`)**: Blocked",
    ]);
  });

  it("reports a bot with no group of its own through the wildcard row only", () => {
    expect(rows("User-agent: *\nDisallow: /")).toEqual(["- **All other agents (`*`)**: Blocked"]);
  });

  it("renders the wildcard row without a run of asterisks", () => {
    const md = generateAgentsMd(ctxWith("User-agent: *\nDisallow: /private"));
    expect(md).not.toContain("*****");
    expect(md).toContain("- **All other agents (`*`)**: Partly restricted");
  });

  it("calls an agent Partly restricted when only a subpath is disallowed", () => {
    expect(rows("User-agent: GPTBot\nDisallow: /cart")).toEqual([
      "- **GPTBot**: Partly restricted",
    ]);
  });

  it("probes wildcard and end-anchored Disallow patterns", () => {
    expect(rows("User-agent: GPTBot\nDisallow: /*.pdf$")).toEqual([
      "- **GPTBot**: Partly restricted",
    ]);
  });

  it("treats an empty Disallow as Allowed", () => {
    expect(rows("User-agent: GPTBot\nDisallow:")).toEqual(["- **GPTBot**: Allowed"]);
  });

  it("lets a longer Allow reopen the root but still reports the rest as restricted", () => {
    expect(rows("User-agent: GPTBot\nDisallow: /\nAllow: /$")).toEqual([
      "- **GPTBot**: Partly restricted",
    ]);
  });

  it("uses the longest match: Allow under a Disallowed directory is still Partly restricted", () => {
    expect(rows("User-agent: GPTBot\nDisallow: /docs\nAllow: /docs/public")).toEqual([
      "- **GPTBot**: Partly restricted",
    ]);
  });

  it("scopes Disallow rules to their own group", () => {
    expect(rows("User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /")).toEqual([
      "- **GPTBot**: Allowed",
      "- **ClaudeBot**: Blocked",
    ]);
  });

  it("explains the three values in one line under the heading", () => {
    const md = generateAgentsMd(ctxWith("User-agent: GPTBot\nDisallow: /"));
    expect(md).toContain(
      "## AI Bot Permissions\n\nFrom robots.txt. Blocked: may not crawl the site root `/`. Partly restricted: some paths disallowed.\n\n- **GPTBot**: Blocked",
    );
  });

  it("omits the section when no listed agent and no wildcard is named", () => {
    expect(generateAgentsMd(ctxWith("User-agent: SomeOtherBot\nDisallow: /"))).not.toContain(
      "AI Bot Permissions",
    );
    expect(generateAgentsMd(ctxWith())).not.toContain("AI Bot Permissions");
  });

  it("uses the origin of a base URL that has a path", () => {
    const ctx = ctxWith("User-agent: GPTBot\nDisallow: /", { baseUrl: "https://example.com/blog" });
    expect(permissionLines(generateAgentsMd(ctx))).toEqual(["- **GPTBot**: Blocked"]);
  });
});

describe("agents.md hostile text", () => {
  const hostile = ctxWith(undefined, {
    pages: [
      {
        url: "https://example.com/",
        title: "Evil\n# Injected heading",
        description: "desc\n## Also",
        markdown: "x",
      },
      {
        url: "https://example.com/a b",
        title: "A ](http://evil.example/) [x",
        description: "line\n# H",
        markdown: "x",
      },
    ],
  });

  it("adds no heading lines beyond the fixed ones", () => {
    const md = generateAgentsMd(hostile);
    const headings = md.split("\n").filter((l) => l.startsWith("#"));
    expect(headings).toEqual([
      "# Evil # Injected heading",
      "## Overview",
      "## Capabilities",
      "## Authentication",
      "## Key Pages",
    ]);
  });

  it("keeps the description on one quote line", () => {
    const md = generateAgentsMd(hostile);
    expect(md.split("\n").filter((l) => l.startsWith(">"))).toEqual(["> desc ## Also"]);
  });

  it("writes each Key Pages bullet as one escaped line", () => {
    const md = generateAgentsMd(hostile);
    const bullets = md
      .slice(md.indexOf("## Key Pages"))
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(bullets).toEqual([
      "- [Evil # Injected heading](https://example.com/): desc ## Also",
      "- [A \\](http://evil.example/) \\[x](https://example.com/a%20b): line # H",
    ]);
  });
});
