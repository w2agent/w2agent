import { extractSiteInfo } from "./llms-txt.js";
import type { GenerateContext } from "./types.js";

interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: { url: string; protocolBinding: string; protocolVersion: string }[];
  provider: { organization: string; url: string };
  version: string;
  capabilities: Record<string, never>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: { id: string; name: string; description: string; tags: string[] }[];
}

export function generateAgentCard(
  ctx: GenerateContext,
  options?: { a2aEndpoint?: string },
): AgentCard | null {
  if (!options?.a2aEndpoint) return null;

  const { siteName, siteDescription } = extractSiteInfo(ctx.pages, ctx.baseUrl);

  const hasSearchAction = ctx.rawPages.some((page) => page.html?.includes("SearchAction"));
  const hasStructuredData = ctx.rawPages.some((page) => page.html?.includes("application/ld+json"));

  const skills: AgentCard["skills"] = [];

  if (ctx.metadata.llmsTxt) {
    skills.push({
      id: "llms-txt",
      name: "LLMs.txt",
      description: "Provides structured content index for LLM consumption",
      tags: ["llms-txt", "documentation"],
    });
  }

  if (hasSearchAction) {
    skills.push({
      id: "search",
      name: "Site Search",
      description: "Supports search queries via SearchAction schema",
      tags: ["search"],
    });
  }

  if (hasStructuredData) {
    skills.push({
      id: "structured-data",
      name: "Structured Data",
      description: "Provides JSON-LD structured data for content understanding",
      tags: ["structured-data", "schema-org"],
    });
  }

  return {
    name: siteName,
    description: siteDescription || `AI-ready content from ${siteName}`,
    supportedInterfaces: [
      {
        url: options.a2aEndpoint,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    provider: {
      organization: siteName,
      url: ctx.baseUrl,
    },
    version: "1.0.0",
    capabilities: {},
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
  };
}
