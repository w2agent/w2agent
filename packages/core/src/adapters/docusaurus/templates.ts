import type { GeneratedFile } from "../../generate/types.js";

export function generateDocusaurusIntegration(
  llmsTxtContent: string,
  agentCardContent: string | undefined,
  siteUrl: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Build plugin that generates llms.txt from actual docs content at build time
  const pluginJs = `/**
 * w2agent Docusaurus Plugin
 *
 * Generates llms.txt dynamically from your docs at build time.
 * Reads sidebar structure + markdown files to produce a comprehensive llms.txt.
 *
 * Usage in docusaurus.config.js:
 *   plugins: [require.resolve('./w2agent-plugin')],
 */
const fs = require("fs");
const path = require("path");
let matter;
try {
  matter = require("gray-matter");
} catch {
  console.warn("[w2agent] gray-matter not installed — dynamic llms.txt generation disabled, using static fallback");
}

module.exports = function w2agentPlugin(context) {
  return {
    name: "w2agent-plugin",

    async postBuild({ siteConfig, outDir }) {
      const siteUrl = siteConfig.url || "${siteUrl}";
      const siteName = siteConfig.title || "Documentation";
      const siteDesc = siteConfig.tagline || "";

      // Try to generate dynamically from docs
      let llmsTxt = generateFromDocs(context, siteUrl, siteName, siteDesc);

      // Fallback to pre-generated file if dynamic generation found nothing
      if (!llmsTxt) {
        const staticFile = path.join(__dirname, "static", "llms.txt");
        if (fs.existsSync(staticFile)) {
          llmsTxt = fs.readFileSync(staticFile, "utf-8");
          console.log("[w2agent] Using pre-generated llms.txt");
        }
      }

      if (llmsTxt) {
        fs.writeFileSync(path.join(outDir, "llms.txt"), llmsTxt);
        console.log("[w2agent] Generated llms.txt (" + llmsTxt.length + " bytes)");
      }

      // Copy agent card
      const wellKnownDir = path.join(outDir, ".well-known");
      if (!fs.existsSync(wellKnownDir)) {
        fs.mkdirSync(wellKnownDir, { recursive: true });
      }

      const agentCardSrc = path.join(__dirname, "static", ".well-known", "agent-card.json");
      if (fs.existsSync(agentCardSrc)) {
        fs.copyFileSync(agentCardSrc, path.join(wellKnownDir, "agent-card.json"));
        console.log("[w2agent] Copied agent-card.json");
      }
    },
  };
};

function generateFromDocs(context, siteUrl, siteName, siteDesc) {
  if (!matter) return null;
  const docsDir = path.join(context.siteDir, "docs");
  if (!fs.existsSync(docsDir)) return null;

  const sections = {};

  // Walk the docs directory
  walkDir(docsDir, (filePath) => {
    if (!filePath.endsWith(".md") && !filePath.endsWith(".mdx")) return;

    const relativePath = path.relative(docsDir, filePath);
    const content = fs.readFileSync(filePath, "utf-8");

    // Parse frontmatter
    let title, description;
    try {
      const parsed = matter(content);
      title = parsed.data.title || parsed.data.sidebar_label;
      description = parsed.data.description;

      // Extract title from first heading if not in frontmatter
      if (!title) {
        const headingMatch = parsed.content.match(/^#\\s+(.+)/m);
        if (headingMatch) title = headingMatch[1];
      }

      // Extract description from first paragraph if not in frontmatter
      if (!description) {
        const lines = parsed.content.split("\\n").filter(l => l.trim() && !l.startsWith("#"));
        if (lines.length > 0) {
          description = lines[0].trim().substring(0, 150);
          if (lines[0].length > 150) description += "...";
        }
      }
    } catch {
      return; // Skip files that can't be parsed
    }

    if (!title) return;

    // Determine section from directory structure
    const parts = relativePath.split(path.sep);
    const section = parts.length > 1 ? parts[0] : "General";
    const sectionName = section.charAt(0).toUpperCase() + section.slice(1).replace(/-/g, " ");

    // Build URL path from file path
    const urlPath = relativePath
      .replace(/\\.mdx?$/, "")
      .replace(/\\/index$/, "")
      .replace(/\\\\/g, "/");
    const fullUrl = siteUrl.replace(/\\/$/, "") + "/docs/" + urlPath;

    if (!sections[sectionName]) sections[sectionName] = [];
    sections[sectionName].push({ title, description, url: fullUrl });
  });

  if (Object.keys(sections).length === 0) return null;

  // Build llms.txt
  let output = "# " + siteName + "\\n\\n";
  if (siteDesc) output += "> " + siteDesc + "\\n\\n";

  for (const [section, items] of Object.entries(sections)) {
    output += "## " + section + "\\n\\n";
    for (const item of items) {
      output += "- [" + item.title + "](" + item.url + ")";
      if (item.description) output += ": " + item.description;
      output += "\\n";
    }
    output += "\\n";
  }

  return output;
}

function walkDir(dir, callback) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, callback);
    } else {
      callback(fullPath);
    }
  }
}
`;

  const installMd = `# w2agent Docusaurus Integration — Installation

## Recommended: npm plugin

\`\`\`bash
npm install @w2agent/docusaurus
\`\`\`

Then add to \`docusaurus.config.js\`:
\`\`\`js
plugins: [['@w2agent/docusaurus', { siteUrl: '${siteUrl}' }]],
\`\`\`

---

## Alternative: Manual file setup (below)

## How It Works

The build plugin **generates llms.txt dynamically from your docs directory** at build time:
1. Walks your \`docs/\` directory
2. Reads frontmatter (title, description) from each .md/.mdx file
3. Groups by directory structure (sections)
4. Outputs a complete llms.txt to the build output

If dynamic generation finds no docs, it falls back to the pre-generated static file.

## Setup

### Option A: Build Plugin (Recommended)

1. Copy the \`docusaurus/\` folder into your project root

2. Install the gray-matter dependency (for frontmatter parsing):
\`\`\`bash
npm install gray-matter
\`\`\`

3. Add the plugin to \`docusaurus.config.js\`:
\`\`\`js
module.exports = {
  // ...
  plugins: [require.resolve('./docusaurus/w2agent-plugin')],
  headTags: [
    {
      tagName: 'link',
      attributes: {
        rel: 'alternate',
        type: 'text/markdown',
        href: '/llms.txt',
        title: 'LLMs.txt',
      },
    },
  ],
};
\`\`\`

4. Build your site: \`npm run build\`
5. Verify: \`/llms.txt\` is in the build output (and \`/.well-known/agent-card.json\`, if you generated one with \`--a2a-endpoint\`)

### Option B: Static Files Only

1. Copy \`static/llms.txt\` to your Docusaurus \`static/\` directory
2. If present (generated only with \`--a2a-endpoint\`), copy \`static/.well-known/agent-card.json\` to \`static/.well-known/\`
3. Add the \`headTags\` config above

## File Structure

\`\`\`
docusaurus/
  w2agent-plugin.js                  <- Build plugin (reads docs/ at build time)
  static/
    llms.txt                         <- Pre-generated fallback
    .well-known/
      agent-card.json                <- A2A agent card (only with --a2a-endpoint)
\`\`\`

## Tips

- Add descriptive \`title\` and \`description\` to your doc frontmatter — the plugin uses these
- Organize docs in subdirectories for automatic section grouping
- The plugin runs during \`postBuild\`, so llms.txt reflects the actual published docs

## Regenerating Static Fallback

\`\`\`bash
npx --no -- w2agent generate ${siteUrl} --format llms-txt --no-platform --output ./static/
\`\`\`

Run it from your Docusaurus project root. It needs the w2agent CLI installed in your project:
the CLI is not published on npm yet, so build it from the w2agent repo and run
\`npm install -D <path-to-w2agent>/packages/cli\`.
`;

  files.push(makeFile("docusaurus/w2agent-plugin.js", pluginJs));
  files.push(makeFile("docusaurus/static/llms.txt", llmsTxtContent));
  if (agentCardContent) {
    files.push(makeFile("docusaurus/static/.well-known/agent-card.json", agentCardContent));
  }
  files.push(makeFile("docusaurus/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
