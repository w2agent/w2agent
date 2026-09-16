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
 * The status this result is evidence of, including one observed on the wire
 * before a body-read error erased the scorable response (`observedStatus`).
 * 0 when nothing was observed at all.
 */
export function evidenceStatus(r: MultiUaResponse): number {
  return r.outcome === "ok" ? r.status : (r.observedStatus ?? 0);
}

function agentOf(r: MultiUaResponse): EdgeEvidenceAgent {
  return {
    token: r.token,
    status: r.status,
    outcome: r.outcome,
    ...(r.challenge ? { challenge: r.challenge } : {}),
  };
}

/**
 * The §3 D-2 verdict, computed only over agents that actually returned a
 * response. `reachable` is deliberately not used: it means "2xx AND non-empty
 * body", and an empty 200 is still a 200 as far as the edge is concerned.
 */
function verdictFor(agents: EdgeEvidenceAgent[]): EdgeVerdict {
  const responding = agents.filter((a) => a.outcome === "ok");
  if (responding.length === 0) return "unknown";
  if (responding.every((a) => !is2xx(a.status))) return "all-blocked";
  if (responding.every((a) => is2xx(a.status))) return "agents-allowed";
  return "mixed";
}

/**
 * Registry tokens an agent could have been probed under but wasn't, with the
 * reason. `uaString` is the gate, not `hasUA`: Claude-User is documented but
 * Anthropic publishes no UA string.
 */
function notProbedFor(probed: Set<string>): EdgeEvidence["notProbed"] {
  return BOT_TOKENS.filter((b) => b.purpose === "user" && !probed.has(b.token)).map((b) => ({
    token: b.token,
    reason: b.uaString ? ("extra-pages-only" as const) : ("no-ua-string" as const),
  }));
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
    verdict: verdictFor(agents),
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

/** One plain sentence per verdict, for the CLI's failure output. */
export function formatEdgeEvidenceLine(edge: EdgeEvidence): string {
  const responding = edge.agents.filter((a) => a.outcome === "ok");
  const names = (list: EdgeEvidenceAgent[]) => list.map((a) => a.token).join(", ");
  switch (edge.verdict) {
    case "agents-allowed":
      return `Same homepage, agent user-agents: documented agent user-agents were served normally (${names(responding)}).`;
    case "all-blocked":
      return `Same homepage, agent user-agents: every documented agent user-agent was blocked too (${names(responding)}).`;
    case "mixed":
      return `Same homepage, agent user-agents: mixed results — served ${names(responding.filter((a) => is2xx(a.status)))}; blocked ${names(responding.filter((a) => !is2xx(a.status)))}.`;
    case "unknown":
      return "Same homepage, agent user-agents: no agent user-agent returned a response, so nothing can be said about agent access.";
  }
}
