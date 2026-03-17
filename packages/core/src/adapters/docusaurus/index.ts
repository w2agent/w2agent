import type { FetchedPage } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { docusaurusChecks } from "./checks.js";
import { resolveDocusaurusInstall } from "./install.js";
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
      const genMatch = page.html.match(
        /<meta\s+name=["']generator["']\s+content=["']Docusaurus\s*v?([\d.]*)/i,
      );
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

  resolveInstall: resolveDocusaurusInstall,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find((f) => f.filename === "llms.txt")?.content || "";
    const agentCard = coreFiles.find((f) => f.filename === "agent-card.json")?.content || "{}";

    const files = generateDocusaurusIntegration(llmsTxt, agentCard, ctx.baseUrl);

    if (coreFiles.some((f) => f.filename.startsWith("mcp-server/"))) {
      const postBuildPlugin = `/**
 * w2agent MCP Webhook — Docusaurus Plugin
 *
 * Add to docusaurus.config.js plugins array:
 * plugins: [require.resolve('./w2agent-mcp-webhook-plugin')],
 *
 * Triggers a re-crawl of your MCP server after each build.
 */
module.exports = function w2agentMcpWebhookPlugin() {
  return {
    name: "w2agent-mcp-webhook",
    async postBuild() {
      const webhookUrl = process.env.W2AGENT_WEBHOOK_URL || "https://w2agent.dev/api/agent/webhook/YOUR_SLUG";
      const token = process.env.W2AGENT_MCP_WEBHOOK_TOKEN || "YOUR_WEBHOOK_TOKEN";

      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: \`Bearer \${token}\`,
          },
          body: JSON.stringify({ trigger: "docusaurus", event: "postBuild" }),
        });
        console.log(\`[w2agent] agent webhook: \${res.status}\`);
      } catch (err) {
        console.warn("[w2agent] agent webhook failed:", err.message);
      }
    },
  };
};
`;
      files.push({
        filename: "docusaurus/w2agent-mcp-webhook-plugin.js",
        content: postBuildPlugin,
        size: new TextEncoder().encode(postBuildPlugin).length,
      });
    }

    if (coreFiles.some((f) => f.filename.startsWith("webmcp/"))) {
      const webmcpJs = coreFiles.find((f) => f.filename === "webmcp/webmcp.js")?.content || "";
      if (webmcpJs) {
        const webmcpModule = `// W2Agent WebMCP Registration
// Add to docusaurus.config.js clientModules: ['./w2agent-webmcp-module.js']
${webmcpJs}
`;
        files.push({
          filename: "docusaurus/w2agent-webmcp-module.js",
          content: webmcpModule,
          size: new TextEncoder().encode(webmcpModule).length,
        });
      }
    }

    return files;
  },
};
