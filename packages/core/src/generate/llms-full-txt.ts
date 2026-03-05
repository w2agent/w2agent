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
    const frontmatter = ["---", `url: ${page.url}`, `title: ${page.title}`, "---"].join("\n");

    sections.push(`${frontmatter}\n\n${page.markdown}`);
  }

  return `${sections.join("\n\n")}\n`;
}
