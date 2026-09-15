import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeEdgeAccess, EDGE_AGENT_TOKENS, edgeAgentAccess } from "../src/audit/checks/edge.js";
import { allChecks } from "../src/audit/checks/index.js";
import { runAudit } from "../src/audit/engine.js";
import { BOT_TOKENS } from "../src/audit/shared/bot-tokens.js";
import type {
  AuditOptions,
  AuditReport,
  CheckResult,
  EdgeProbePage,
  MultiUaResponse,
  SiteMetadata,
} from "../src/audit/types.js";

const HOME = "https://site.test/";
const P1 = "https://site.test/p1";

function ua(token: string, over: Partial<MultiUaResponse> = {}): MultiUaResponse {
  return {
    token,
    url: HOME,
    status: 200,
    contentLength: 120,
    finalUrl: HOME,
    reachable: true,
    outcome: "ok",
    headers: {},
    ...over,
  };
}

function page(over: Partial<EdgeProbePage> = {}): EdgeProbePage {
  return {
    url: HOME,
    control: 200,
    results: [ua("ChatGPT-User"), ua("Perplexity-User"), ua("Google-Agent")],
    ...over,
  };
}

function run(edgeProbe: EdgeProbePage[] | undefined): CheckResult {
  return edgeAgentAccess.run([], { edgeProbe } as unknown as SiteMetadata) as CheckResult;
}

function firstLine(r: CheckResult): string {
  return (r.details ?? "").split("\n")[0];
}

describe("edge-agent-access — check shape", () => {
  it("is a tracked, weight-0 bot-accessibility check with severity error", () => {
    expect(edgeAgentAccess).toMatchObject({
      id: "edge-agent-access",
      category: "bot-accessibility",
      weight: 0,
      severity: "error",
      tracked: true,
    });
  });

  it("is registered in allChecks exactly once", () => {
    expect(allChecks.filter((c) => c.id === "edge-agent-access")).toHaveLength(1);
  });
});

describe("edge-agent-access — outcomes (§4.4)", () => {
  it("agent-blocked: a challenge on a 2xx-control page fails", () => {
    const r = run([
      page({
        results: [
          ua("ChatGPT-User", {
            status: 403,
            reachable: false,
            contentLength: 0,
            headers: { cfMitigated: "challenge" },
            challenge: { vendor: "cloudflare", signal: "cf-mitigated: challenge" },
          }),
          ua("Perplexity-User"),
          ua("Google-Agent"),
        ],
      }),
    ]);
    expect(r.status).toBe("fail");
    expect(r.score).toBe(0);
    expect(firstLine(r)).toBe("outcome: agent-blocked");
    expect(r.message).toContain("agent-blocked");
    expect(r.message).toContain("ChatGPT-User");
    expect(r.details).toContain(`${HOME}.ChatGPT-User: 403 cloudflare cf-mitigated: challenge`);
    expect(r.details).toContain(`${HOME}.control: 200`);
  });

  it("agent-blocked: a bare 403 with no challenge markers still fails", () => {
    const r = run([
      page({
        results: [ua("ChatGPT-User", { status: 403, reachable: false }), ua("Google-Agent")],
      }),
    ]);
    expect(r.status).toBe("fail");
    expect(firstLine(r)).toBe("outcome: agent-blocked");
  });

  it("agent-blocked: a challenge served with a 200 status is still a block", () => {
    // Cloudflare can answer an interstitial with 200 + `cf-mitigated: challenge`;
    // the status alone would read as consistent, so the signal has to decide.
    const r = run([
      page({
        results: [
          ua("ChatGPT-User", {
            headers: { cfMitigated: "challenge" },
            challenge: { vendor: "cloudflare", signal: "cf-mitigated: challenge" },
          }),
          ua("Google-Agent"),
        ],
      }),
    ]);
    expect(r.status).toBe("fail");
    expect(firstLine(r)).toBe("outcome: agent-blocked");
    expect(r.message).toContain("anti-bot challenge");
  });

  it("agent-blocked: a 429 is a block, not a rejection", () => {
    const r = run([page({ results: [ua("ChatGPT-User", { status: 429, reachable: false })] })]);
    expect(firstLine(r)).toBe("outcome: agent-blocked");
  });

  it("agent-rejected: another non-2xx (not 402) fails as a rejection, not a block", () => {
    const r = run([
      page({
        results: [ua("ChatGPT-User", { status: 451, reachable: false }), ua("Google-Agent")],
      }),
    ]);
    expect(r.status).toBe("fail");
    expect(r.score).toBe(0);
    expect(firstLine(r)).toBe("outcome: agent-rejected");
    expect(r.message).toContain("agent-rejected");
  });

  it("agent-blocked wins over agent-rejected when both are present", () => {
    const r = run([
      page({
        results: [
          ua("ChatGPT-User", { status: 500, reachable: false }),
          ua("Perplexity-User", { status: 403, reachable: false }),
        ],
      }),
    ]);
    expect(firstLine(r)).toBe("outcome: agent-blocked");
  });

  it("paywalled: a 402 passes and the message says so", () => {
    const r = run([
      page({
        results: [ua("ChatGPT-User", { status: 402, reachable: false }), ua("Google-Agent")],
      }),
    ]);
    expect(r.status).toBe("pass");
    expect(r.score).toBe(100);
    expect(firstLine(r)).toBe("outcome: paywalled");
    expect(r.message).toContain("paywalled");
    expect(r.message).toContain("402");
  });

  it("consistent: every agent UA matching the control passes", () => {
    const r = run([page(), page({ url: P1, results: [ua("ChatGPT-User", { url: P1 })] })]);
    expect(r.status).toBe("pass");
    expect(r.score).toBe(100);
    expect(firstLine(r)).toBe("outcome: consistent");
    expect(r.message).toContain("consistent");
  });

  it("unmeasured: budget-skipped or timed-out agent fetches are an error, not a pass", () => {
    const r = run([
      page({
        results: [
          ua("ChatGPT-User", { status: 0, reachable: false, outcome: "budget-skipped" }),
          ua("Perplexity-User", { status: 0, reachable: false, outcome: "timeout" }),
          ua("Google-Agent", { status: 0, reachable: false, outcome: "fetch-error" }),
        ],
      }),
    ]);
    expect(r.status).toBe("error");
    expect(r.score).toBe(0);
    expect(firstLine(r)).toBe("outcome: unmeasured");
    expect(r.message).toContain("unmeasured");
    expect(r.details).toContain(`${HOME}.ChatGPT-User: 0 (budget-skipped)`);
  });

  it("unmeasured: no control page returned 2xx → error even with clean agent responses", () => {
    const r = run([page({ control: 403 }), page({ url: P1, control: 0 })]);
    expect(r.status).toBe("error");
    expect(r.score).toBe(0);
    expect(firstLine(r)).toBe("outcome: unmeasured");
    expect(r.message).toMatch(/no probed page returned 2xx/i);
  });

  it("unmeasured: no edge probe at all", () => {
    const r = run(undefined);
    expect(r.status).toBe("error");
    expect(firstLine(r)).toBe("outcome: unmeasured");
  });

  it("a non-2xx control page's agent responses are ignored", () => {
    // p1's control is a 403, so ChatGPT-User's 403 there is not evidence.
    const r = run([
      page(),
      page({
        url: P1,
        control: 403,
        results: [ua("ChatGPT-User", { url: P1, status: 403, reachable: false })],
      }),
    ]);
    expect(firstLine(r)).toBe("outcome: consistent");
  });
});

describe("edge-agent-access — probed vs notProbed user agents", () => {
  it("pins today's documented agent tokens, so a BOT_TOKENS change is loud", () => {
    expect(EDGE_AGENT_TOKENS).toEqual([
      "ChatGPT-User",
      "Claude-User",
      "Google-Agent",
      "Perplexity-User",
      "Amzn-User",
      "MistralAI-User",
      "Meta-ExternalFetcher",
    ]);
    expect(EDGE_AGENT_TOKENS).toEqual(
      BOT_TOKENS.filter((b) => b.purpose === "user").map((b) => b.token),
    );
    // Claude-User has no documented UA string at all.
    expect(BOT_TOKENS.find((b) => b.token === "Claude-User")?.uaString).toBeUndefined();
  });

  it("reports every unprobed documented agent token in notProbed", () => {
    const a = analyzeEdgeAccess([page()]);
    expect(a.probed).toEqual(["ChatGPT-User", "Perplexity-User", "Google-Agent"]);
    expect(a.notProbed).toEqual([
      "Claude-User",
      "Amzn-User",
      "MistralAI-User",
      "Meta-ExternalFetcher",
    ]);
    const r = run([page()]);
    expect(r.details).toContain(
      "notProbed: Claude-User, Amzn-User, MistralAI-User, Meta-ExternalFetcher",
    );
    expect(r.message).toContain("Not probed: Claude-User");
  });

  it("an unprobed token never contributes to a pass", () => {
    // Only Claude-User is 'present', and it is never fetched: no agent
    // response exists, so the check is unmeasured rather than consistent.
    const r = run([page({ results: [] })]);
    expect(r.status).toBe("error");
    expect(firstLine(r)).toBe("outcome: unmeasured");
    expect(analyzeEdgeAccess([page({ results: [] })]).notProbed).toEqual(EDGE_AGENT_TOKENS);
  });
});

// --- The report path: what `{status, score}` alone can carry to rubric 3.1 ---

const OPTIONS: Partial<AuditOptions> = { maxPages: 1, requestDelay: 0, timeout: 1000 };
const HOME_HTML =
  "<html><head><title>Home</title></head><body><h1>Home</h1><p>hello there</p></body></html>";
const CF_BODY =
  "<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={};</script></body></html>";

function checksById(report: AuditReport): Map<string, CheckResult> {
  return new Map(report.categories.flatMap((c) => c.checks).map((r) => [r.id, r]));
}

describe("edge-agent-access — on the report produced by runAudit", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const agent = (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? "";
      const path = new URL(url).pathname;
      if (agent.includes("ChatGPT-User")) {
        return new Response(CF_BODY, {
          status: 403,
          headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        });
      }
      if (path === "/") {
        return new Response(HOME_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("", { status: 404 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps its own pass/fail score on the report — weight 0 does not zero it", async () => {
    const report = await runAudit("https://site.test", OPTIONS, undefined, allChecks);
    const row = checksById(report).get("edge-agent-access");
    expect(row).toBeDefined();
    expect(row?.tracked).toBe(true);
    expect(row?.weight).toBe(0);
    // THE SCORE-PERSISTENCE FACT: `lib/audit-summary.ts` persists only
    // {status, score}. `score` here is the check's own verdict (0 on fail),
    // not a weight-multiplied 0 — but `details.outcome` is dropped, so the
    // stored row cannot tell agent-blocked from agent-rejected.
    expect(row?.status).toBe("fail");
    expect(row?.score).toBe(0);
    expect(firstLine(row as CheckResult)).toBe("outcome: agent-blocked");
    // Produced by the real AGENT_UAS -> edgeProbe path, so this line moves if
    // either BOT_TOKENS or crawler.ts's probed UA list changes.
    expect(row?.details).toContain(
      "notProbed: Claude-User, Amzn-User, MistralAI-User, Meta-ExternalFetcher",
    );
  });

  it("a passing edge probe carries score 100 through the report", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === "/") {
        return new Response(HOME_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("", { status: 404 });
    });
    const report = await runAudit("https://site.test", OPTIONS, undefined, allChecks);
    const row = checksById(report).get("edge-agent-access");
    expect(row?.status).toBe("pass");
    expect(row?.score).toBe(100);
    expect(firstLine(row as CheckResult)).toBe("outcome: consistent");
  });
});
