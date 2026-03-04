import type { FetchedPage } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { docusaurusChecks } from "./checks.js";
import { generateDocusaurusIntegration } from "./templates.js";

export const docusaurusAdapter: PlatformAdapter = {
  id: "docusaurus",
  name: "Docusaurus",
  description: "Docusaurus docs site — build plugin to generate llms.txt from sidebar",

  detect(pages: FetchedPage[]): PlatformDetectionResult | null {
    let confidence = 0;
    let version: string | undefined;
    const details: Record<string, string> = {};

    for (const page of pages) {
      // Generator meta tag (highest confidence)
      const genMatch = page.html.match(/<meta\s+name=["']generator["']\s+content=["']Docusaurus\s*v?([\d.]*)/i);
      if (genMatch) {
        confidence = Math.max(confidence, 1.0);
        version = genMatch[1] || undefined;
        details.signal = "generator meta tag";
      }

      // docusaurus class on <html>
      if (page.html.match(/<html[^>]+class=["'][^"']*docusaurus/i)) {
        confidence = Math.max(confidence, 0.95);
        details.htmlClass = "docusaurus class on <html>";
      }

      // Docusaurus-specific DOM elements
      if (page.html.includes("docusaurus-") || page.html.includes("theme-doc-")) {
        confidence = Math.max(confidence, 0.9);
        details.dom = "Docusaurus theme elements detected";
      }
    }

    if (confidence === 0) return null;

    return { platform: "docusaurus", confidence, version, details };
  },

  checks: docusaurusChecks,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find(f => f.filename === "llms.txt")?.content || "";
    const agentCard = coreFiles.find(f => f.filename === "agent-card.json")?.content || "{}";

    return generateDocusaurusIntegration(llmsTxt, agentCard, ctx.baseUrl);
  },
};
