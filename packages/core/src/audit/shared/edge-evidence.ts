import type { EdgeEvidence, EdgeEvidenceAgent, EdgeVerdict } from "../errors.js";
import type { EdgeProbePage, MultiUaResponse } from "../types.js";
import { BOT_TOKENS } from "./bot-tokens.js";

export function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * A page is comparable evidence only when our own declared crawler got a clean
 * answer on it: the control fetch itself succeeded, returned 2xx, and was not
 * challenged. A control that was challenged (e.g. `200 + cf-mitigated`) means
 * the edge treats *everyone* that way, so an agent challenge on that page says
 * nothing about agent-specific treatment.
 */
export function isComparableControl(control: MultiUaResponse): boolean {
  return control.outcome === "ok" && is2xx(control.status) && control.challenge === undefined;
}

/**
 * Everything the edge verdict is derived from. Both the live wire result
 * (`MultiUaResponse`) and the stored row (`EdgeEvidenceAgent`) satisfy it, so
 * the predicates below are defined once and the two never drift.
 */
type EvidenceShape = Pick<MultiUaResponse, "status" | "outcome" | "challenge"> & {
  observedStatus?: number;
};

/**
 * The status this result is evidence of, including one observed on the wire
 * before a body-read error erased the scorable response (`observedStatus`).
 * 0 when nothing was observed at all.
 */
export function evidenceStatus(r: EvidenceShape): number {
  return r.outcome === "ok" ? r.status : (r.observedStatus ?? 0);
}

/** Something was observed on the wire, even if the body read then broke. */
function responded(r: EvidenceShape): boolean {
  return evidenceStatus(r) !== 0;
}

/** The edge let this UA through: a 2xx that was not an anti-bot challenge. */
function served(r: EvidenceShape): boolean {
  return is2xx(evidenceStatus(r)) && r.challenge === undefined;
}

function agentOf(r: MultiUaResponse): EdgeEvidenceAgent {
  return {
    token: r.token,
    status: r.status,
    outcome: r.outcome,
    ...(r.challenge ? { challenge: r.challenge } : {}),
    ...(r.observedStatus !== undefined ? { observedStatus: r.observedStatus } : {}),
  };
}

/**
 * The §3 D-2 verdict, with a deliberate minimal delta on its table: "2xx"
 * becomes "2xx and challenge-free", and "responding" becomes "produced an
 * observed status" rather than `outcome === "ok"`. Both changes align the
 * stored verdict with `isBlocked` in `checks/edge.ts`, the canonical predicate
 * of the tracked check — a `200 + cf-mitigated` is a block there and must not
 * be `agents-allowed` here, and a 403 challenge whose body stream then broke is
 * real evidence the old rule discarded.
 *
 * `reachable` is deliberately not used: it means "2xx AND non-empty body", and
 * an empty 200 is still a 200 as far as the edge is concerned.
 */
function verdictFor(results: MultiUaResponse[]): EdgeVerdict {
  const responders = results.filter(responded);
  if (responders.length === 0) return "unknown";
  if (responders.every((r) => !served(r))) return "all-blocked";
  if (responders.every(served)) return "agents-allowed";
  return "mixed";
}

/**
 * Registry tokens that were not probed and could not have been: documented
 * agents with no published UA string (Claude-User today).
 *
 * `AGENT_UAS` is derived from exactly this filter's complement, so every
 * `uaString`-bearing token is probed on the homepage and only `no-ua-string`
 * can appear here. The §4.1 union's other reason, `extra-pages-only`, is a
 * per-extra-page fact and is reported per page by `checks/edge.ts` `detailsFor`
 * — never here: this payload summarises the homepage alone and persists to
 * `audit_history`, where that label would be false.
 */
function notProbedFor(probed: Set<string>): EdgeEvidence["notProbed"] {
  return BOT_TOKENS.filter((b) => b.purpose === "user" && !probed.has(b.token) && !b.uaString).map(
    (b) => ({ token: b.token, reason: "no-ua-string" as const }),
  );
}

/**
 * Summarises the homepage entry of `edgeProbe` for storage on a failure row
 * (§4.1). Extra pages are not carried: the homepage is the page that was
 * classified, and the payload is written on every failure.
 */
export function summarizeEdgeEvidence(homepage: EdgeProbePage): EdgeEvidence {
  const agents = homepage.results.map(agentOf);
  const control = homepage.control;
  return {
    verdict: verdictFor(homepage.results),
    control: {
      status: control.status,
      ...(control.challenge
        ? { vendor: control.challenge.vendor, signal: control.challenge.signal }
        : {}),
    },
    agents,
    notProbed: notProbedFor(new Set(agents.map((a) => a.token))),
  };
}

/**
 * The evidence for one agent: its observed status, the challenge vendor when
 * the edge fingerprinted as one, and the outcome whenever the fetch itself did
 * not complete. Stating the statuses keeps the line from reading as a policy
 * claim when the truth was an outage.
 */
function describeAgent(a: EdgeEvidenceAgent): string {
  if (!responded(a)) return `${a.token}: no response (${a.outcome})`;
  const challenge = a.challenge ? ` challenge (${a.challenge.vendor})` : "";
  const broke = a.outcome === "ok" ? "" : ` (${a.outcome} after the status arrived)`;
  return `${a.token}: ${evidenceStatus(a)}${challenge}${broke}`;
}

/** One plain sentence per verdict, for the CLI's failure output. */
export function formatEdgeEvidenceLine(edge: EdgeEvidence): string {
  const responders = edge.agents.filter(responded);
  const names = (list: EdgeEvidenceAgent[]) => list.map((a) => a.token).join(", ");
  const detail = edge.agents.map(describeAgent).join("; ");
  const counted = `${responders.length} of ${edge.agents.length} documented agent user-agents responded`;
  switch (edge.verdict) {
    case "agents-allowed":
      return `Same homepage, agent user-agents: ${counted}; of those, documented agent user-agents were served normally (${detail}).`;
    case "all-blocked":
      return `Same homepage, agent user-agents: ${counted}; none of them was served (${detail}).`;
    case "mixed":
      return `Same homepage, agent user-agents: ${counted}; served ${names(responders.filter(served))}, refused ${names(responders.filter((a) => !served(a)))} (${detail}).`;
    case "unknown":
      return `Same homepage, agent user-agents: no agent user-agent returned a response, so nothing can be said about agent access (${detail}).`;
  }
}
