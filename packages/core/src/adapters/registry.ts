import type { FetchedPage, SiteMetadata } from "../audit/types.js";
import type { PlatformAdapter, PlatformDetectionResult, PlatformId } from "./types.js";

const adapters = new Map<PlatformId, PlatformAdapter>();

export function registerAdapter(adapter: PlatformAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: PlatformId): PlatformAdapter | undefined {
  return adapters.get(id);
}

export function allAdapters(): PlatformAdapter[] {
  return [...adapters.values()];
}

const TIE_ORDER: string[] = ["nextjs", "nuxt", "astro", "docusaurus", "shopify", "wordpress"];

function tieRank(id: string): number {
  const rank = TIE_ORDER.indexOf(id);
  return rank === -1 ? TIE_ORDER.length : rank;
}

function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}/`;
  } catch {
    return null;
  }
}

function findHomepage(pages: FetchedPage[], metadata: SiteMetadata): FetchedPage | undefined {
  const base = pageKey(metadata.baseUrl);
  const homeKey = base ? `${new URL(metadata.baseUrl).origin}/` : null;
  return pages.find((p) => homeKey !== null && pageKey(p.url) === homeKey) ?? pages[0];
}

function bestMatch(pages: FetchedPage[], metadata: SiteMetadata): PlatformDetectionResult | null {
  let best: PlatformDetectionResult | null = null;

  for (const adapter of adapters.values()) {
    const result = adapter.detect(pages, metadata);
    if (
      result &&
      (!best ||
        result.confidence > best.confidence ||
        (result.confidence === best.confidence &&
          tieRank(result.platform) < tieRank(best.platform)))
    ) {
      best = result;
    }
  }

  return best;
}

export function detectPlatform(
  pages: FetchedPage[],
  metadata: SiteMetadata,
): PlatformDetectionResult | null {
  const homepage = findHomepage(pages, metadata);
  if (!homepage) return null;
  return bestMatch([homepage], metadata) ?? (pages.length > 1 ? bestMatch(pages, metadata) : null);
}
