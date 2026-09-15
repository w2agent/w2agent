import type { MultiUaResponse } from "../types.js";

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
