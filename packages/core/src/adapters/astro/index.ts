import type { FetchedPage } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { astroChecks } from "./checks.js";
import { resolveAstroInstall } from "./install.js";
import { generateAstroIntegration } from "./templates.js";

export const astroAdapter: PlatformAdapter = {
  id: "astro",
  name: "Astro",
  description: "Astro framework — static-first with optional SSR endpoints for AI content",

  detect(pages: FetchedPage[]): PlatformDetectionResult | null {
    let confidence = 0;
    let version: string | undefined;
    const details: Record<string, string> = {};

    for (const page of pages) {
      // Generator meta tag (highest confidence) — Astro uses "Astro vX.X"
      const genMatch = page.html.match(
        /<meta\s+name=["']generator["']\s+content=["']Astro\s*v?([\d.]*)/i,
      );
      if (genMatch) {
        confidence = Math.max(confidence, 1.0);
        version = genMatch[1] || undefined;
        details.signal = "generator meta tag";
      }

      // astro-island custom elements
      if (page.html.includes("astro-island")) {
        confidence = Math.max(confidence, 0.95);
        details.island = "astro-island custom element detected";
      }

      // data-astro-cid-* attributes
      if (/data-astro-cid-/i.test(page.html)) {
        confidence = Math.max(confidence, 0.9);
        details.cid = "data-astro-cid attributes detected";
      }

      // /_astro/ asset paths
      if (page.html.includes("/_astro/")) {
        confidence = Math.max(confidence, 0.85);
        details.assets = "/_astro/ assets detected";
      }
    }

    if (confidence === 0) return null;

    return { platform: "astro", confidence, version, details };
  },

  checks: astroChecks,

  resolveInstall: resolveAstroInstall,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find((f) => f.filename === "llms.txt")?.content || "";
    const llmsFullTxt = coreFiles.find((f) => f.filename === "llms-full.txt")?.content || "";
    const agentCard = coreFiles.find((f) => f.filename === "agent-card.json")?.content;

    const files = generateAstroIntegration(llmsTxt, llmsFullTxt, agentCard, ctx.baseUrl);

    if (coreFiles.some((f) => f.filename.startsWith("mcp-server/"))) {
      const webhookPlugin = `/**
 * w2agent MCP Webhook — Astro Integration
 *
 * Add to astro.config.mjs integrations array:
 *   import w2agentMcpWebhook from "./w2agent-mcp-webhook.mjs";
 *   integrations: [w2agentMcpWebhook()]
 *
 * Triggers a re-crawl of your MCP server after each build.
 */
export default function w2agentMcpWebhook() {
  return {
    name: "w2agent-mcp-webhook",
    hooks: {
      "astro:build:done": async ({ logger }) => {
        const webhookUrl = process.env.W2AGENT_WEBHOOK_URL || "https://w2agent.dev/api/agent/webhook/YOUR_SLUG";
        const token = process.env.W2AGENT_WEBHOOK_TOKEN || "YOUR_WEBHOOK_TOKEN";

        try {
          const res = await fetch(webhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: \`Bearer \${token}\`,
            },
            body: JSON.stringify({ trigger: "astro", event: "build:done" }),
          });
          logger.info(\`agent webhook: \${res.status}\`);
        } catch (err) {
          logger.warn("agent webhook failed: " + (err as Error).message);
        }
      },
    },
  };
}
`;
      files.push({
        filename: "astro/w2agent-mcp-webhook.mjs",
        content: webhookPlugin,
        size: new TextEncoder().encode(webhookPlugin).length,
      });
    }

    if (coreFiles.some((f) => f.filename.startsWith("webmcp/"))) {
      const webmcpJs = coreFiles.find((f) => f.filename === "webmcp/webmcp.js")?.content || "";
      if (webmcpJs) {
        const webmcpAstro = `---
// W2Agent WebMCP Registration
// Add to your layout: <WebMcpScript />
---
<script>
${webmcpJs}
</script>
`;
        files.push({
          filename: "astro/src/components/WebMcpScript.astro",
          content: webmcpAstro,
          size: new TextEncoder().encode(webmcpAstro).length,
        });
      }
    }

    return files;
  },
};
