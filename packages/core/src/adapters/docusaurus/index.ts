import type { FetchedPage } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import { generatorVersion, hasClassToken, pageMarkers } from "../shared/page-markers.js";
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
      const markers = pageMarkers(page);
      const { $ } = markers;

      const generator = generatorVersion(markers, /^Docusaurus\s*v?([\d.]*)/i);
      if (generator) {
        confidence = Math.max(confidence, 1.0);
        version = generator.version;
        details.signal = "generator meta tag";
      }

      if (hasClassToken($("html").attr("class"), "docusaurus")) {
        confidence = Math.max(confidence, 0.95);
        details.htmlClass = "docusaurus class on <html>";
      }

      const themed = $("[class]")
        .toArray()
        .some((el) => {
          const cls = $(el).attr("class");
          return hasClassToken(cls, "theme-doc-") || hasClassToken(cls, "docusaurus");
        });
      if ($("#__docusaurus").length > 0 || themed) {
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
    const agentCard = coreFiles.find((f) => f.filename === "agent-card.json")?.content;

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
      const token = process.env.W2AGENT_WEBHOOK_TOKEN || "YOUR_WEBHOOK_TOKEN";

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
// Add to docusaurus.config.js: clientModules: ["./w2agent-webmcp-module.js"],
// Docusaurus imports client modules during the server-side render too, so the script only runs in a browser.
if (typeof window === "object" && typeof document === "object") {
${webmcpJs}
}
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
