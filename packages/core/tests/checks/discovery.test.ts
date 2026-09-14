import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  discoveryChecks,
  llmsTxtExists,
  llmsTxtLinksResolve,
  llmsTxtValid,
  markdownAlternate,
  wellKnownAgentCard,
} from "../../src/audit/checks/discovery.js";
import type { CheckResult, FetchedPage, SiteMetadata } from "../../src/audit/types.js";

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

  it("fail message does not claim LLMs can't discover the site (llms.txt is not a discovery standard)", () => {
    const result = llmsTxtExists.run([basePage], baseMeta) as CheckResult;
    expect(result.message).not.toMatch(/can't discover/i);
    expect(result.message).toMatch(/llms\.txt/);
  });
});

describe("llms.txt weights (rubric P1-12: narrow value, M3 maturity)", () => {
  const llmsIds = ["llms-txt-exists", "llms-txt-valid", "llms-txt-links-resolve"];
  const withLlms = {
    ...baseMeta,
    llmsTxt: "# My Site\n\n> Desc\n\n## Docs\n\n- [Docs](https://example.com/docs)",
  };

  it("each llms.txt check is defined at weight 0.5", () => {
    for (const id of llmsIds) {
      expect({ id, weight: discoveryChecks.find((c) => c.id === id)?.weight }).toEqual({
        id,
        weight: 0.5,
      });
    }
  });

  it("every result branch carries weight 0.5, so scoring cannot drift from the definition", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("ok", { status: 200, headers: { "content-type": "text/html" } }),
    );
    try {
      const results: CheckResult[] = [
        llmsTxtExists.run([basePage], baseMeta) as CheckResult,
        llmsTxtExists.run([basePage], withLlms) as CheckResult,
        llmsTxtValid.run([basePage], baseMeta) as CheckResult,
        llmsTxtValid.run([basePage], withLlms) as CheckResult,
        await llmsTxtLinksResolve.run([basePage], baseMeta),
        await llmsTxtLinksResolve.run([basePage], { ...baseMeta, llmsTxt: "# No links" }),
        await llmsTxtLinksResolve.run([basePage], withLlms),
      ];
      for (const r of results) {
        expect({ id: r.id, status: r.status, weight: r.weight }).toMatchObject({ weight: 0.5 });
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("retired discovery checks (rubric P1-5)", () => {
  it("agents.json, ARA and ai-plugin.json are no longer audited", () => {
    const ids = discoveryChecks.map((c) => c.id);
    for (const id of ["well-known-agents-json", "well-known-ara", "well-known-ai-plugin"]) {
      expect(ids).not.toContain(id);
    }
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
