import type { FetchedPage, SiteMetadata } from "../audit/types.js";
import type { SiteTypeDetectionResult, SiteTypeDetector } from "./types.js";

const detectors: SiteTypeDetector[] = [];

export function registerSiteTypeDetector(detector: SiteTypeDetector): void {
  detectors.push(detector);
}

export function detectSiteType(
  pages: FetchedPage[],
  metadata: SiteMetadata,
): SiteTypeDetectionResult | null {
  let best: SiteTypeDetectionResult | null = null;

  for (const detector of detectors) {
    const result = detector.detect(pages, metadata);
    if (result && (!best || result.confidence > best.confidence)) {
      best = result;
    }
  }

  return best;
}
