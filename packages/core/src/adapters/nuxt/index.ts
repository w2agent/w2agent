import type { FetchedPage } from "../../audit/types.js";
import type { GenerateContext, GeneratedFile } from "../../generate/types.js";
import { generatorVersion, pageMarkers } from "../shared/page-markers.js";
import type { PlatformAdapter, PlatformDetectionResult } from "../types.js";
import { nuxtChecks } from "./checks.js";
import { resolveNuxtInstall } from "./install.js";
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
      const markers = pageMarkers(page);

      const generator = generatorVersion(markers, /^Nuxt\s*([\d.]*)/i);
      if (generator) {
        confidence = Math.max(confidence, 1.0);
        version = generator.version;
        details.signal = "generator meta tag";
      }

      if (markers.$("script#__NUXT_DATA__").length > 0) {
        confidence = Math.max(confidence, 0.95);
        details.nuxtData = "__NUXT_DATA__ detected";
      } else if (markers.codeScripts.some((c) => c.includes("__NUXT__"))) {
        confidence = Math.max(confidence, 0.95);
        details.nuxtData = "__NUXT__ global detected";
      }

      if (markers.assetUrls.some((u) => u.includes("/_nuxt/"))) {
        confidence = Math.max(confidence, 0.85);
        details.assets = "/_nuxt/ assets detected";
      }

      if (page.headers["x-powered-by"]?.toLowerCase().includes("nuxt")) {
        confidence = Math.max(confidence, 0.95);
        details.header = "x-powered-by: Nuxt";
      }
    }

    if (confidence === 0) return null;

    return { platform: "nuxt", confidence, version, details };
  },

  checks: nuxtChecks,

  resolveInstall: resolveNuxtInstall,

  generateIntegration(ctx: GenerateContext, coreFiles: GeneratedFile[]): GeneratedFile[] {
    const llmsTxt = coreFiles.find((f) => f.filename === "llms.txt")?.content || "";
    const llmsFullTxt = coreFiles.find((f) => f.filename === "llms-full.txt")?.content || "";
    const agentCard = coreFiles.find((f) => f.filename === "agent-card.json")?.content;

    const files = generateNuxtIntegration(llmsTxt, llmsFullTxt, agentCard, ctx.baseUrl);

    if (coreFiles.some((f) => f.filename.startsWith("mcp-server/"))) {
      const webhookRoute = `import { createError, defineEventHandler, getHeader, readBody } from "h3";

/**
 * w2agent MCP Webhook — Nuxt/Nitro Integration
 *
 * Place at: server/routes/api/w2agent-mcp-webhook.post.ts
 * Triggers a re-crawl when content changes.
 *
 * Requires W2AGENT_INBOUND_TOKEN; callers must present it as a Bearer token.
 * Without this check the route is a confused deputy — unauthenticated callers
 * would otherwise receive authenticated upstream webhook calls for free.
 */

const WEBHOOK_URL = process.env.W2AGENT_WEBHOOK_URL || "https://w2agent.dev/api/agent/webhook/YOUR_SLUG";
const WEBHOOK_TOKEN = process.env.W2AGENT_WEBHOOK_TOKEN || "YOUR_WEBHOOK_TOKEN";

export default defineEventHandler(async (event) => {
  const expected = process.env.W2AGENT_INBOUND_TOKEN;
  if (!expected) {
    throw createError({ statusCode: 401, statusMessage: "W2AGENT_INBOUND_TOKEN not configured" });
  }
  const header = getHeader(event, "authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented !== expected) {
    throw createError({ statusCode: 401, statusMessage: "unauthorized" });
  }

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

    if (coreFiles.some((f) => f.filename.startsWith("webmcp/"))) {
      const webmcpJs = coreFiles.find((f) => f.filename === "webmcp/webmcp.js")?.content || "";
      if (webmcpJs) {
        const webmcpPlugin = `// W2Agent WebMCP Registration
// Client-only Nuxt plugin — registers forms as AI tools via document.modelContext (WebMCP)
export default defineNuxtPlugin(() => {
  if (import.meta.client) {
    ${webmcpJs.split("\n").join("\n    ")}
  }
});
`;
        files.push({
          filename: "nuxt/plugins/w2agent-webmcp.client.ts",
          content: webmcpPlugin,
          size: new TextEncoder().encode(webmcpPlugin).length,
        });
      }
    }

    return files;
  },
};
