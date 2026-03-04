import type { FetchedPage, SiteMetadata } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { wordpressChecks } from "./checks.js";
import { generateWpPlugin } from "./templates.js";

export const wordpressAdapter: PlatformAdapter = {
  id: "wordpress",
  name: "WordPress",
  description: "WordPress CMS — serves llms.txt via plugin, hooks into robots_txt filter",

  detect(pages: FetchedPage[], metadata: SiteMetadata): PlatformDetectionResult | null {
    let confidence = 0;
    let version: string | undefined;
    const details: Record<string, string> = {};

    for (const page of pages) {
      // Generator meta tag (highest confidence)
      const genMatch = page.html.match(/<meta\s+name=["']generator["']\s+content=["']WordPress\s*([\d.]*)/i);
      if (genMatch) {
        confidence = Math.max(confidence, 1.0);
        version = genMatch[1] || undefined;
        details.signal = "generator meta tag";
      }

      // wp-content / wp-includes paths
      if (page.html.includes("/wp-content/") || page.html.includes("/wp-includes/")) {
        confidence = Math.max(confidence, 0.95);
        details.assets = "wp-content/wp-includes detected";
      }

      // wp-json link header
      if (page.headers["link"]?.includes("wp-json") || page.html.includes("wp-json")) {
        confidence = Math.max(confidence, 0.85);
        details.api = "wp-json link detected";
      }
    }

    if (confidence === 0) return null;

    return { platform: "wordpress", confidence, version, details };
  },

  checks: wordpressChecks,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find(f => f.filename === "llms.txt")?.content || "";
    const agentCard = coreFiles.find(f => f.filename === "agent-card.json")?.content || "{}";
    const robotsTxt = coreFiles.find(f => f.filename === "robots.txt")?.content || "";

    // Extract just the AI-specific rules from generated robots.txt
    const robotsRules = robotsTxt
      .split("\n")
      .filter(line => line.trim() && !line.startsWith("Sitemap:"))
      .join("\n");

    return generateWpPlugin(llmsTxt, agentCard, robotsRules, ctx.baseUrl);
  },
};
