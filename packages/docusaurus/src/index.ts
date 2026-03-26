import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";

interface W2agentPluginOptions {
  docsDir?: string;
  verbose?: boolean;
}

// Inline minimal Docusaurus types to avoid @docusaurus/types runtime dep
interface SiteConfig {
  url: string;
  title: string;
  tagline?: string;
}

interface LoadContext {
  siteDir: string;
  siteConfig: SiteConfig;
}

interface PostBuildProps {
  siteConfig: SiteConfig;
  outDir: string;
}

interface DocEntry {
  title: string;
  description?: string;
  url: string;
}

function w2agentPlugin(context: LoadContext, options: W2agentPluginOptions = {}) {
  const { docsDir = "docs", verbose = false } = options;

  return {
    name: "w2agent-plugin" as const,

    async postBuild({ siteConfig, outDir }: PostBuildProps): Promise<void> {
      const siteUrl = siteConfig.url;
      const siteName = siteConfig.title || "Documentation";
      const siteDesc = siteConfig.tagline || "";

      const docsDirPath = path.join(context.siteDir, docsDir);
      let llmsTxt = generateFromDocs(docsDirPath, siteUrl, siteName, siteDesc);

      // Fallback to static/llms.txt
      if (!llmsTxt) {
        const staticFile = path.join(context.siteDir, "static", "llms.txt");
        if (fs.existsSync(staticFile)) {
          llmsTxt = fs.readFileSync(staticFile, "utf-8");
          if (verbose) console.log("[w2agent] Using pre-generated llms.txt");
        }
      }

      if (llmsTxt) {
        fs.writeFileSync(path.join(outDir, "llms.txt"), llmsTxt);
        console.log(`[w2agent] Generated llms.txt (${llmsTxt.length} bytes)`);
      }

      // Copy agent-card.json
      const wellKnownDir = path.join(outDir, ".well-known");
      fs.mkdirSync(wellKnownDir, { recursive: true });

      const agentCardSrc = path.join(context.siteDir, "static", ".well-known", "agent-card.json");
      if (fs.existsSync(agentCardSrc)) {
        fs.copyFileSync(agentCardSrc, path.join(wellKnownDir, "agent-card.json"));
        if (verbose) console.log("[w2agent] Copied agent-card.json");
      }

      // Optional webhook trigger
      const webhookUrl = process.env.W2AGENT_WEBHOOK_URL;
      if (webhookUrl) {
        await triggerWebhook(webhookUrl, process.env.W2AGENT_WEBHOOK_TOKEN);
      }
    },
  };
}

function generateFromDocs(
  docsDir: string,
  siteUrl: string,
  siteName: string,
  siteDesc: string,
): string | null {
  if (!fs.existsSync(docsDir)) return null;

  const sections: Record<string, DocEntry[]> = {};

  walkDir(docsDir, (filePath) => {
    if (!filePath.endsWith(".md") && !filePath.endsWith(".mdx")) return;

    const content = fs.readFileSync(filePath, "utf-8");
    let title: string | undefined;
    let description: string | undefined;

    try {
      const parsed = matter(content);
      title =
        (parsed.data.title as string | undefined) ??
        (parsed.data.sidebar_label as string | undefined);
      description = parsed.data.description as string | undefined;

      if (!title) {
        const m = parsed.content.match(/^#\s+(.+)/m);
        if (m) title = m[1];
      }

      if (!description) {
        const lines = parsed.content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
        if (lines.length > 0) {
          description = lines[0].trim().slice(0, 150);
          if (lines[0].trim().length > 150) description += "...";
        }
      }
    } catch {
      return;
    }

    if (!title) return;

    const relativePath = path.relative(docsDir, filePath);
    const parts = relativePath.split(path.sep);
    const sectionRaw = parts.length > 1 ? parts[0] : "General";
    const sectionName = sectionRaw.charAt(0).toUpperCase() + sectionRaw.slice(1).replace(/-/g, " ");

    const urlPath = relativePath
      .replace(/\.mdx?$/, "")
      .replace(/\/index$/, "")
      .replace(/\\/g, "/");
    const fullUrl = `${siteUrl.replace(/\/$/, "")}/docs/${urlPath}`;

    if (!sections[sectionName]) sections[sectionName] = [];
    sections[sectionName].push({ title, description, url: fullUrl });
  });

  if (Object.keys(sections).length === 0) return null;

  let output = `# ${siteName}\n\n`;
  if (siteDesc) output += `> ${siteDesc}\n\n`;

  for (const [section, items] of Object.entries(sections)) {
    output += `## ${section}\n\n`;
    for (const item of items) {
      output += `- [${item.title}](${item.url})`;
      if (item.description) output += `: ${item.description}`;
      output += "\n";
    }
    output += "\n";
  }

  return output;
}

function walkDir(dir: string, callback: (filePath: string) => void): void {
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

async function triggerWebhook(url: string, token?: string): Promise<void> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    await fetch(url, { method: "POST", headers, body: JSON.stringify({ event: "build" }) });
  } catch (err) {
    console.warn("[w2agent] Webhook failed:", (err as Error).message);
  }
}

export = w2agentPlugin;
