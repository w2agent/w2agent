import { describe, expect, it } from "vitest";
import { AuditError, type EdgeEvidence, formatEdgeEvidenceLine } from "w2agent-core";
import { edgeEvidenceOf } from "../src/commands/audit.js";

const EDGE: EdgeEvidence = {
  verdict: "agents-allowed",
  control: { status: 403, vendor: "cloudflare", signal: "cf-mitigated: challenge" },
  agents: [{ token: "ChatGPT-User", status: 200, outcome: "ok" }],
  notProbed: [{ token: "Claude-User", reason: "no-ua-string" }],
};

describe("edgeEvidenceOf", () => {
  it("reads the evidence off our own AuditError", () => {
    const err = new AuditError("blocked", "blocked", {
      status: 403,
      vendor: "cloudflare",
      edge: EDGE,
    });
    expect(edgeEvidenceOf(err)).toBe(EDGE);
  });

  it("reads it off a foreign-build AuditError, which is not instanceof ours", () => {
    const foreign = { name: "AuditError", message: "blocked", evidence: { edge: EDGE } };
    expect(foreign).not.toBeInstanceOf(AuditError);
    expect(edgeEvidenceOf(foreign)).toBe(EDGE);
  });

  it("an AuditError without edge evidence yields undefined", () => {
    expect(edgeEvidenceOf(new AuditError("timeout", "slow", { status: 0 }))).toBeUndefined();
  });

  it("non-AuditError throws yield undefined without throwing", () => {
    for (const value of [new Error("boom"), "a string", null, undefined, 42, {}]) {
      expect(edgeEvidenceOf(value)).toBeUndefined();
    }
  });

  it("a malformed edge payload is dropped rather than crashing the error report", () => {
    // A core built before/after this shape change must not turn `formatEdgeEvidenceLine`
    // loose inside the catch that is reporting the real audit failure.
    for (const edge of [
      { verdict: "all-blocked" }, // no agents
      { verdict: "all-blocked", agents: "nope" },
      { agents: [] }, // no verdict
      { verdict: "not-a-verdict", agents: [] },
      [{ verdict: "all-blocked", agents: [] }],
      "edge",
      null,
    ]) {
      const err = { name: "AuditError", message: "blocked", evidence: { edge } };
      expect(edgeEvidenceOf(err)).toBeUndefined();
      expect(() => {
        const e = edgeEvidenceOf(err);
        if (e) formatEdgeEvidenceLine(e);
      }).not.toThrow();
    }
  });

  it("tolerates a newer core carrying extra fields", () => {
    const edge = { ...EDGE, futureField: 7, agents: [...EDGE.agents] };
    const err = { name: "AuditError", message: "blocked", evidence: { edge } };
    expect(edgeEvidenceOf(err)).toBe(edge);
  });
});

describe("formatEdgeEvidenceLine over a CLI payload", () => {
  it("states the responded count and each agent's status", () => {
    const line = formatEdgeEvidenceLine({
      ...EDGE,
      verdict: "all-blocked",
      agents: [
        {
          token: "ChatGPT-User",
          status: 403,
          outcome: "ok",
          challenge: { vendor: "cloudflare", signal: "cf-mitigated: challenge" },
        },
        { token: "Perplexity-User", status: 0, outcome: "timeout" },
        { token: "Google-Agent", status: 0, outcome: "timeout", observedStatus: 429 },
      ],
    });
    expect(line).toContain("2 of 3 documented agent user-agents responded");
    expect(line).toContain("ChatGPT-User: 403 challenge (cloudflare)");
    expect(line).toContain("Perplexity-User: no response (timeout)");
    expect(line).toContain("Google-Agent: 429 (timeout after the status arrived)");
  });
});
