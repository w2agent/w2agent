import type { FetchedPage } from "../../audit/types.js";
import { robotsAllowGroups } from "../../generate/robots-txt.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import { pageMarkers } from "../shared/page-markers.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { shopifyChecks } from "./checks.js";
import { resolveShopifyInstall } from "./install.js";
import { detectProductSchema } from "./product-schema.js";
import { generateShopifyIntegration } from "./templates.js";
import { buildShopifyWebhookNotes } from "./webhook-notes.js";

const SHOPIFY_CDN = /^(?:[a-z][a-z0-9+.-]*:)?\/\/cdn\.shopify\.com(?:[/:?#]|$)/i;

function hostEndsWithMyshopify(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".myshopify.com");
  } catch {
    return false;
  }
}

export const shopifyAdapter: PlatformAdapter = {
  id: "shopify",
  name: "Shopify",
  description: "Shopify store — Liquid snippets, robots.txt additions, optional llms.txt template",

  detect(pages: FetchedPage[]): PlatformDetectionResult | null {
    let confidence = 0;
    const details: Record<string, string> = {};

    for (const page of pages) {
      const markers = pageMarkers(page);

      if (markers.assetUrls.some((u) => SHOPIFY_CDN.test(u))) {
        confidence = Math.max(confidence, 0.95);
        details.cdn = "cdn.shopify.com assets detected";
      }

      if (page.headers["x-shopify-stage"] || page.headers["x-sorting-hat-shopid"]) {
        confidence = Math.max(confidence, 0.95);
        details.header = "Shopify server headers detected";
      }

      if (hostEndsWithMyshopify(page.url)) {
        confidence = Math.max(confidence, 0.9);
        details.domain = "myshopify.com domain";
      }

      if (
        markers.codeScripts.some((c) => /\bShopify\.theme\b/.test(c)) ||
        markers.$("script#shopify-features").length > 0
      ) {
        confidence = Math.max(confidence, 0.9);
        details.theme = "Shopify theme JS detected";
      }
    }

    if (confidence === 0) return null;

    return { platform: "shopify", confidence, details };
  },

  checks: shopifyChecks,

  resolveInstall: resolveShopifyInstall,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find((f) => f.filename === "llms.txt")?.content || "";
    const robotsGroups = robotsAllowGroups(ctx.metadata.robotsTxt, ctx.baseUrl);

    const hasMcpServer = coreFiles.some((f) => f.filename.startsWith("mcp-server/"));
    const webmcpJs = coreFiles.find((f) => f.filename === "webmcp/webmcp.js")?.content || "";
    const files = generateShopifyIntegration(llmsTxt, robotsGroups, ctx.baseUrl, {
      webmcp: webmcpJs !== "",
      mcpWebhook: hasMcpServer,
      productSchema: detectProductSchema(ctx.rawPages),
    });

    if (hasMcpServer) {
      const webhookInstructions = buildShopifyWebhookNotes();
      files.push({
        filename: "shopify/W2AGENT-MCP-WEBHOOK.md",
        content: webhookInstructions,
        size: new TextEncoder().encode(webhookInstructions).length,
      });
    }

    if (webmcpJs) {
      const webmcpLiquid = `{% comment %}
  W2Agent WebMCP Registration
  Include in theme.liquid before </body>: {% render 'w2agent-webmcp' %}
{% endcomment %}
<script>
${webmcpJs}
</script>
`;
      files.push({
        filename: "shopify/snippets/w2agent-webmcp.liquid",
        content: webmcpLiquid,
        size: new TextEncoder().encode(webmcpLiquid).length,
      });
    }

    return files;
  },
};
