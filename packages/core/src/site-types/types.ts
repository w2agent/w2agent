import type { FetchedPage, SiteMetadata } from "../audit/types.js";

export type SiteType = "ecommerce";

export interface SiteTypeDetectionResult {
  siteType: SiteType;
  confidence: number; // 0-1
  signals: string[];
}

export interface SiteTypeDetector {
  siteType: SiteType;
  detect(pages: FetchedPage[], metadata: SiteMetadata): SiteTypeDetectionResult | null;
}
