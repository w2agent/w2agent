import type { FetchedPage } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { nextjsChecks } from "./checks.js";
import { resolveNextjsInstall } from "./install.js";
import {
  generateNextjsIntegration,
  nextjsWebhookRouteSource,
  WEBHOOK_ROUTE_PATH,
} from "./templates.js";

export const nextjsAdapter: PlatformAdapter = {
  id: "nextjs",
  name: "Next.js",
  description:
    "Next.js framework — middleware for content negotiation, route handlers for agent card",

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

  resolveInstall: resolveNextjsInstall,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find((f) => f.filename === "llms.txt")?.content || "";
    const llmsFullTxt = coreFiles.find((f) => f.filename === "llms-full.txt")?.content || "";
    const agentCard = coreFiles.find((f) => f.filename === "agent-card.json")?.content;

    const files = generateNextjsIntegration(llmsTxt, llmsFullTxt, agentCard, ctx.baseUrl);

    if (coreFiles.some((f) => f.filename.startsWith("mcp-server/"))) {
      const webhookRoute = nextjsWebhookRouteSource("ts");
      files.push({
        filename: WEBHOOK_ROUTE_PATH,
        content: webhookRoute,
        size: new TextEncoder().encode(webhookRoute).length,
      });
    }

    if (coreFiles.some((f) => f.filename.startsWith("webmcp/"))) {
      const webmcpJs = coreFiles.find((f) => f.filename === "webmcp/webmcp.js")?.content || "";
      if (webmcpJs) {
        const webmcpComponent = `"use client";

import Script from "next/script";

// Add to your root layout: import WebMcpScript from "<path to this file>"; then render <WebMcpScript /> inside <body>.
export default function WebMcpScript() {
  return (
    <Script id="w2agent-webmcp" strategy="lazyOnload">
      {${JSON.stringify(webmcpJs)}}
    </Script>
  );
}
`;
        files.push({
          filename: "nextjs/components/WebMcpScript.tsx",
          content: webmcpComponent,
          size: new TextEncoder().encode(webmcpComponent).length,
        });
      }
    }

    return files;
  },
};
