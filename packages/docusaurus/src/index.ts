import * as fs from "node:fs";
import * as path from "node:path";

interface W2agentPluginOptions {
  overwrite?: boolean;
  verbose?: boolean;
}

// Inline minimal Docusaurus types to avoid @docusaurus/types runtime dep
interface SiteConfig {
  url: string;
  title: string;
  tagline?: string;
  baseUrl?: string;
  trailingSlash?: boolean;
  staticDirectories?: string[];
}

interface LoadContext {
  siteDir: string;
  siteConfig: SiteConfig;
}

interface LoadedDoc {
  permalink: string;
  title?: string;
  description?: string;
  unlisted?: boolean;
  draft?: boolean;
  sourceDirName?: string;
}

interface LoadedVersion {
  isLast?: boolean;
  docs?: LoadedDoc[];
}

interface LoadedPlugin {
  name: string;
  content?: { loadedVersions?: LoadedVersion[] } | null;
}

interface PostBuildProps {
  siteConfig: SiteConfig;
  outDir: string;
  plugins?: LoadedPlugin[];
}

interface DocEntry {
  title: string;
  description: string;
  url: string;
}

const DOCS_PLUGIN = "docusaurus-plugin-content-docs";

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function sectionName(sourceDirName: string | undefined): string {
  const top = (sourceDirName || ".").split("/")[0];
  if (!top || top === ".") return "Docs";
  const name = top.replace(/^\d+[-_.]/, "").replace(/-/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Same rule as Docusaurus applyTrailingSlash, so links match the emitted routes.
function applyTrailingSlash(permalink: string, trailingSlash?: boolean, baseUrl?: string): string {
  if (typeof trailingSlash === "undefined") return permalink;
  const [pathname] = permalink.split(/[#?]/);
  if (pathname === "/" || pathname === baseUrl) return permalink;
  const next = trailingSlash
    ? pathname.endsWith("/")
      ? pathname
      : `${pathname}/`
    : pathname.replace(/\/$/, "");
  return permalink.replace(pathname, next);
}

function collectSections(plugins: LoadedPlugin[], siteConfig: SiteConfig): Map<string, DocEntry[]> {
  const sections = new Map<string, DocEntry[]>();
  const origin = siteConfig.url.replace(/\/+$/, "");

  for (const plugin of plugins) {
    if (plugin.name !== DOCS_PLUGIN) continue;
    for (const version of plugin.content?.loadedVersions ?? []) {
      if (version.isLast !== true) continue;
      for (const doc of version.docs ?? []) {
        if (doc.unlisted || doc.draft) continue;
        const title = oneLine(doc.title);
        if (!title || !doc.permalink) continue;
        const name = sectionName(doc.sourceDirName);
        const items = sections.get(name) ?? [];
        items.push({
          title,
          description: oneLine(doc.description),
          url:
            origin +
            applyTrailingSlash(doc.permalink, siteConfig.trailingSlash, siteConfig.baseUrl),
        });
        sections.set(name, items);
      }
    }
  }

  return sections;
}

function renderLlmsTxt(
  sections: Map<string, DocEntry[]>,
  siteName: string,
  siteDesc: string,
): string {
  let output = `# ${oneLine(siteName)}\n\n`;
  if (oneLine(siteDesc)) output += `> ${oneLine(siteDesc)}\n\n`;

  for (const [section, items] of sections) {
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

function w2agentPlugin(context: LoadContext, options: W2agentPluginOptions = {}) {
  const { verbose = false } = options;
  const overwrite = options.overwrite === true;
  const staticDirs = (context.siteConfig.staticDirectories ?? ["static"]).map((d) =>
    path.resolve(context.siteDir, d),
  );

  return {
    name: "w2agent-plugin" as const,

    async postBuild({ siteConfig, outDir, plugins = [] }: PostBuildProps): Promise<void> {
      const sections = collectSections(plugins, siteConfig);

      if (sections.size > 0) {
        const kept = staticDirs.map((d) => path.join(d, "llms.txt")).find((f) => fs.existsSync(f));
        if (kept && !overwrite) {
          console.log(
            `[w2agent] Keeping existing ${path.relative(context.siteDir, kept)} (set overwrite: true to replace)`,
          );
        } else {
          const llmsTxt = renderLlmsTxt(
            sections,
            siteConfig.title || "Documentation",
            siteConfig.tagline || "",
          );
          fs.writeFileSync(path.join(outDir, "llms.txt"), llmsTxt);
          console.log(`[w2agent] Generated llms.txt (${llmsTxt.length} bytes)`);
        }
      }

      // Copy agent-card.json
      const wellKnownDir = path.join(outDir, ".well-known");
      fs.mkdirSync(wellKnownDir, { recursive: true });

      for (const dir of staticDirs) {
        const agentCardSrc = path.join(dir, ".well-known", "agent-card.json");
        if (fs.existsSync(agentCardSrc)) {
          fs.copyFileSync(agentCardSrc, path.join(wellKnownDir, "agent-card.json"));
          if (verbose) console.log("[w2agent] Copied agent-card.json");
          break;
        }
      }

      // Optional webhook trigger
      const webhookUrl = process.env.W2AGENT_WEBHOOK_URL;
      if (webhookUrl) {
        await triggerWebhook(webhookUrl, process.env.W2AGENT_WEBHOOK_TOKEN);
      }
    },
  };
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
