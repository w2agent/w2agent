import type { DiscoveredPage } from "./discovery.js";
import { sortPagesByScore } from "./scoring.js";

export function selectPages(
  discovered: DiscoveredPage[],
  maxPages: number,
  exclude?: Set<string>,
): DiscoveredPage[] {
  const filtered = exclude ? discovered.filter((p) => !exclude.has(p.url)) : discovered;
  const sorted = sortPagesByScore(filtered);
  return sorted.slice(0, maxPages);
}
