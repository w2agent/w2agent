import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  llmsTxtExists,
  llmsTxtValid,
  markdownAlternate,
  wellKnownAgentCard,
  wellKnownAgentsJson,
} from "../../src/audit/checks/discovery.js";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

const basePage: FetchedPage = {
  url: "https://example.com",
  status: 200,
  html: "<html><body>test</body></html>",
  headers: {},
  responseTime: 100,
};

describe("llms-txt-exists", () => {
  it("passes when llms.txt exists", () => {
    const result = llmsTxtExists.run([basePage], {
      ...baseMeta,
      llmsTxt: "# My Site\n> Description\n## Docs\n- [Page](https://example.com/page)",
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when no llms.txt", () => {
    const result = llmsTxtExists.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("llms-txt-valid", () => {
  it("validates spec compliance", () => {
    const result = llmsTxtValid.run([basePage], {
      ...baseMeta,
      llmsTxt:
        "# My Site\n\n> A great site for testing\n\n## Documentation\n\n- [Docs](https://example.com/docs): Main docs",
    });
    expect(result.score).toBe(100);
  });

  it("partial for incomplete llms.txt", () => {
    const result = llmsTxtValid.run([basePage], {
      ...baseMeta,
      llmsTxt: "# My Site\nSome content without proper format",
    });
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });

  it("skips when no llms.txt", () => {
    const result = llmsTxtValid.run([basePage], baseMeta);
    expect(result.status).toBe("skip");
  });
});

describe("well-known-agent-card", () => {
  it("passes with valid JSON", () => {
    const result = wellKnownAgentCard.run([basePage], {
      ...baseMeta,
      wellKnown: { "agent-card.json": '{"name": "test", "capabilities": []}' },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when not present", () => {
    const result = wellKnownAgentCard.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });

  it.each(["[]", "null", "1"])("fails when the body is not a JSON object (%s)", (body) => {
    const result = wellKnownAgentCard.run([basePage], {
      ...baseMeta,
      wellKnown: { "agent-card.json": body },
    });
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("well-known-agents-json", () => {
  it("passes with valid JSON", () => {
    const result = wellKnownAgentsJson.run([basePage], {
      ...baseMeta,
      wellKnown: { "agents.json": '{"agents": []}' },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });
});

describe("markdown-alternate", () => {
  it("detects markdown alternate links", () => {
    const html = readFileSync(resolve(__dirname, "../fixtures/with-schema.html"), "utf-8");
    const page: FetchedPage = { ...basePage, html };
    const result = markdownAlternate.run([page], baseMeta);
    expect(result.score).toBeGreaterThan(0);
  });

  it("fails without alternate links", () => {
    const result = markdownAlternate.run([basePage], baseMeta);
    expect(result.score).toBe(0);
  });
});
