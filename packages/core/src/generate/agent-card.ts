import { extractSiteInfo } from "./llms-txt.js";
import type { GenerateContext } from "./types.js";

interface AgentCard {
  name: string;
  description: string;
  url: string;
  provider: { organization: string; url: string };
  version: string;
  capabilities: Record<string, boolean>;
  skills: { id: string; name: string; description: string }[];
}

export function generateAgentCard(ctx: GenerateContext): AgentCard {
  const { siteName, siteDescription } = extractSiteInfo(ctx.pages, ctx.baseUrl);

  const capabilities: Record<string, boolean> = {
    llmsTxt: false,
    structuredData: false,
    searchAction: false,
    sitemapXml: false,
    robotsTxt: false,
  };

  // Detect capabilities from crawled data
  if (ctx.metadata.llmsTxt) {
    capabilities.llmsTxt = true;
  }

  if (ctx.metadata.sitemapXml) {
    capabilities.sitemapXml = true;
  }

  if (ctx.metadata.robotsTxt) {
    capabilities.robotsTxt = true;
  }

  // Check for SearchAction in JSON-LD across pages
  for (const page of ctx.rawPages) {
    if (!page.html) continue;
    if (page.html.includes("SearchAction")) {
      capabilities.searchAction = true;
      break;
    }
  }

  // Check for structured data in any page
  for (const page of ctx.rawPages) {
    if (!page.html) continue;
    if (page.html.includes("application/ld+json")) {
      capabilities.structuredData = true;
      break;
    }
  }

  const skills: AgentCard["skills"] = [];

  if (capabilities.llmsTxt) {
    skills.push({
      id: "llms-txt",
      name: "LLMs.txt",
      description: "Provides structured content index for LLM consumption",
    });
  }

  if (capabilities.searchAction) {
    skills.push({
      id: "search",
      name: "Site Search",
      description: "Supports search queries via SearchAction schema",
    });
  }

  if (capabilities.structuredData) {
    skills.push({
      id: "structured-data",
      name: "Structured Data",
      description: "Provides JSON-LD structured data for content understanding",
    });
  }

  return {
    name: siteName,
    description: siteDescription || `AI-ready content from ${siteName}`,
    url: ctx.baseUrl,
    provider: {
      organization: siteName,
      url: ctx.baseUrl,
    },
    version: "1.0.0",
    capabilities,
    skills,
  };
}
