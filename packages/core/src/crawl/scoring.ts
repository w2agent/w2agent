import { getUrlDepth, getUrlPatternScore } from "../shared/page-scoring.js";
import type { DiscoveredPage } from "./discovery.js";

function monthsSince(isoDate: string): number {
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return Infinity;
  const now = new Date();
  return Math.max(
    0,
    (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth()),
  );
}

function lastmodRecencyScore(isoDate?: string): number {
  if (!isoDate) return 0;
  const months = monthsSince(isoDate);
  if (months <= 1) return 5;
  if (months <= 3) return 4;
  if (months <= 6) return 3;
  if (months <= 12) return 2;
  if (months <= 24) return 1;
  return 0;
}

export function scorePage(page: DiscoveredPage): number {
  let score = 0;
  const pathname = new URL(page.url).pathname;

  if (pathname === "/" || pathname === "") {
    score += 20;
  } else {
    score += getUrlPatternScore(pathname);
  }

  score += Math.max(0, 5 - getUrlDepth(pathname));

  if (page.sitemapPriority !== undefined) {
    score += page.sitemapPriority * 10;
  }

  score += lastmodRecencyScore(page.sitemapLastmod);

  score += Math.min(5, Math.floor(page.internalLinkCount / 3));

  if (page.queritRank != null) {
    score += Math.max(0, 11 - Math.ceil(page.queritRank / 10));
  }

  return score;
}

export function sortPagesByScore(pages: DiscoveredPage[]): DiscoveredPage[] {
  return [...pages].sort((a, b) => scorePage(b) - scorePage(a));
}
