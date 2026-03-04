import type { Check, FetchedPage, SiteMetadata } from "../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../generate/types.js";

export type PlatformId = "wordpress" | "shopify" | "nextjs" | "docusaurus";

export interface PlatformDetectionResult {
  platform: PlatformId;
  confidence: number; // 0-1
  version?: string;
  details: Record<string, string>;
}

export interface PlatformAdapter {
  id: PlatformId;
  name: string;
  description: string;

  detect(pages: FetchedPage[], metadata: SiteMetadata): PlatformDetectionResult | null;

  checks: Check[];

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[];
}
