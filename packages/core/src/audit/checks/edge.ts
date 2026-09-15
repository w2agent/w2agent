import { BOT_TOKENS } from "../shared/bot-tokens.js";
import type { Check, CheckResult, EdgeProbePage, MultiUaResponse } from "../types.js";

/**
 * Outcomes of the edge comparison, per the Phase 2 design §4.4. `fail` covers
 * both `agent-blocked` and `agent-rejected`; `pass` covers both `consistent`
 * and `paywalled`. The outcome itself lives only in `details` (see the handoff
 * note on what `audit_history.check_results` persists).
 */
export type EdgeAccessOutcome =
  | "agent-blocked"
  | "agent-rejected"
  | "paywalled"
  | "consistent"
  | "unmeasured";

/**
 * Every documented agent (`purpose: "user"`) bot token. The multi-UA pass
 * probes the subset it has a UA string for *and* has been wired into
 * `AGENT_UAS` (`crawler.ts`); everything else is reported as `notProbed` and
 * can never contribute to a pass.
 */
export const EDGE_AGENT_TOKENS: readonly string[] = BOT_TOKENS.filter(
  (b) => b.purpose === "user",
).map((b) => b.token);

const CHECK_ID = "edge-agent-access";
const CHECK_NAME = "Edge treatment of agent user-agents";

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** A challenge, 403 or 429 — the edge actively refusing the agent UA. */
function isBlocked(r: MultiUaResponse): boolean {
  return r.challenge !== undefined || r.status === 403 || r.status === 429;
}

export interface EdgeAccessAnalysis {
  outcome: EdgeAccessOutcome;
  /** Tokens the multi-UA pass actually fetched under, in probe order. */
  probed: string[];
  /** Documented agent tokens with no fetch at all. Never counted as passing. */
  notProbed: string[];
  /** Pages whose control fetch returned 2xx — the only comparable ones. */
  comparablePages: number;
  /** The first result that drove a non-`consistent` outcome. */
  worst?: { page: EdgeProbePage; result: MultiUaResponse };
  /** Why the comparison could not be made, when `outcome === "unmeasured"`. */
  unmeasuredReason?: "no-control" | "no-agent-response";
}

export function analyzeEdgeAccess(edgeProbe: EdgeProbePage[] | undefined): EdgeAccessAnalysis {
  const pages = edgeProbe ?? [];
  const probed: string[] = [];
  for (const page of pages) {
    for (const r of page.results) if (!probed.includes(r.token)) probed.push(r.token);
  }
  const notProbed = EDGE_AGENT_TOKENS.filter((t) => !probed.includes(t));

  // Only a page our own declared crawler could read is evidence about the
  // agent UAs: without a 2xx control, an agent 403 says nothing about the edge.
  const comparable = pages.filter((p) => is2xx(p.control));
  if (comparable.length === 0) {
    return {
      outcome: "unmeasured",
      probed,
      notProbed,
      comparablePages: 0,
      unmeasuredReason: "no-control",
    };
  }

  const responded = comparable.flatMap((page) =>
    page.results.filter((r) => r.outcome === "ok").map((result) => ({ page, result })),
  );
  if (responded.length === 0) {
    return {
      outcome: "unmeasured",
      probed,
      notProbed,
      comparablePages: comparable.length,
      unmeasuredReason: "no-agent-response",
    };
  }

  const blocked = responded.find(({ result }) => isBlocked(result));
  if (blocked) {
    return {
      outcome: "agent-blocked",
      probed,
      notProbed,
      comparablePages: comparable.length,
      worst: blocked,
    };
  }
  const rejected = responded.find(({ result }) => !is2xx(result.status) && result.status !== 402);
  if (rejected) {
    return {
      outcome: "agent-rejected",
      probed,
      notProbed,
      comparablePages: comparable.length,
      worst: rejected,
    };
  }
  const paywalled = responded.find(({ result }) => result.status === 402);
  if (paywalled) {
    return {
      outcome: "paywalled",
      probed,
      notProbed,
      comparablePages: comparable.length,
      worst: paywalled,
    };
  }
  return { outcome: "consistent", probed, notProbed, comparablePages: comparable.length };
}

function describe(r: MultiUaResponse): string {
  if (r.challenge) {
    return `an anti-bot challenge (${r.challenge.vendor}: ${r.challenge.signal}) with HTTP ${r.status}`;
  }
  return `HTTP ${r.status}`;
}

function messageFor(a: EdgeAccessAnalysis): string {
  const notProbedNote = a.notProbed.length > 0 ? ` Not probed: ${a.notProbed.join(", ")}.` : "";
  switch (a.outcome) {
    case "agent-blocked": {
      const { page, result } = a.worst as NonNullable<EdgeAccessAnalysis["worst"]>;
      return `Blocked at the edge (agent-blocked): ${result.token} got ${describe(result)} on ${page.url}, where our declared crawler got HTTP ${page.control}.${notProbedNote}`;
    }
    case "agent-rejected": {
      const { page, result } = a.worst as NonNullable<EdgeAccessAnalysis["worst"]>;
      return `Rejected at the edge (agent-rejected): ${result.token} got HTTP ${result.status} on ${page.url}, where our declared crawler got HTTP ${page.control}.${notProbedNote}`;
    }
    case "paywalled": {
      const { page, result } = a.worst as NonNullable<EdgeAccessAnalysis["worst"]>;
      return `Payment required for agents (paywalled): ${result.token} got HTTP 402 on ${page.url}, where our declared crawler got HTTP ${page.control}. Informational — a declared paywall is not an edge block.${notProbedNote}`;
    }
    case "consistent":
      return `No edge difference (consistent): every probed agent user-agent matched our declared crawler on ${a.comparablePages} page(s).${notProbedNote}`;
    default:
      return a.unmeasuredReason === "no-control"
        ? `Not measured (unmeasured): no probed page returned 2xx to our declared crawler, so agent responses cannot be compared.${notProbedNote}`
        : `Not measured (unmeasured): every agent user-agent fetch was skipped or failed before a response arrived.${notProbedNote}`;
  }
}

function statusLine(r: MultiUaResponse): string {
  if (r.outcome !== "ok") return `0 (${r.outcome})`;
  return r.challenge ? `${r.status} ${r.challenge.vendor} ${r.challenge.signal}` : `${r.status}`;
}

function detailsFor(a: EdgeAccessAnalysis, edgeProbe: EdgeProbePage[] | undefined): string {
  const lines = [`outcome: ${a.outcome}`];
  for (const page of edgeProbe ?? []) {
    lines.push(`${page.url}.control: ${page.control}`);
    for (const r of page.results) lines.push(`${page.url}.${r.token}: ${statusLine(r)}`);
  }
  lines.push(`notProbed: ${a.notProbed.length > 0 ? a.notProbed.join(", ") : "none"}`);
  return lines.join("\n");
}

export const edgeAgentAccess: Check = {
  id: CHECK_ID,
  name: CHECK_NAME,
  category: "bot-accessibility",
  weight: 0,
  severity: "error",
  tracked: true,
  run: (_pages, metadata): CheckResult => {
    const analysis = analyzeEdgeAccess(metadata.edgeProbe);
    const status: CheckResult["status"] =
      analysis.outcome === "unmeasured"
        ? "error"
        : analysis.outcome === "agent-blocked" || analysis.outcome === "agent-rejected"
          ? "fail"
          : "pass";
    return {
      id: CHECK_ID,
      name: CHECK_NAME,
      category: "bot-accessibility",
      status,
      score: status === "pass" ? 100 : 0,
      maxScore: 100,
      weight: 0,
      message: messageFor(analysis),
      details: detailsFor(analysis, metadata.edgeProbe),
      severity: "error",
      tracked: true,
    };
  },
};

export const edgeChecks: Check[] = [edgeAgentAccess];
