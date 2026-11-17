import { yamlFrontmatter } from "./markdown-text.js";
import type { PageMarkdown } from "./types.js";

/**
 * Generate llms-full.txt by concatenating all page markdown
 * with frontmatter-style separators.
 *
 * Format:
 * ---
 * url: https://example.com/page
 * title: Page Title
 * ---
 *
 * [page content as markdown]
 */
export function generateLlmsFullTxt(pages: PageMarkdown[]): string {
  const sections: string[] = [];

  for (const page of pages) {
    sections.push(`${yamlFrontmatter(page)}\n\n${page.markdown}`);
  }

  return `${sections.join("\n\n")}\n`;
}
