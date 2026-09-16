import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runAudit } from "../src/audit/engine.js";
import { AuditError } from "../src/audit/errors.js";
import { BOT_TOKENS } from "../src/audit/shared/bot-tokens.js";
import {
  formatEdgeEvidenceLine,
  summarizeEdgeEvidence,
} from "../src/audit/shared/edge-evidence.js";
import type {
  EdgeProbePage,
  FetchedPage,
  MultiUaResponse,
  SiteMetadata,
} from "../src/audit/types.js";
import { DEFAULT_OPTIONS } from "../src/audit/types.js";

function response(token: string, over: Partial<MultiUaResponse> = {}): MultiUaResponse {
  return {
    token,
    url: "https://site.test/",
    status: 200,
    contentLength: 100,
    finalUrl: "https://site.test/",
    reachable: true,
    outcome: "ok",
    headers: {},
    ...over,
  };
}

const CHALLENGED_CONTROL = response("control", {
  status: 403,
  contentLength: 0,
  reachable: false,
  challenge: { vendor: "cloudflare", signal: "cf-mitigated: challenge" },
});

function homepage(results: MultiUaResponse[], control = CHALLENGED_CONTROL): EdgeProbePage {
  return { url: "https://site.test/", control, results };
}

const blocked = (token: string) =>
  response(token, { status: 403, contentLength: 0, reachable: false });

const skipped = (token: string) =>
  response(token, {
    status: 0,
    contentLength: 0,
    reachable: false,
    outcome: "budget-skipped",
  });

describe("summarizeEdgeEvidence — verdict per §3 D-2", () => {
  it("every responding agent 2xx → agents-allowed, even alongside a non-responding one", () => {
    const edge = summarizeEdgeEvidence(
      homepage([
        response("ChatGPT-User"),
        response("Perplexity-User", { status: 204, contentLength: 0, reachable: false }),
        skipped("Google-Agent"),
      ]),
    );
    expect(edge.verdict).toBe("agents-allowed");
  });

  it("every responding agent non-2xx → all-blocked", () => {
    const edge = summarizeEdgeEvidence(
      homepage([blocked("ChatGPT-User"), blocked("Perplexity-User"), skipped("Google-Agent")]),
    );
    expect(edge.verdict).toBe("all-blocked");
  });

  it("the 2xx boundary is exclusive of 300: a 300/301 responder counts as blocked", () => {
    expect(
      summarizeEdgeEvidence(
        homepage([
          response("ChatGPT-User", { status: 300, contentLength: 0, reachable: false }),
          response("Google-Agent", { status: 301, contentLength: 0, reachable: false }),
        ]),
      ).verdict,
    ).toBe("all-blocked");
    expect(
      summarizeEdgeEvidence(
        homepage([
          response("ChatGPT-User"),
          response("Google-Agent", { status: 300, contentLength: 0, reachable: false }),
        ]),
      ).verdict,
    ).toBe("mixed");
  });

  it("a mix of 2xx and non-2xx responders → mixed", () => {
    const edge = summarizeEdgeEvidence(
      homepage([response("ChatGPT-User"), blocked("Perplexity-User")]),
    );
    expect(edge.verdict).toBe("mixed");
  });

  it("no agent returned a response → unknown (all budget-skipped)", () => {
    const edge = summarizeEdgeEvidence(
      homepage([skipped("ChatGPT-User"), skipped("Perplexity-User"), skipped("Google-Agent")]),
    );
    expect(edge.verdict).toBe("unknown");
  });

  it("a 2xx carrying a challenge is not served → all-blocked, not agents-allowed", () => {
    const edge = summarizeEdgeEvidence(
      homepage([
        response("ChatGPT-User", {
          challenge: { vendor: "cloudflare", signal: "cf-mitigated: challenge" },
        }),
        response("Google-Agent", {
          challenge: { vendor: "akamai", signal: "server: AkamaiGHost" },
        }),
      ]),
    );
    expect(edge.verdict).toBe("all-blocked");
  });

  it("one clean 200 alongside a challenged 200 → mixed", () => {
    const edge = summarizeEdgeEvidence(
      homepage([
        response("ChatGPT-User"),
        response("Google-Agent", {
          challenge: { vendor: "cloudflare", signal: "cf-mitigated: challenge" },
        }),
      ]),
    );
    expect(edge.verdict).toBe("mixed");
  });

  it("a status observed before the body read broke is a blocked responder, and is stored", () => {
    const edge = summarizeEdgeEvidence(
      homepage([
        skipped("ChatGPT-User"),
        response("Google-Agent", {
          status: 0,
          contentLength: 0,
          reachable: false,
          outcome: "timeout",
          observedStatus: 403,
          challenge: { vendor: "cloudflare", signal: "cf-mitigated: challenge" },
        }),
      ]),
    );
    expect(edge.verdict).toBe("all-blocked");
    expect(edge.agents.find((a) => a.token === "Google-Agent")).toEqual({
      token: "Google-Agent",
      status: 0,
      outcome: "timeout",
      observedStatus: 403,
      challenge: { vendor: "cloudflare", signal: "cf-mitigated: challenge" },
    });
  });

  it("an agent that observed a 200 before the body read broke is a served responder", () => {
    const edge = summarizeEdgeEvidence(
      homepage([
        blocked("ChatGPT-User"),
        blocked("Perplexity-User"),
        response("Google-Agent", {
          status: 0,
          contentLength: 0,
          reachable: false,
          outcome: "fetch-error",
          observedStatus: 200,
        }),
      ]),
    );
    expect(edge.verdict).toBe("mixed");
    expect(edge.agents.find((a) => a.token === "Google-Agent")).toEqual({
      token: "Google-Agent",
      status: 0,
      outcome: "fetch-error",
      observedStatus: 200,
    });
  });

  it("a failed fetch with no observed status is not a responder → unknown", () => {
    const edge = summarizeEdgeEvidence(
      homepage([
        response("ChatGPT-User", {
          status: 0,
          contentLength: 0,
          reachable: false,
          outcome: "timeout",
        }),
        response("Google-Agent", {
          status: 0,
          contentLength: 0,
          reachable: false,
          outcome: "fetch-error",
        }),
      ]),
    );
    expect(edge.verdict).toBe("unknown");
    expect(edge.agents.every((a) => a.observedStatus === undefined)).toBe(true);
  });

  it("carries the control status, its challenge, and one agent row per result", () => {
    const edge = summarizeEdgeEvidence(
      homepage([
        response("ChatGPT-User"),
        blocked("Perplexity-User"),
        response("Google-Agent", {
          status: 403,
          contentLength: 0,
          reachable: false,
          challenge: { vendor: "akamai", signal: "server: AkamaiGHost" },
        }),
      ]),
    );
    expect(edge.control).toEqual({
      status: 403,
      vendor: "cloudflare",
      signal: "cf-mitigated: challenge",
    });
    expect(edge.agents.map((a) => a.token)).toEqual([
      "ChatGPT-User",
      "Perplexity-User",
      "Google-Agent",
    ]);
    expect(edge.agents[2].challenge).toEqual({ vendor: "akamai", signal: "server: AkamaiGHost" });
  });
});

describe("summarizeEdgeEvidence — notProbed", () => {
  it("reports only tokens that could not be probed at all — no uaString", () => {
    const edge = summarizeEdgeEvidence(
      homepage([response("ChatGPT-User"), response("Perplexity-User"), response("Google-Agent")]),
    );
    expect(edge.notProbed).toContainEqual({ token: "Claude-User", reason: "no-ua-string" });
    // Claude-User is `hasUA: true` with no documented uaString — the uaString is
    // the gate, so this is the case the reason exists for.
    expect(BOT_TOKENS.find((b) => b.token === "Claude-User")?.uaString).toBeUndefined();
    expect(edge.notProbed.every((n) => n.reason === "no-ua-string")).toBe(true);
    expect(edge.notProbed.map((n) => n.token)).not.toContain("ChatGPT-User");
  });

  it("makes no claim about uaString-bearing tokens this build never probes", () => {
    const edge = summarizeEdgeEvidence(
      homepage([response("ChatGPT-User"), response("Perplexity-User"), response("Google-Agent")]),
    );
    // They are not probed on any page, so "extra-pages-only" would be a lie and
    // these rows persist. Omitted until the probe set is registry-derived.
    for (const token of ["Amzn-User", "MistralAI-User", "Meta-ExternalFetcher"]) {
      expect(BOT_TOKENS.find((b) => b.token === token)?.uaString).toBeDefined();
      expect(edge.notProbed.map((n) => n.token)).not.toContain(token);
    }
  });
});

describe("formatEdgeEvidenceLine", () => {
  it("agents-allowed carries the acceptance phrase, scoped to the agents that responded", () => {
    const line = formatEdgeEvidenceLine(
      summarizeEdgeEvidence(
        homepage([response("ChatGPT-User"), response("Google-Agent"), skipped("Perplexity-User")]),
      ),
    );
    expect(line).toContain("2 of 3 documented agent user-agents responded");
    expect(line).toContain("documented agent user-agents were served normally");
    expect(line).toContain("ChatGPT-User: 200");
    expect(line).toContain("Perplexity-User: no response (budget-skipped)");
  });

  it("all-blocked states the counts and each agent's status, and claims no coverage", () => {
    const line = formatEdgeEvidenceLine(
      summarizeEdgeEvidence(
        homepage([
          response("ChatGPT-User", {
            status: 403,
            contentLength: 0,
            reachable: false,
            challenge: { vendor: "cloudflare", signal: "cf-mitigated: challenge" },
          }),
          blocked("Google-Agent"),
          response("Perplexity-User", {
            status: 0,
            contentLength: 0,
            reachable: false,
            outcome: "timeout",
          }),
        ]),
      ),
    );
    expect(line).toContain("2 of 3 documented agent user-agents responded");
    expect(line).toContain("none of them was served");
    expect(line).toContain("ChatGPT-User: 403 challenge (cloudflare)");
    expect(line).toContain("Google-Agent: 403");
    expect(line).toContain("Perplexity-User: no response (timeout)");
    expect(line).not.toContain("served normally");
    expect(line).not.toContain("every documented agent user-agent");
  });

  it("mixed names which agents were served and which were refused", () => {
    const line = formatEdgeEvidenceLine(
      summarizeEdgeEvidence(homepage([response("ChatGPT-User"), blocked("Google-Agent")])),
    );
    expect(line).toContain("2 of 2 documented agent user-agents responded");
    expect(line).toContain("served ChatGPT-User");
    expect(line).toContain("refused Google-Agent");
  });

  it("a status observed before the read broke is reported with its outcome", () => {
    const line = formatEdgeEvidenceLine(
      summarizeEdgeEvidence(
        homepage([
          response("ChatGPT-User", {
            status: 0,
            contentLength: 0,
            reachable: false,
            outcome: "timeout",
            observedStatus: 403,
          }),
        ]),
      ),
    );
    expect(line).toContain("ChatGPT-User: 403 (timeout after the status arrived)");
  });

  it("unknown claims nothing and still lists the agents", () => {
    const line = formatEdgeEvidenceLine(
      summarizeEdgeEvidence(homepage([skipped("ChatGPT-User"), skipped("Google-Agent")])),
    );
    expect(line).toContain("no agent user-agent returned a response");
    expect(line).toContain("Google-Agent: no response (budget-skipped)");
  });
});

describe("the prefetched path carries the evidence of whatever crawl made the metadata", () => {
  const URL_UNDER_TEST = "https://prefetched.test/";

  function unscorablePage(url: string): FetchedPage {
    return { url, status: 403, html: "", headers: {}, responseTime: 1 };
  }

  // The platform's deploy route prefetches with core's `crawlSite`, which
  // populates `edgeProbe`; dropping it there stored NULL on real failures.
  function metadataWithEdgeProbe(): SiteMetadata {
    return {
      baseUrl: "https://prefetched.test",
      wellKnown: {},
      edgeProbe: [homepage([response("ChatGPT-User"), response("Google-Agent")])],
    };
  }

  it("verbatim prefetched pages → AuditError carrying evidence.edge", async () => {
    const err = await runAudit(
      URL_UNDER_TEST,
      {
        ...DEFAULT_OPTIONS,
        prefetchedPages: [unscorablePage(URL_UNDER_TEST)],
        prefetchedMetadata: metadataWithEdgeProbe(),
      },
      undefined,
      [],
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).kind).toBe("unknown_failure");
    expect((err as AuditError).evidence.edge?.verdict).toBe("agents-allowed");
    expect((err as AuditError).evidence.edge?.agents.map((a) => a.token)).toEqual([
      "ChatGPT-User",
      "Google-Agent",
    ]);
  });

  it("the >maxPages reselect branch → AuditError carrying evidence.edge", async () => {
    const err = await runAudit(
      URL_UNDER_TEST,
      {
        ...DEFAULT_OPTIONS,
        maxPages: 1,
        prefetchedPages: [unscorablePage(URL_UNDER_TEST), unscorablePage(`${URL_UNDER_TEST}other`)],
        prefetchedMetadata: metadataWithEdgeProbe(),
      },
      undefined,
      [],
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).evidence.edge?.verdict).toBe("agents-allowed");
  });

  it("a caller that did no crawl carries no edgeProbe → evidence.edge absent", async () => {
    const err = await runAudit(
      URL_UNDER_TEST,
      {
        ...DEFAULT_OPTIONS,
        prefetchedPages: [unscorablePage(URL_UNDER_TEST)],
        prefetchedMetadata: { baseUrl: "https://prefetched.test", wellKnown: {} },
      },
      undefined,
      [],
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).evidence.edge).toBeUndefined();
  });
});

describe("G1 acceptance: a live homepage that challenges our crawler", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const s = server;
    server = undefined;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  async function start(challengeAgents: boolean): Promise<string> {
    const s = createServer((req, res) => {
      const ua = req.headers["user-agent"] ?? "";
      const isOurCrawler = ua.includes("w2agent");
      if (isOurCrawler || challengeAgents) {
        res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
        res.end("<html><body>Just a moment...</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Open</title></head><body><p>hello agent</p></body></html>");
    });
    server = s;
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
  }

  const audit = (url: string) =>
    runAudit(
      url,
      { ...DEFAULT_OPTIONS, maxPages: 1, timeout: 2000, requestDelay: 0 },
      undefined,
      [],
    ).catch((e) => e);

  it("serves agent UAs 200 → the thrown error carries verdict agents-allowed", async () => {
    const err = await audit(await start(false));
    expect(err).toBeInstanceOf(AuditError);
    const error = err as AuditError;
    expect(error.kind).toBe("blocked");
    expect(error.evidence.edge?.verdict).toBe("agents-allowed");
    const edge = error.evidence.edge;
    if (!edge) throw new Error("no edge evidence on the thrown error");
    expect(edge.control.vendor).toBe("cloudflare");
    expect(edge.agents.map((a) => a.status)).toEqual([200, 200, 200]);
    expect(formatEdgeEvidenceLine(edge)).toContain(
      "documented agent user-agents were served normally",
    );
  }, 20000);

  it("challenges everyone → the thrown error carries verdict all-blocked", async () => {
    const err = await audit(await start(true));
    expect(err).toBeInstanceOf(AuditError);
    const edge = (err as AuditError).evidence.edge;
    expect(edge?.verdict).toBe("all-blocked");
    expect(edge?.agents.every((a) => a.challenge?.vendor === "cloudflare")).toBe(true);
  }, 20000);
});
