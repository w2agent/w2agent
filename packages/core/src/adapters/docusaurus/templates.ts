import type { GeneratedFile } from "../../generate/types.js";

// String.raw keeps the regex backslashes of the emitted plugin readable: it must not contain a
// backtick or a dollar-brace sequence.
const PLUGIN_JS = String.raw`/**
 * w2agent Docusaurus Plugin
 *
 * Generates llms.txt at build time from the docs Docusaurus loaded (permalinks, titles,
 * descriptions), so URLs follow baseUrl, routeBasePath, slugs and number prefixes.
 * A static/llms.txt that already exists is kept unless you pass overwrite: true.
 *
 * Usage in docusaurus.config.js:
 *   plugins: ["./w2agent-plugin.js"],
 *   // or: plugins: [["./w2agent-plugin.js", { overwrite: true }]],
 */
const fs = require("fs");
const path = require("path");

const DOCS_PLUGIN = "docusaurus-plugin-content-docs";

function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function mdText(value) {
  return value.replace(/[\\\x60*_[\]<>|&]/g, "\\$&");
}

function mdDescription(value) {
  return value.replace(/[\\[\]<>]/g, "\\$&");
}

function mdUrl(value) {
  return value.replace(/[\s()<>]/g, (c) =>
    encodeURIComponent(c).replace("(", "%28").replace(")", "%29"),
  );
}

function sectionName(sourceDirName) {
  const top = (sourceDirName || ".").split("/")[0];
  if (!top || top === ".") return "Docs";
  const name = top.replace(/^\d+[-_.]/, "").replace(/-/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Same rule as Docusaurus applyTrailingSlash, so links match the emitted routes.
function applyTrailingSlash(permalink, trailingSlash, baseUrl) {
  if (trailingSlash == null) return permalink;
  const pathname = permalink.split(/[#?]/)[0];
  if (pathname === "/" || pathname === baseUrl) return permalink;
  const next = trailingSlash ? (pathname.endsWith("/") ? pathname : pathname + "/") : pathname.replace(/\/$/, "");
  return permalink.replace(pathname, next);
}

function collectSections(plugins, siteConfig) {
  const sections = new Map();
  const origin = siteConfig.url.replace(/\/+$/, "");

  for (const plugin of plugins) {
    if (plugin.name !== DOCS_PLUGIN) continue;
    const versions = (plugin.content && plugin.content.loadedVersions) || [];
    for (const version of versions) {
      if (version.isLast !== true) continue;
      for (const doc of version.docs || []) {
        if (doc.unlisted || doc.draft) continue;
        const title = oneLine(doc.title);
        if (!title || !doc.permalink) continue;
        const name = sectionName(doc.sourceDirName);
        const items = sections.get(name) || [];
        items.push({ title, description: oneLine(doc.description), url: origin + applyTrailingSlash(doc.permalink, siteConfig.trailingSlash, siteConfig.baseUrl) });
        sections.set(name, items);
      }
    }
  }

  return sections;
}

function renderLlmsTxt(sections, siteName, siteDesc) {
  let output = "# " + oneLine(siteName) + "\n\n";
  if (oneLine(siteDesc)) output += "> " + mdDescription(oneLine(siteDesc)) + "\n\n";

  for (const [section, items] of sections) {
    output += "## " + section + "\n\n";
    for (const item of items) {
      output += "- [" + mdText(item.title) + "](" + mdUrl(item.url) + ")";
      if (item.description) output += ": " + mdDescription(item.description);
      output += "\n";
    }
    output += "\n";
  }

  return output;
}

module.exports = function w2agentPlugin(context, options = {}) {
  const overwrite = options.overwrite === true;
  const staticDirs = (context.siteConfig.staticDirectories || ["static"]).map((d) =>
    path.resolve(context.siteDir, d),
  );

  return {
    name: "w2agent-plugin",

    async postBuild({ siteConfig, outDir, plugins = [] }) {
      const sections = collectSections(plugins, siteConfig);

      if (sections.size > 0) {
        const kept = staticDirs.map((d) => path.join(d, "llms.txt")).find((f) => fs.existsSync(f));
        if (kept && !overwrite) {
          console.log(
            "[w2agent] Keeping existing " + path.relative(context.siteDir, kept) + " (set overwrite: true to replace)",
          );
        } else {
          const llmsTxt = renderLlmsTxt(
            sections,
            siteConfig.title || "Documentation",
            siteConfig.tagline || "",
          );
          fs.writeFileSync(path.join(outDir, "llms.txt"), llmsTxt);
          console.log("[w2agent] Generated llms.txt (" + llmsTxt.length + " bytes)");
        }
      }

      // Copy agent card
      const wellKnownDir = path.join(outDir, ".well-known");
      fs.mkdirSync(wellKnownDir, { recursive: true });

      for (const dir of staticDirs) {
        const agentCardSrc = path.join(dir, ".well-known", "agent-card.json");
        if (fs.existsSync(agentCardSrc)) {
          fs.copyFileSync(agentCardSrc, path.join(wellKnownDir, "agent-card.json"));
          console.log("[w2agent] Copied agent-card.json");
          break;
        }
      }
    },
  };
};
`;

export function generateDocusaurusIntegration(
  llmsTxtContent: string,
  agentCardContent: string | undefined,
  siteUrl: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  const installMd = `# w2agent Docusaurus Integration — Installation

## Recommended: npm plugin

\`\`\`bash
npm install @w2agent/docusaurus
\`\`\`

Then add to \`docusaurus.config.js\`:
\`\`\`js
plugins: ['@w2agent/docusaurus'],
// to replace an existing static/llms.txt with the generated one:
// plugins: [['@w2agent/docusaurus', { overwrite: true }]],
\`\`\`

---

## Alternative: Manual file setup (below)

## How It Works

The build plugin **generates llms.txt from the docs Docusaurus loaded** at build time:
1. Reads the docs plugin content in \`postBuild\` (title, description and permalink of each doc)
2. Skips unlisted and draft docs, and docs from older versions
3. Groups by top-level docs directory (sections)
4. Writes a complete llms.txt to the build output

Links use the real permalinks, so they follow \`baseUrl\`, \`routeBasePath\`, \`slug\` and \`trailingSlash\`.
**An existing \`static/llms.txt\` is served as is** (Docusaurus copies it and the plugin keeps it). The file in this folder's \`static/\` is such a file once you copy it. To have the build generate llms.txt from your docs instead, leave it out or set \`overwrite: true\`:
\`\`\`js
plugins: [['./w2agent-plugin.js', { overwrite: true }]],
\`\`\`

## Setup

### Option A: Build Plugin (Recommended)

1. Copy \`w2agent-plugin.js\` from this \`docusaurus/\` folder into your project root (next to \`docusaurus.config.js\`)

2. Add the plugin to \`docusaurus.config.js\`:
\`\`\`js
module.exports = {
  // ...
  plugins: ['./w2agent-plugin.js'],
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

3. Copy the files under \`static/\` from this folder into your project's \`static/\` directory (\`static/.well-known/agent-card.json\` if present; \`static/llms.txt\` only if you want it served as is, see above)

4. If \`w2agent-webmcp-module.js\` is present, copy it into your project root and add it to \`docusaurus.config.js\`:
\`\`\`js
clientModules: ['./w2agent-webmcp-module.js'],
\`\`\`

5. Build your site: \`npm run build\`
6. Verify: \`/llms.txt\` is in the build output (and \`/.well-known/agent-card.json\`, if you generated one with \`--a2a-endpoint\`)

### Option B: Static Files Only

1. Copy \`static/llms.txt\` to your Docusaurus \`static/\` directory
2. If present (generated only with \`--a2a-endpoint\`), copy \`static/.well-known/agent-card.json\` to \`static/.well-known/\`
3. Add the \`headTags\` config above

## File Structure

\`\`\`
docusaurus/
  w2agent-plugin.js                  <- Build plugin (reads the loaded docs content at build time)
  w2agent-webmcp-module.js           <- WebMCP client module (only when WebMCP tools were generated)
  static/
    llms.txt                         <- Pre-generated file (kept by the plugin unless overwrite: true)
    .well-known/
      agent-card.json                <- A2A agent card (only with --a2a-endpoint)
\`\`\`

## Tips

- Add descriptive \`title\` and \`description\` to your doc frontmatter — the plugin uses these
- Organize docs in subdirectories for automatic section grouping
- When the plugin generates llms.txt (no static file, or \`overwrite: true\`), it runs during \`postBuild\` and reflects the actual published docs

## Regenerating the Static File

\`\`\`bash
npx --no -- w2agent generate ${siteUrl} --format llms-txt --no-platform --output ./static/
\`\`\`

Run it from your Docusaurus project root. It needs the w2agent CLI installed in your project:
the CLI is not published on npm yet, so build it from the w2agent repo and run
\`npm install -D <path-to-w2agent>/packages/cli\`.
`;

  files.push(makeFile("docusaurus/w2agent-plugin.js", PLUGIN_JS));
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
