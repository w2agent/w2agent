import type { FetchedPage, SiteMetadata } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { nextjsChecks } from "./checks.js";
import { generateNextjsIntegration } from "./templates.js";

export const nextjsAdapter: PlatformAdapter = {
  id: "nextjs",
  name: "Next.js",
  description: "Next.js framework — middleware for content negotiation, route handlers for agent card",

  detect(pages: FetchedPage[]): PlatformDetectionResult | null {
    let confidence = 0;
    let version: string | undefined;
    const details: Record<string, string> = {};

    for (const page of pages) {
      // __NEXT_DATA__ script tag (highest confidence)
      if (page.html.includes("__NEXT_DATA__")) {
        confidence = Math.max(confidence, 1.0);
        details.signal = "__NEXT_DATA__ script tag";

        // Try to extract version from build manifest
        const versionMatch = page.html.match(/"nextVersion":"([^"]+)"/);
        if (versionMatch) version = versionMatch[1];
      }

      // _next/static in asset paths
      if (page.html.includes("/_next/static/") || page.html.includes("/_next/image")) {
        confidence = Math.max(confidence, 0.95);
        details.assets = "_next/static assets detected";
      }

      // x-powered-by: Next.js header
      if (page.headers["x-powered-by"]?.toLowerCase().includes("next.js")) {
        confidence = Math.max(confidence, 0.95);
        details.header = "x-powered-by: Next.js";
      }
    }

    if (confidence === 0) return null;

    return { platform: "nextjs", confidence, version, details };
  },

  checks: nextjsChecks,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find(f => f.filename === "llms.txt")?.content || "";
    const llmsFullTxt = coreFiles.find(f => f.filename === "llms-full.txt")?.content || "";
    const agentCard = coreFiles.find(f => f.filename === "agent-card.json")?.content || "{}";

    return generateNextjsIntegration(llmsTxt, llmsFullTxt, agentCard, ctx.baseUrl);
  },
};
