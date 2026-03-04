import type { FetchedPage, SiteMetadata } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { shopifyChecks } from "./checks.js";
import { generateShopifyIntegration } from "./templates.js";

export const shopifyAdapter: PlatformAdapter = {
  id: "shopify",
  name: "Shopify",
  description: "Shopify store — Liquid snippets, robots.txt.liquid, page-based llms.txt",

  detect(pages: FetchedPage[]): PlatformDetectionResult | null {
    let confidence = 0;
    const details: Record<string, string> = {};

    for (const page of pages) {
      // cdn.shopify.com assets (high confidence)
      if (page.html.includes("cdn.shopify.com")) {
        confidence = Math.max(confidence, 0.95);
        details.cdn = "cdn.shopify.com assets detected";
      }

      // Shopify server header
      if (page.headers["x-shopify-stage"] || page.headers["x-sorting-hat-shopid"]) {
        confidence = Math.max(confidence, 0.95);
        details.header = "Shopify server headers detected";
      }

      // myshopify.com in URL
      if (page.url.includes("myshopify.com")) {
        confidence = Math.max(confidence, 0.9);
        details.domain = "myshopify.com domain";
      }

      // Shopify-specific meta tags
      if (page.html.includes("Shopify.theme") || page.html.includes("shopify-features")) {
        confidence = Math.max(confidence, 0.9);
        details.theme = "Shopify theme JS detected";
      }
    }

    if (confidence === 0) return null;

    return { platform: "shopify", confidence, details };
  },

  checks: shopifyChecks,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find(f => f.filename === "llms.txt")?.content || "";
    const robotsTxt = coreFiles.find(f => f.filename === "robots.txt")?.content || "";

    const robotsAdditions = robotsTxt
      .split("\n")
      .filter(line => line.trim() && !line.startsWith("Sitemap:"))
      .join("\n");

    return generateShopifyIntegration(llmsTxt, robotsAdditions, ctx.baseUrl);
  },
};
