import type { FetchedPage } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { nuxtChecks } from "./checks.js";
import { generateNuxtIntegration } from "./templates.js";

export const nuxtAdapter: PlatformAdapter = {
  id: "nuxt",
  name: "Nuxt",
  description: "Nuxt framework — Nitro server routes for llms.txt, cached event handlers",

  detect(pages: FetchedPage[]): PlatformDetectionResult | null {
    let confidence = 0;
    let version: string | undefined;
    const details: Record<string, string> = {};

    for (const page of pages) {
      // Generator meta tag (highest confidence)
      const genMatch = page.html.match(/<meta\s+name=["']generator["']\s+content=["']Nuxt\s*([\d.]*)/i);
      if (genMatch) {
        confidence = Math.max(confidence, 1.0);
        version = genMatch[1] || undefined;
        details.signal = "generator meta tag";
      }

      // __NUXT__ or __NUXT_DATA__ global
      if (page.html.includes("__NUXT_DATA__")) {
        confidence = Math.max(confidence, 0.95);
        details.nuxtData = "__NUXT_DATA__ detected";
      } else if (page.html.includes("__NUXT__")) {
        confidence = Math.max(confidence, 0.95);
        details.nuxtData = "__NUXT__ global detected";
      }

      // /_nuxt/ asset paths
      if (page.html.includes("/_nuxt/")) {
        confidence = Math.max(confidence, 0.85);
        details.assets = "/_nuxt/ assets detected";
      }

      // x-powered-by: Nuxt header
      if (page.headers["x-powered-by"]?.toLowerCase().includes("nuxt")) {
        confidence = Math.max(confidence, 0.95);
        details.header = "x-powered-by: Nuxt";
      }
    }

    if (confidence === 0) return null;

    return { platform: "nuxt", confidence, version, details };
  },

  checks: nuxtChecks,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find(f => f.filename === "llms.txt")?.content || "";
    const llmsFullTxt = coreFiles.find(f => f.filename === "llms-full.txt")?.content || "";
    const agentCard = coreFiles.find(f => f.filename === "agent-card.json")?.content || "{}";

    const files = generateNuxtIntegration(llmsTxt, llmsFullTxt, agentCard, ctx.baseUrl);

    if (coreFiles.some(f => f.filename.startsWith("mcp-server/"))) {
      const webhookRoute = `import { defineEventHandler, readBody } from "h3";

/**
 * w2agent MCP Webhook — Nuxt/Nitro Integration
 *
 * Place at: server/routes/api/w2agent-mcp-webhook.post.ts
 * Triggers a re-crawl when content changes.
 */

const WEBHOOK_URL = process.env.W2AGENT_MCP_WEBHOOK_URL || "https://w2agent.dev/api/mcp/webhook/YOUR_SLUG";
const WEBHOOK_TOKEN = process.env.W2AGENT_MCP_WEBHOOK_TOKEN || "YOUR_WEBHOOK_TOKEN";

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event);

    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${WEBHOOK_TOKEN}\`,
      },
      body: JSON.stringify({ trigger: "nuxt", ...body }),
    });

    return { ok: true };
  } catch (err) {
    event.node.res.statusCode = 500;
    return { error: (err as Error).message };
  }
});
`;
      files.push({
        filename: "nuxt/server/routes/api/w2agent-mcp-webhook.post.ts",
        content: webhookRoute,
        size: new TextEncoder().encode(webhookRoute).length,
      });
    }

    return files;
  },
};
