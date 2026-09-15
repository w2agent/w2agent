import { BOT_TOKENS } from "../shared/bot-tokens.js";
import { evidenceStatus, is2xx, isComparableControl } from "../shared/edge-evidence.js";
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

/**
 * A challenge, 403 or 429 — the edge actively refusing the agent UA. Evidence
 * observed before a body-read error counts: a 403 challenge whose body stream
 * then broke is still a block (`evidenceStatus`).
 */
function isBlocked(r: MultiUaResponse): boolean {
  const status = evidenceStatus(r);
  return r.challenge !== undefined || status === 403 || status === 429;
}

export interface EdgeAccessAnalysis {
  outcome: EdgeAccessOutcome;
  /** Tokens the multi-UA pass actually fetched under, in probe order. */
  probed: string[];
  /** Documented agent tokens with no fetch at all. Never counted as passing. */
  notProbed: string[];
  /** Probed tokens that never answered 2xx on a comparable page. */
  unanswered: string[];
  /** Pages with a clean control fetch — the only comparable ones. */
  comparablePages: number;
  /** The first result that drove a non-`consistent` outcome. */
  worst?: { page: EdgeProbePage; result: MultiUaResponse };
  /** Why the comparison could not be made, when `outcome === "unmeasured"`. */
  unmeasuredReason?: "no-control" | "no-agent-response" | "incomplete";
}

export function analyzeEdgeAccess(edgeProbe: EdgeProbePage[] | undefined): EdgeAccessAnalysis {
  const pages = edgeProbe ?? [];
  const probed: string[] = [];
  for (const page of pages) {
    for (const r of page.results) if (!probed.includes(r.token)) probed.push(r.token);
  }
  const notProbed = EDGE_AGENT_TOKENS.filter((t) => !probed.includes(t));

  // Only a page our own declared crawler read cleanly is evidence about the
  // agent UAs: without a 2xx, challenge-free control, an agent 403 says nothing
  // about agent-specific treatment.
  const comparable = pages.filter((p) => isComparableControl(p.control));
  const answered2xx = (r: MultiUaResponse) => r.outcome === "ok" && is2xx(r.status);
  const unanswered = probed.filter(
    (t) => !comparable.some((p) => p.results.some((r) => r.token === t && answered2xx(r))),
  );
  const base = { probed, notProbed, unanswered, comparablePages: comparable.length };

  if (comparable.length === 0) {
    return { outcome: "unmeasured", ...base, unmeasuredReason: "no-control" };
  }

  // Negative evidence needs no completeness: a block is a block even when
  // another UA timed out. It also survives a body-read error (see `isBlocked`).
  const all = comparable.flatMap((page) => page.results.map((result) => ({ page, result })));
  const blocked = all.find(({ result }) => isBlocked(result));
  if (blocked) return { outcome: "agent-blocked", ...base, worst: blocked };

  const responded = all.filter(({ result }) => result.outcome === "ok");
  if (responded.length === 0) {
    return { outcome: "unmeasured", ...base, unmeasuredReason: "no-agent-response" };
  }

  const rejected = responded.find(({ result }) => !is2xx(result.status) && result.status !== 402);
  if (rejected) return { outcome: "agent-rejected", ...base, worst: rejected };

  const paywalled = responded.find(({ result }) => result.status === 402);
  if (paywalled) return { outcome: "paywalled", ...base, worst: paywalled };

  // A positive verdict needs completeness, per §4.4's "every agent UA … on
  // every page": some comparable page where *every* probed token answered 2xx.
  // Otherwise a UA that never answered would be awarded a clean bill of health.
  const complete = comparable.some((page) =>
    probed.every((t) => page.results.some((r) => r.token === t && answered2xx(r))),
  );
  if (!complete) return { outcome: "unmeasured", ...base, unmeasuredReason: "incomplete" };

  return { outcome: "consistent", ...base };
}

function describe(r: MultiUaResponse): string {
  const status = evidenceStatus(r);
  const note = r.outcome === "ok" ? "" : ` (seen before the read failed: ${r.outcome})`;
  if (r.challenge) {
    return `an anti-bot challenge (${r.challenge.vendor}: ${r.challenge.signal}) with HTTP ${status}${note}`;
  }
  return `HTTP ${status}${note}`;
}

function unansweredNote(a: EdgeAccessAnalysis): string {
  if (a.unanswered.length === 0) return "no single probed page got an answer from all of them";
  return `${a.unanswered.join(", ")} never answered on a comparable page`;
}

function messageFor(a: EdgeAccessAnalysis): string {
  const notProbedNote = a.notProbed.length > 0 ? ` Not probed: ${a.notProbed.join(", ")}.` : "";
  switch (a.outcome) {
    case "agent-blocked": {
      const { page, result } = a.worst as NonNullable<EdgeAccessAnalysis["worst"]>;
      return `Blocked at the edge (agent-blocked): ${result.token} got ${describe(result)} on ${page.url}, where our declared crawler got HTTP ${page.control.status}.${notProbedNote}`;
    }
    case "agent-rejected": {
      const { page, result } = a.worst as NonNullable<EdgeAccessAnalysis["worst"]>;
      return `Rejected at the edge (agent-rejected): ${result.token} got HTTP ${result.status} on ${page.url}, where our declared crawler got HTTP ${page.control.status}.${notProbedNote}`;
    }
    case "paywalled": {
      const { page, result } = a.worst as NonNullable<EdgeAccessAnalysis["worst"]>;
      return `Payment required for agents (paywalled): ${result.token} got HTTP 402 on ${page.url}, where our declared crawler got HTTP ${page.control.status}. Informational — a declared paywall is not an edge block.${notProbedNote}`;
    }
    case "consistent":
      return `No edge difference (consistent): every probed agent user-agent matched our declared crawler on ${a.comparablePages} page(s).${notProbedNote}`;
    default:
      switch (a.unmeasuredReason) {
        case "no-control":
          return `Not measured (unmeasured): no probed page gave our declared crawler a clean 2xx (a non-2xx, a failed fetch or a challenge on the control itself), so agent responses cannot be compared.${notProbedNote}`;
        case "no-agent-response":
          return `Not measured (unmeasured): every agent user-agent fetch was skipped or failed before a response arrived.${notProbedNote}`;
        default:
          return `Not measured (unmeasured): no page was answered by all ${a.probed.length} probed agent user-agents, so "consistent" cannot be claimed — ${unansweredNote(a)}.${notProbedNote}`;
      }
  }
}

function statusLine(r: MultiUaResponse): string {
  const challenge = r.challenge ? ` ${r.challenge.vendor} ${r.challenge.signal}` : "";
  if (r.outcome !== "ok") {
    const observed =
      r.observedStatus !== undefined ? `, observed ${r.observedStatus}${challenge}` : "";
    return `0 (${r.outcome}${observed})`;
  }
  return `${r.status}${challenge}`;
}

function detailsFor(a: EdgeAccessAnalysis, edgeProbe: EdgeProbePage[] | undefined): string {
  const lines = [`outcome: ${a.outcome}`];
  for (const page of edgeProbe ?? []) {
    lines.push(`${page.url}.control: ${statusLine(page.control)}`);
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
