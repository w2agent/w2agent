import { detectPlatform, getAdapter } from "../adapters/registry.js";
import { crawlSite } from "../audit/crawler.js";
import type { AuditOptions, FetchedPage } from "../audit/types.js";
import { fetchPage } from "../shared/fetcher.js";
import { parseHTML } from "../shared/html-parser.js";
import { sortUrlsByScore } from "../shared/page-scoring.js";
import { detectSiteType } from "../site-types/index.js";
import { generateAgentCard } from "./agent-card.js";
import { generateAgentsMd } from "./agents-md.js";
import { buildEcommerceArtifacts, generateProductCatalog } from "./ecommerce.js";
import { generateFaq } from "./faq.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { generateLlmsFullTxt } from "./llms-full-txt.js";
import { extractSiteInfo, generateLlmsTxt } from "./llms-txt.js";
import { buildLocalBusinessArtifacts, generateBusinessInfoTable } from "./local-business.js";
import { matchesSections, yamlFrontmatter } from "./markdown-text.js";
import { generateMcpServer } from "./mcp-server.js";
import { generateRobotsTxt } from "./robots-txt.js";
import { generateSchemaOrg } from "./schema-org.js";
import { generateSkillMd } from "./skill-md.js";
import { generateOpenClawSkillMd } from "./skill-md-openclaw.js";
import type {
  GenerateContext,
  GeneratedFile,
  GenerateOptions,
  GenerateResult,
  PageMarkdown,
} from "./types.js";
import { DEFAULT_GENERATE_OPTIONS as DEFAULTS } from "./types.js";
import { generateWebMcp } from "./webmcp.js";

export async function runGenerate(
  url: string,
  optionsOverride: Partial<GenerateOptions> = {},
  onProgress?: (status: string) => void,
): Promise<GenerateResult> {
  const start = Date.now();

  const options: GenerateOptions = { ...DEFAULTS, ...optionsOverride };

  // Normalize URL
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  // Reuse the audit crawler — it handles sitemap, robots.txt, batching
  const crawlOptions: AuditOptions = {
    maxPages: options.maxPages,
    timeout: options.timeout,
    userAgent: options.userAgent,
    verbose: false,
    ...(options.allowedOffOriginHosts
      ? { allowedOffOriginHosts: options.allowedOffOriginHosts }
      : {}),
    ...(options.isAllowedTarget ? { isAllowedTarget: options.isAllowedTarget } : {}),
  };

  onProgress?.("Crawling site...");
  const { pages, metadata, totalUrlsFound } = await crawlSite(url, crawlOptions, onProgress);
  let totalPagesFound = totalUrlsFound;

  // Fallback: if sitemap yielded no extra pages, discover via internal links
  if (pages.length <= 1 && options.maxPages > 1) {
    const baseUrl = new URL(url).origin;
    const visited = new Set(pages.map((p) => p.url));
    const linkUrls = extractInternalLinks(pages, baseUrl, visited);
    totalPagesFound = pages.length + linkUrls.length;
    const rankedLinks = sortUrlsByScore(linkUrls);
    const toFetch = rankedLinks.slice(0, options.maxPages - pages.length);

    if (toFetch.length > 0) {
      onProgress?.(`No sitemap found. Discovering ${toFetch.length} pages from links...`);
      const batchSize = 5;
      for (let i = 0; i < toFetch.length; i += batchSize) {
        const batch = toFetch.slice(i, i + batchSize);
        const results = await Promise.all(batch.map((u) => fetchPage(u, crawlOptions)));
        for (const page of results) {
          if (page.status === 200 && page.html) {
            pages.push(page);
            visited.add(page.url);
          }
        }
        onProgress?.(
          `Scanned ${Math.min(i + batchSize, toFetch.length)}/${toFetch.length} pages from links...`,
        );
      }
    }
  }

  // Convert all pages to markdown (deduplicate by normalized URL)
  onProgress?.("Converting pages to markdown...");
  const markdownPages: PageMarkdown[] = [];
  const seenUrls = new Set<string>();
  for (const page of pages) {
    if (page.status !== 200 || !page.html) continue;
    const normalized = page.url.replace(/\/$/, "");
    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);
    const md = htmlToMarkdown(page.html, page.url);
    if (md.markdown.trim()) {
      markdownPages.push(md);
    }
  }

  // Filter by sections if specified (homepage is always kept)
  const filteredPages = markdownPages.filter((page) => matchesSections(page.url, options.sections));
  const baseUrl = new URL(url).origin;
  const files: GeneratedFile[] = [];
  const sectionNames: string[] = [];

  // Generate llms.txt
  if (options.formats.includes("llms-txt")) {
    onProgress?.("Generating llms.txt...");
    const { siteName, siteDescription } = extractSiteInfo(markdownPages, baseUrl);
    const llmsTxt = generateLlmsTxt(filteredPages, {
      siteName,
      siteDescription,
      sections: options.sections,
    });

    // Extract section names from generated content
    for (const line of llmsTxt.split("\n")) {
      if (line.startsWith("## ")) {
        sectionNames.push(line.slice(3).trim());
      }
    }

    files.push(makeFile("llms.txt", llmsTxt));
  }

  // Generate llms-full.txt
  if (options.formats.includes("full")) {
    onProgress?.("Generating llms-full.txt...");
    const fullTxt = generateLlmsFullTxt(filteredPages);
    files.push(makeFile("llms-full.txt", fullTxt));
  }

  // Generate per-page markdown files
  if (options.formats.includes("markdown")) {
    onProgress?.("Generating markdown files...");
    for (const page of filteredPages) {
      const filename = `${urlToFilename(page.url)}.md`;
      const content = `${yamlFrontmatter(page)}\n\n${page.markdown}\n`;
      files.push(makeFile(`markdown/${filename}`, content));
    }
  }

  // Detect site type
  const detectedSiteType = detectSiteType(pages, metadata);
  if (detectedSiteType) {
    onProgress?.(
      `Detected site type: ${detectedSiteType.siteType} (${Math.round(detectedSiteType.confidence * 100)}% confidence)`,
    );
  }

  // Build GenerateContext for new generators
  const ctx: GenerateContext = {
    pages: filteredPages,
    rawPages: pages,
    metadata,
    baseUrl,
    startUrl: url,
    ...(detectedSiteType && { siteType: detectedSiteType }),
    ...(options.allowedOffOriginHosts
      ? { allowedOffOriginHosts: options.allowedOffOriginHosts }
      : {}),
  };

  // Build e-commerce artifacts once (compute-once pattern)
  const ecommerceArtifacts = buildEcommerceArtifacts(ctx);

  // Build local business artifacts once (compute-once pattern)
  const localBusinessArtifacts = buildLocalBusinessArtifacts(ctx);

  // Generate robots.txt
  if (options.formats.includes("robots-txt")) {
    onProgress?.("Generating robots.txt...");
    const robotsTxt = generateRobotsTxt(ctx);
    files.push(makeFile("robots.txt", robotsTxt));
  }

  // Generate schema-org.json
  if (options.formats.includes("schema-org")) {
    onProgress?.("Generating schema-org.json...");
    const schemaOrg = generateSchemaOrg(
      ctx,
      ecommerceArtifacts?.products,
      localBusinessArtifacts?.business,
    );
    if (schemaOrg) {
      files.push(makeFile("schema-org.json", `${JSON.stringify(schemaOrg, null, 2)}\n`));
    }
  }

  // Generate agent-card.json
  if (options.formats.includes("agent-card")) {
    onProgress?.("Generating agent-card.json...");
    const agentCard = generateAgentCard(ctx, { a2aEndpoint: options.a2aEndpoint });
    if (agentCard) {
      files.push(makeFile("agent-card.json", `${JSON.stringify(agentCard, null, 2)}\n`));
    }
  }

  // Generate agents.md
  if (options.formats.includes("agents-md")) {
    onProgress?.("Generating agents.md...");
    const agentsMd = generateAgentsMd(ctx);
    files.push(makeFile("agents.md", agentsMd));
  }

  // Generate faq.json
  if (options.formats.includes("faq")) {
    onProgress?.("Generating faq.json...");
    const faq = generateFaq(ctx);
    if (faq) {
      files.push(makeFile("faq.json", `${JSON.stringify(faq, null, 2)}\n`));
    }
  }

  // Generate MCP server
  if (options.formats.includes("mcp-server")) {
    onProgress?.("Generating MCP server...");
    const mcpFiles = generateMcpServer(ctx, undefined, ecommerceArtifacts, localBusinessArtifacts);
    files.push(...mcpFiles);
  }

  // Generate product-catalog.md
  if (ecommerceArtifacts) {
    onProgress?.("Generating product catalog...");
    const catalog = generateProductCatalog(ecommerceArtifacts.products);
    files.push(makeFile("product-catalog.md", `${catalog}\n`));
  }

  // Generate business-info.md
  if (localBusinessArtifacts) {
    onProgress?.("Generating business info...");
    const table = generateBusinessInfoTable(localBusinessArtifacts.business);
    files.push(makeFile("business-info.md", `${table}\n`));
  }

  // Generate SKILL.md
  if (options.formats.includes("skill-md")) {
    onProgress?.("Generating skill.md...");
    const skillMd = generateSkillMd(ctx, {
      mcpEndpoint: options.mcpEndpoint,
      artifacts: ecommerceArtifacts,
      localBusinessArtifacts,
    });
    files.push(makeFile("skill.md", skillMd));
  }

  // Generate OpenClaw SKILL.md
  if (options.formats.includes("openclaw")) {
    onProgress?.("Generating OpenClaw SKILL.md...");
    const openClawSkillMd = generateOpenClawSkillMd(ctx, {
      mcpEndpoint: options.mcpEndpoint,
      artifacts: ecommerceArtifacts,
      localBusinessArtifacts,
    });
    files.push(makeFile("openclaw/SKILL.md", openClawSkillMd));
  }

  // Generate WebMCP declarations
  if (options.formats.includes("webmcp")) {
    onProgress?.("Generating WebMCP declarations...");
    const webmcpFiles = generateWebMcp(ctx);
    files.push(...webmcpFiles);
  }

  // Detect platform and generate integration files
  const detected = detectPlatform(pages, metadata);
  if (detected) {
    onProgress?.(
      `Detected platform: ${detected.platform} (${Math.round(detected.confidence * 100)}% confidence)`,
    );
    const adapter = options.platformFiles === false ? undefined : getAdapter(detected.platform);
    if (adapter) {
      onProgress?.(`Generating ${detected.platform} integration files...`);
      const integrationFiles = adapter.generateIntegration(ctx, files);
      files.push(...integrationFiles);
    }
  }

  const duration = Date.now() - start;

  return {
    url,
    duration,
    pagesProcessed: filteredPages.length,
    pagesFetched: seenUrls.size,
    totalPagesFound,
    files,
    sections: sectionNames,
    ...(detected && { platform: detected }),
    ...(detectedSiteType && { siteType: detectedSiteType }),
    context: ctx,
  };
}

function makeFile(filename: string, content: string): GeneratedFile {
  return {
    filename,
    content,
    size: new TextEncoder().encode(content).length,
  };
}

function extractInternalLinks(
  pages: FetchedPage[],
  baseUrl: string,
  visited: Set<string>,
): string[] {
  const found = new Set<string>();
  for (const page of pages) {
    if (!page.html) continue;
    const parsed = parseHTML(page.html);
    for (const link of parsed.links) {
      try {
        const absolute = new URL(link.href, page.url).href;
        const parsed2 = new URL(absolute);
        // Same origin, not an anchor/hash, not visited
        if (
          parsed2.origin === baseUrl &&
          !visited.has(absolute) &&
          !found.has(absolute) &&
          !absolute.includes("#") &&
          !absolute.match(/\.(jpg|jpeg|png|gif|svg|pdf|zip|css|js|xml|json)$/i)
        ) {
          found.add(absolute);
        }
      } catch {}
    }
  }
  return [...found];
}

function urlToFilename(url: string): string {
  try {
    const path = new URL(url).pathname;
    if (path === "/" || path === "") return "index";
    return path
      .replace(/^\//, "")
      .replace(/\/$/, "")
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "");
  } catch {
    return "page";
  }
}
