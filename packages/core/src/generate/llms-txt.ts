import type { PageMarkdown } from "./types.js";

interface LlmsTxtOptions {
  siteName: string;
  siteDescription: string;
  sections?: string[];
}

/**
 * Generate llms.txt content following the llmstxt.org spec.
 *
 * Format:
 * # Site Name
 * > Description
 * ## Section
 * - [Title](URL): Description
 */
export function generateLlmsTxt(
  pages: PageMarkdown[],
  options: LlmsTxtOptions,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${options.siteName}`);
  lines.push("");
  if (options.siteDescription) {
    lines.push(`> ${options.siteDescription}`);
    lines.push("");
  }

  // Group pages by URL path section
  const sections = groupBySection(pages, options.sections);

  for (const [sectionName, sectionPages] of sections) {
    lines.push(`## ${sectionName}`);
    lines.push("");
    for (const page of sectionPages) {
      const desc = getDescription(page);
      const title = page.title || urlToTitle(page.url);
      if (desc) {
        lines.push(`- [${title}](${page.url}): ${desc}`);
      } else {
        lines.push(`- [${title}](${page.url})`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Group pages into named sections based on URL path segments.
 */
function groupBySection(
  pages: PageMarkdown[],
  filterSections?: string[],
): Map<string, PageMarkdown[]> {
  const groups = new Map<string, PageMarkdown[]>();

  for (const page of pages) {
    const section = getSectionName(page.url);
    if (filterSections && filterSections.length > 0) {
      if (!filterSections.some(s => section.toLowerCase() === s.toLowerCase())) {
        continue;
      }
    }
    if (!groups.has(section)) {
      groups.set(section, []);
    }
    groups.get(section)!.push(page);
  }

  // Sort sections: known categories first, then alphabetical
  const priority = ["docs", "documentation", "api", "guide", "guides", "blog", "pages"];
  const sorted = new Map<string, PageMarkdown[]>(
    [...groups.entries()].sort(([a], [b]) => {
      const aIdx = priority.indexOf(a.toLowerCase());
      const bIdx = priority.indexOf(b.toLowerCase());
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.localeCompare(b);
    }),
  );

  return sorted;
}

/**
 * Derive section name from URL path.
 * /docs/getting-started → "Docs"
 * /blog/my-post → "Blog"
 * /about → "Pages"
 */
function getSectionName(url: string): string {
  try {
    const path = new URL(url).pathname;
    const segments = path.split("/").filter(Boolean);

    if (segments.length === 0) return "Pages";

    const first = segments[0].toLowerCase();

    // Map common path prefixes to clean names
    const sectionMap: Record<string, string> = {
      docs: "Docs",
      documentation: "Documentation",
      doc: "Docs",
      api: "API",
      blog: "Blog",
      posts: "Blog",
      news: "News",
      guides: "Guides",
      guide: "Guides",
      tutorials: "Tutorials",
      tutorial: "Tutorials",
      reference: "Reference",
      examples: "Examples",
      about: "About",
      products: "Products",
      features: "Features",
      pricing: "Pricing",
      help: "Help",
      support: "Support",
      faq: "FAQ",
    };

    return sectionMap[first] || capitalize(first);
  } catch {
    return "Pages";
  }
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/-/g, " ");
}

/**
 * Get a description for a page entry.
 * Priority: meta description → first sentence of content → empty
 */
function getDescription(page: PageMarkdown): string {
  if (page.description) {
    return truncate(page.description, 150);
  }

  // Extract first meaningful sentence from markdown
  const lines = page.markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headings, empty lines, and markdown syntax
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-") ||
        trimmed.startsWith("|") || trimmed.startsWith("```") ||
        trimmed.startsWith(">") || trimmed.startsWith("![")) {
      continue;
    }
    // Found a paragraph line
    const sentence = trimmed.split(/\.\s/)[0];
    if (sentence && sentence.length > 10) {
      return truncate(sentence.endsWith(".") ? sentence : sentence + ".", 150);
    }
  }

  return "";
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3).trimEnd() + "...";
}

function urlToTitle(url: string): string {
  try {
    const path = new URL(url).pathname;
    if (path === "/" || path === "") return "Home";
    const last = path.split("/").filter(Boolean).pop() || "Page";
    return capitalize(last);
  } catch {
    return "Page";
  }
}

/**
 * Extract site name and description from the homepage.
 */
export function extractSiteInfo(
  pages: PageMarkdown[],
  baseUrl: string,
): { siteName: string; siteDescription: string } {
  // Find homepage
  const homepage = pages.find(p => {
    try {
      return new URL(p.url).pathname === "/" || p.url === baseUrl;
    } catch {
      return false;
    }
  });

  const siteName = homepage?.title || new URL(baseUrl).hostname;
  const siteDescription = homepage?.description || "";

  return { siteName, siteDescription };
}
