import { describe, expect, it } from "vitest";
import { AuditError, type EdgeEvidence } from "w2agent-core";
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
});
