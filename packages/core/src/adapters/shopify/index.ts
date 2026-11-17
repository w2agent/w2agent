import type { FetchedPage } from "../../audit/types.js";
import { robotsAllowGroups } from "../../generate/robots-txt.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { shopifyChecks } from "./checks.js";
import { resolveShopifyInstall } from "./install.js";
import { detectProductSchema } from "./product-schema.js";
import { generateShopifyIntegration } from "./templates.js";
import { buildShopifyWebhookNotes } from "./webhook-notes.js";

export const shopifyAdapter: PlatformAdapter = {
  id: "shopify",
  name: "Shopify",
  description: "Shopify store — Liquid snippets, robots.txt additions, optional llms.txt template",

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
