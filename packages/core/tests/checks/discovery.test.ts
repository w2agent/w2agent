import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentAuthChecks } from "../../src/audit/checks/agent-auth.js";
import {
  discoveryChecks,
  findMcpServerCard,
  llmsTxtExists,
  llmsTxtLinksResolve,
  llmsTxtValid,
  markdownAlternate,
  mcpServerCard,
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

describe("well-known-agent-card (A2A v1.0 validation, P1-10)", () => {
  const V1_CARD = {
    name: "Recipe Agent",
    description: "Helps with recipes",
    supportedInterfaces: [
      { url: "https://example.com/a2a/v1", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    provider: { organization: "Example", url: "https://example.com" },
    version: "1.0.0",
    capabilities: {},
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "recipes", name: "Recipes", description: "Find recipes", tags: ["cooking"] }],
  };
  const V03_CARD = {
    name: "Recipe Agent",
    description: "Helps with recipes",
    url: "https://example.com/a2a",
    preferredTransport: "JSONRPC",
    version: "1.0.0",
    capabilities: {},
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "recipes", name: "Recipes", description: "Find recipes", tags: ["cooking"] }],
  };
  const run = (card: unknown) =>
    wellKnownAgentCard.run([basePage], {
      ...baseMeta,
      wellKnown: { "agent-card.json": typeof card === "string" ? card : JSON.stringify(card) },
    }) as CheckResult;
  const withInterfaces = (...urls: string[]) => ({
    ...V1_CARD,
    supportedInterfaces: urls.map((url) => ({
      url,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    })),
  });

  it("a card with every v1.0 required field and a real A2A interface passes", () => {
    const result = run(V1_CARD);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("v1.0");
  });

  it("the fix points non-passing sites at a real A2A endpoint, never at an auto-generated card", () => {
    // An endpoint-less generated card is a homepage stub; suggesting one would loop forever.
    for (const card of [undefined, withInterfaces("https://example.com/"), V03_CARD]) {
      const result =
        card === undefined
          ? (wellKnownAgentCard.run([basePage], baseMeta) as CheckResult)
          : run(card);
      expect(result.status).not.toBe("pass");
      expect(result.fixSnippet).toContain("Only if this site operates an A2A agent");
      expect(result.fixSnippet).toContain("--a2a-endpoint");
      expect(result.fixSnippet).toContain("never the site homepage");
    }
    expect(run(V1_CARD).fixSnippet).toBeUndefined();
  });

  it("an interface on another origin's root is a real endpoint, not a stub", () => {
    expect(run(withInterfaces("https://agent.example.net/"))).toMatchObject({
      status: "pass",
      score: 100,
    });
  });

  it.each([
    "https://example.com",
    "https://example.com/",
  ])("a v1.0 card whose interface is the site homepage (%s) is a stub: partial 50", (url) => {
    const result = run(withInterfaces(url));
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("stub");
  });

  it("any homepage interface caps the card at partial, even next to a real endpoint", () => {
    const result = run(withInterfaces("https://example.com/a2a", "https://example.com/"));
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("stub");
  });

  it("a v0.3 card (url + preferredTransport) is partial 50 and names what v1.0 needs", () => {
    const result = run(V03_CARD);
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("v0.3");
    expect(result.message).toContain("supportedInterfaces");
    expect(result.message).not.toContain("stub");
  });

  it("a v0.3 card whose url is the site homepage is partial 50 and mentions both v0.3 and stub", () => {
    const result = run({ ...V03_CARD, url: "https://example.com/" });
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("v0.3");
    expect(result.message).toContain("stub");
  });

  it("a canonical A2A 0.3 card without preferredTransport (optional, defaults to JSONRPC) is v0.3 partial 50", () => {
    const { preferredTransport: _, ...canonical } = V03_CARD;
    const result = run(canonical);
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("v0.3");
  });

  it("a v0.3 card with preferredTransport but no capabilities or skills is still v0.3 partial 50", () => {
    expect(
      run({ name: "Agent", url: "https://example.com/a2a", preferredTransport: "JSONRPC" }),
    ).toMatchObject({ status: "partial", score: 50 });
  });

  it.each([
    ["{name, url} alone", {}],
    ["capabilities without skills", { capabilities: {} }],
    ["skills without capabilities", { skills: [] }],
  ])("%s is not a v0.3 card: fail 0", (_label, extra) => {
    expect(run({ name: "Agent", url: "https://example.com/a2a", ...extra })).toMatchObject({
      status: "fail",
      score: 0,
    });
  });

  it.each([
    "/a2a",
    "/",
  ])("a v0.3 card whose url is relative (%s) is not an A2A card: fail 0", (url) => {
    expect(run({ ...V03_CARD, url })).toMatchObject({ status: "fail", score: 0 });
  });

  it.each([
    "/a2a",
    "/",
    "ftp://example.com/a2a",
  ])("a v1.0 card whose interface url is not an absolute http(s) URL (%s) fails 0 naming supportedInterfaces", (url) => {
    const result = run(withInterfaces(url));
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.message).toContain("supportedInterfaces");
  });

  it("a name-only card fails 0 and names the missing v1.0 fields", () => {
    const result = run({ name: "Example", url: "https://example.com/a2a" });
    expect(result).toMatchObject({ status: "fail", score: 0 });
    for (const field of ["description", "supportedInterfaces", "capabilities", "skills"]) {
      expect(result.message).toContain(field);
    }
  });

  it.each([
    "name",
    "description",
    "version",
    "supportedInterfaces",
    "capabilities",
    "defaultInputModes",
    "defaultOutputModes",
    "skills",
  ])("a v1.0 card without required %s does not pass", (field) => {
    const card: Record<string, unknown> = { ...V1_CARD };
    delete card[field];
    const result = run(card);
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.message).toContain(field);
  });

  it.each([
    ["empty supportedInterfaces", { ...V1_CARD, supportedInterfaces: [] }],
    [
      "interface without protocolVersion",
      {
        ...V1_CARD,
        supportedInterfaces: [{ url: "https://example.com/a2a", protocolBinding: "JSONRPC" }],
      },
    ],
    [
      "interface without protocolBinding",
      {
        ...V1_CARD,
        supportedInterfaces: [{ url: "https://example.com/a2a", protocolVersion: "1.0" }],
      },
    ],
    [
      "interface without url",
      { ...V1_CARD, supportedInterfaces: [{ protocolBinding: "JSONRPC", protocolVersion: "1.0" }] },
    ],
    ["skill without tags", { ...V1_CARD, skills: [{ id: "a", name: "A", description: "B" }] }],
    ["skill without id", { ...V1_CARD, skills: [{ name: "A", description: "B", tags: [] }] }],
    ["capabilities as an array", { ...V1_CARD, capabilities: [] }],
    ["defaultInputModes as a string", { ...V1_CARD, defaultInputModes: "text/plain" }],
  ])("%s does not pass", (_label, card) => {
    expect(run(card)).toMatchObject({ status: "fail", score: 0 });
  });

  it("fails when not present", () => {
    const result = wellKnownAgentCard.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.message).toMatch(/No \/\.well-known\/agent-card\.json/);
  });

  it.each([
    "[]",
    "null",
    "1",
    "{}",
    '{"name":""}',
    '{"name":42}',
    '{"error":"not found","path":"/.well-known/agent-card.json"}',
  ])("fails when the body is not an agent card (%s)", (body) => {
    expect(run(body)).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("mcp-server-card (tracked, P1-9)", () => {
  const CARD = { name: "Example MCP", version: "2.0.0", description: "Example tools" };
  const MCP_ENDPOINT = "https://mcp.example.com/mcp/";
  const GITHUB_CATALOG = {
    specVersion: "1.0",
    entries: [
      {
        identifier: "urn:air:github.com:mcp:github-mcp-server",
        type: "application/mcp-server-card+json",
        url: "https://api.githubcopilot.com/mcp/server-card",
      },
    ],
  };
  const jsonResponse = (body: unknown, type = "application/mcp-server-card+json") =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": type } });

  function serve(routes: Record<string, () => Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return routes[url]?.() ?? new Response("not found", { status: 404 });
    });
  }
  const requested = (spy: ReturnType<typeof serve>) =>
    spy.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a tracked agent-discovery check with weight 0, no longer in agent-auth", () => {
    expect(mcpServerCard).toMatchObject({
      tracked: true,
      weight: 0,
      category: "agent-discovery",
    });
    expect(discoveryChecks).toContain(mcpServerCard);
    expect(agentAuthChecks.map((c) => c.id)).not.toContain("mcp-server-card");
  });

  it("shape 1: <MCP endpoint>/server-card (trailing slash stripped) passes", async () => {
    const spy = serve({ "https://mcp.example.com/mcp/server-card": () => jsonResponse(CARD) });
    const result = await mcpServerCard.run([basePage], { ...baseMeta, mcpEndpoint: MCP_ENDPOINT });
    expect(result).toMatchObject({ status: "pass", score: 100, weight: 0 });
    expect(result.message).toContain("MCP endpoint");
    expect(requested(spy)).toEqual(["https://mcp.example.com/mcp/server-card"]);
  });

  it("a catch-all site that echoes card-shaped JSON on every path earns no server card from same-origin fetches", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(CARD, "application/json"));
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      catchAll: true,
      mcpEndpoint: "https://example.com/mcp",
      wellKnown: {
        "ai-catalog.json": JSON.stringify({
          entries: [{ type: "application/mcp-server-card+json", url: "/cards/mcp.json" }],
        }),
      },
    });
    expect(result.status).toBe("skip");
    expect(spy).not.toHaveBeenCalled();
  });

  it("under catch-all, an off-origin endpoint and catalog entry are still fetched and credited", async () => {
    const spy = serve({
      "https://api.githubcopilot.com/mcp/server-card": () => jsonResponse(CARD),
    });
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      catchAll: true,
      mcpEndpoint: MCP_ENDPOINT,
      wellKnown: { "ai-catalog.json": JSON.stringify(GITHUB_CATALOG) },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(requested(spy)).toEqual([
      "https://mcp.example.com/mcp/server-card",
      "https://api.githubcopilot.com/mcp/server-card",
    ]);
  });

  it("the fetched shapes share one wall-clock budget, and the legacy card is still read after it is spent", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    const result = await findMcpServerCard(
      {
        ...baseMeta,
        mcpEndpoint: MCP_ENDPOINT,
        wellKnown: {
          "ai-catalog.json": JSON.stringify({
            entries: [1, 2, 3].map((n) => ({
              type: "application/mcp-server-card+json",
              url: `https://cards${n}.example.net/card.json`,
            })),
          }),
          "mcp/server-card.json": JSON.stringify(CARD),
        },
      },
      undefined,
      150,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("legacy");
  });

  it("shape 2: an ai-catalog.json entry of type application/mcp-server-card+json is fetched off-origin and passes", async () => {
    serve({ "https://api.githubcopilot.com/mcp/server-card": () => jsonResponse(CARD) });
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      wellKnown: { "ai-catalog.json": JSON.stringify(GITHUB_CATALOG) },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("ai-catalog.json entry");
    expect(result.message).toContain("https://api.githubcopilot.com/mcp/server-card");
  });

  it("shape 2 matches the media-type essence, ignoring parameters and case", async () => {
    serve({ "https://example.com/cards/a.json": () => jsonResponse(CARD) });
    const catalog = {
      entries: [
        { type: "application/json", url: "https://example.com/other.json" },
        { type: "Application/MCP-Server-Card+JSON; charset=utf-8", url: "/cards/a.json" },
      ],
    };
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      wellKnown: { "ai-catalog.json": JSON.stringify(catalog) },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("https://example.com/cards/a.json");
  });

  it("shape 2 ignores entries of other types without fetching them", async () => {
    const spy = serve({ "https://example.com/other.json": () => jsonResponse(CARD) });
    const catalog = {
      entries: [{ type: "application/a2a-agent-card+json", url: "https://example.com/other.json" }],
    };
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      wellKnown: { "ai-catalog.json": JSON.stringify(catalog) },
    });
    expect(result.status).toBe("skip");
    expect(spy).not.toHaveBeenCalled();
  });

  it("shape 2 tries at most 3 catalog entries", async () => {
    const spy = serve({ "https://example.com/card-4.json": () => jsonResponse(CARD) });
    const catalog = {
      entries: [1, 2, 3, 4].map((i) => ({
        type: "application/mcp-server-card+json",
        url: `https://example.com/card-${i}.json`,
      })),
    };
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      wellKnown: { "ai-catalog.json": JSON.stringify(catalog) },
    });
    expect(result.status).toBe("skip");
    expect(requested(spy)).toEqual([1, 2, 3].map((i) => `https://example.com/card-${i}.json`));
  });

  it("shape 2 entries go through the isAllowedTarget hook: a refused off-origin entry is never fetched", async () => {
    const spy = serve({
      "https://api.githubcopilot.com/mcp/server-card": () => jsonResponse(CARD),
    });
    const result = await mcpServerCard.run(
      [basePage],
      {
        ...baseMeta,
        wellKnown: {
          "ai-catalog.json": JSON.stringify(GITHUB_CATALOG),
          "mcp/server-card.json": JSON.stringify({ ...CARD, name: "Legacy" }),
        },
      },
      { isAllowedTarget: (url) => new URL(url).hostname === "example.com" },
    );
    expect(requested(spy)).not.toContain("https://api.githubcopilot.com/mcp/server-card");
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("Legacy");
  });

  it("shape 3: the crawler's legacy /.well-known/mcp/server-card.json passes without fetching", async () => {
    const spy = serve({});
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      wellKnown: { "mcp/server-card.json": JSON.stringify(CARD) },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("legacy");
    expect(spy).not.toHaveBeenCalled();
  });

  it("precedence: endpoint card wins over ai-catalog and legacy, and later shapes are not fetched", async () => {
    const spy = serve({
      "https://mcp.example.com/mcp/server-card": () => jsonResponse({ ...CARD, name: "Endpoint" }),
      "https://api.githubcopilot.com/mcp/server-card": () =>
        jsonResponse({ ...CARD, name: "Catalog" }),
    });
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      mcpEndpoint: MCP_ENDPOINT,
      wellKnown: {
        "ai-catalog.json": JSON.stringify(GITHUB_CATALOG),
        "mcp/server-card.json": JSON.stringify({ ...CARD, name: "Legacy" }),
      },
    });
    expect(result.message).toContain("Endpoint");
    expect(requested(spy)).toEqual(["https://mcp.example.com/mcp/server-card"]);
  });

  it("precedence: ai-catalog wins over legacy when the endpoint has no card", async () => {
    serve({
      "https://api.githubcopilot.com/mcp/server-card": () =>
        jsonResponse({ ...CARD, name: "Catalog" }),
    });
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      mcpEndpoint: MCP_ENDPOINT,
      wellKnown: {
        "ai-catalog.json": JSON.stringify(GITHUB_CATALOG),
        "mcp/server-card.json": JSON.stringify({ ...CARD, name: "Legacy" }),
      },
    });
    expect(result.message).toContain("Catalog");
  });

  it("first valid wins: an endpoint card missing fields does not block a valid legacy card", async () => {
    serve({ "https://mcp.example.com/mcp/server-card": () => jsonResponse({ name: "Endpoint" }) });
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      mcpEndpoint: MCP_ENDPOINT,
      wellKnown: { "mcp/server-card.json": JSON.stringify({ ...CARD, name: "Legacy" }) },
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("Legacy");
  });

  it("an endpoint card not served as JSON is not a card", async () => {
    serve({
      "https://mcp.example.com/mcp/server-card": () => jsonResponse(CARD, "text/html"),
    });
    const result = await mcpServerCard.run([basePage], { ...baseMeta, mcpEndpoint: MCP_ENDPOINT });
    expect(result.status).toBe("skip");
  });

  it.each([
    ["name", { version: "1.0.0", description: "d" }],
    ["version", { name: "n", description: "d" }],
    ["description", { name: "n", version: "1.0.0" }],
  ])("a card missing %s fails 0 and names the field and where it was found", async (field, card) => {
    serve({});
    const result = await mcpServerCard.run([basePage], {
      ...baseMeta,
      wellKnown: { "mcp/server-card.json": JSON.stringify(card) },
    });
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.message).toContain(field);
    expect(result.message).toContain("/.well-known/mcp/server-card.json");
  });

  it("no card in any shape → skip", async () => {
    serve({});
    const result = await mcpServerCard.run([basePage], { ...baseMeta, mcpEndpoint: MCP_ENDPOINT });
    expect(result).toMatchObject({ status: "skip", score: 0 });
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
