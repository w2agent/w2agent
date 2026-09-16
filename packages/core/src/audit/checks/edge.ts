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
 * probes the subset the registry publishes a UA string for (`AGENT_UAS` in
 * `crawler.ts` is derived from exactly that filter); everything else — today
 * only Claude-User — is reported as `notProbed` and can never contribute to a
 * pass. Tokens probed on the homepage but not on an extra page are reported
 * per page in `details`, not here: they were probed.
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
  /**
   * Every comparable page carried every probed token. False once the homepage
   * probes more tokens than the extra pages do (§3 D-5), which is what decides
   * whether a message may speak of "all N probed agent user-agents" per page.
   */
  uniformProbeSet: boolean;
  /** Pages with a clean control fetch — the only comparable ones. */
  comparablePages: number;
  /**
   * Comparable pages where every token probed *on that page* answered 2xx — the
   * evidence a pass rests on. Measured per page rather than against the union
   * of all probed tokens, because extra key pages carry only the first
   * `EDGE_EXTRA_PAGE_TOKENS` tokens (§3 D-5) and would otherwise never be
   * complete.
   */
  completePages: number;
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
  // A page is complete only when every token probed *on it* answered 2xx: the
  // count a positive verdict may claim, which is not the comparable count. A
  // page with no results at all is never complete — the control was not
  // comparable, so nothing was probed there.
  const completePages = comparable.filter(
    (page) => page.results.length > 0 && page.results.every(answered2xx),
  ).length;
  const uniformProbeSet = comparable.every((page) =>
    probed.every((t) => page.results.some((r) => r.token === t)),
  );
  const base = {
    probed,
    notProbed,
    unanswered,
    uniformProbeSet,
    comparablePages: comparable.length,
    completePages,
  };

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
  // every page": some comparable page where every token probed on it answered
  // 2xx, AND no probed token that never answered anywhere. The second clause is
  // what the union rule used to give for free: with a uniform probe set
  // `unanswered` non-empty implies `completePages === 0`, but once extra pages
  // carry a subset of the tokens, a complete extra page can coexist with a
  // homepage token that was never answered — and that token must not be awarded
  // a clean bill of health.
  if (completePages === 0 || unanswered.length > 0) {
    return { outcome: "unmeasured", ...base, unmeasuredReason: "incomplete" };
  }

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

/**
 * The positive claim, worded for what was actually probed. When every
 * comparable page carried the whole probed set, "every probed agent user-agent
 * … on N of M pages" is exactly true and is left verbatim. Once the homepage
 * probes more tokens than the extra pages do (§3 D-5) it is not, so the claim
 * is scoped to the agents each page was probed under.
 */
function consistentNote(a: EdgeAccessAnalysis): string {
  if (a.uniformProbeSet) {
    return `every probed agent user-agent matched our declared crawler on ${a.completePages} of ${a.comparablePages} comparable page(s)`;
  }
  return `every agent user-agent probed on a page matched our declared crawler there, on ${a.completePages} of ${a.comparablePages} comparable page(s), and every probed agent user-agent answered on at least one of them`;
}

/** The same scoping, for the negative side of the same claim. */
function incompleteNote(a: EdgeAccessAnalysis): string {
  if (a.uniformProbeSet) {
    return `no page was answered by all ${a.probed.length} probed agent user-agents`;
  }
  return "no comparable page was answered by every agent user-agent probed on it";
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
      return `No edge difference (consistent): ${consistentNote(a)}.${notProbedNote}`;
    default:
      switch (a.unmeasuredReason) {
        case "no-control":
          return `Not measured (unmeasured): no probed page gave our declared crawler a clean 2xx (a non-2xx, a failed fetch or a challenge on the control itself), so agent responses cannot be compared.${notProbedNote}`;
        case "no-agent-response":
          return `Not measured (unmeasured): every agent user-agent fetch was skipped or failed before a response arrived.${notProbedNote}`;
        default: {
          // With a uniform probe set this is always the completeness clause: a
          // token that never answered anywhere leaves no page complete. It is
          // dropped only when a complete page coexists with such a token, which
          // the extra-page probe limit makes possible.
          const claim =
            a.completePages === 0
              ? `${incompleteNote(a)}, so "consistent" cannot be claimed — ${unansweredNote(a)}`
              : `"consistent" cannot be claimed — ${unansweredNote(a)}`;
          return `Not measured (unmeasured): ${claim}.${notProbedNote}`;
        }
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
    // Tokens probed elsewhere but not here — the `extra-pages-only` case of
    // §4.1's `notProbed` reason, which is a per-page fact and so is reported
    // per page. Only for a page that was probed at all: when the control was
    // not comparable the agent fetches are skipped wholesale, and calling that
    // "extra-pages-only" would name the wrong reason.
    if (page.results.length > 0) {
      const missing = a.probed.filter((t) => !page.results.some((r) => r.token === t));
      if (missing.length > 0) {
        lines.push(`${page.url}.notProbed: ${missing.join(", ")} (extra-pages-only)`);
      }
    }
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
