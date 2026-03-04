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

export function detectPlatform(
  pages: FetchedPage[],
  metadata: SiteMetadata,
): PlatformDetectionResult | null {
  let best: PlatformDetectionResult | null = null;

  for (const adapter of adapters.values()) {
    const result = adapter.detect(pages, metadata);
    if (result && (!best || result.confidence > best.confidence)) {
      best = result;
    }
  }

  return best;
}
