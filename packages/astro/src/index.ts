import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import matter from "gray-matter";

export interface W2agentAstroOptions {
  /** Directory containing content collections (default: 'src/content') */
  contentDir?: string;
  /** Enable the /api/w2agent-webhook POST route in SSR mode (default: true) */
  webhookEnabled?: boolean;
  /** Log extra info during build (default: false) */
  verbose?: boolean;
}

interface ContentEntry {
  title: string;
  description?: string;
  url: string;
}

export default function w2agentAstro(options: W2agentAstroOptions = {}): AstroIntegration {
  const { contentDir = "src/content", webhookEnabled = true, verbose = false } = options;

  let siteRoot = process.cwd();
  let siteUrl = "";

  return {
    name: "@w2agent/astro",
    hooks: {
      "astro:config:setup": ({ config, injectRoute }) => {
        siteRoot = fileURLToPath(config.root);
        if (config.site) siteUrl = config.site;

        if (config.output === "server") {
          injectRoute({ pattern: "/llms.txt", entrypoint: "@w2agent/astro/routes/llms-txt" });
          injectRoute({
            pattern: "/llms-full.txt",
            entrypoint: "@w2agent/astro/routes/llms-full-txt",
          });
          injectRoute({
            pattern: "/.well-known/agent-card.json",
            entrypoint: "@w2agent/astro/routes/agent-card",
          });
          if (webhookEnabled !== false) {
            injectRoute({
              pattern: "/api/w2agent-webhook",
              entrypoint: "@w2agent/astro/routes/webhook",
            });
          }
        }
      },

      "astro:build:done": async ({ dir }) => {
        const outDir = fileURLToPath(dir);

        // Generate llms.txt from content collections
        const contentDirPath = join(siteRoot, contentDir);
        const llmsTxt = generateFromContent(contentDirPath, siteUrl, verbose);
        if (llmsTxt) {
          writeFileSync(join(outDir, "llms.txt"), llmsTxt);
          console.log(`[w2agent] Generated llms.txt (${llmsTxt.length} bytes)`);
        } else {
          // Fallback: copy public/llms.txt if it exists
          const publicLlms = join(siteRoot, "public", "llms.txt");
          if (existsSync(publicLlms)) {
            writeFileSync(join(outDir, "llms.txt"), readFileSync(publicLlms, "utf-8"));
            if (verbose) console.log("[w2agent] Copied public/llms.txt");
          }
        }

        // Copy agent-card.json
        const wellKnownDir = join(outDir, ".well-known");
        mkdirSync(wellKnownDir, { recursive: true });
        const agentCardSrc = join(siteRoot, "public", ".well-known", "agent-card.json");
        if (existsSync(agentCardSrc)) {
          copyFileSync(agentCardSrc, join(wellKnownDir, "agent-card.json"));
          if (verbose) console.log("[w2agent] Copied agent-card.json");
        }

        // Optional webhook trigger
        const webhookUrl = process.env.W2AGENT_WEBHOOK_URL;
        if (webhookUrl) {
          await triggerWebhook(webhookUrl, process.env.W2AGENT_WEBHOOK_TOKEN);
        }
      },
    },
  };
}

function generateFromContent(contentDir: string, siteUrl: string, verbose: boolean): string | null {
  if (!existsSync(contentDir)) return null;

  const sections: Record<string, ContentEntry[]> = {};

  walkDir(contentDir, (filePath) => {
    if (!filePath.endsWith(".md") && !filePath.endsWith(".mdx")) return;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    let title: string | undefined;
    let description: string | undefined;

    try {
      const parsed = matter(content);
      title = parsed.data.title as string | undefined;
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

    const relativePath = relative(contentDir, filePath);
    const parts = relativePath.split(sep);
    const collectionRaw = parts.length > 1 ? parts[0] : "general";
    const sectionName =
      collectionRaw.charAt(0).toUpperCase() + collectionRaw.slice(1).replace(/-/g, " ");

    const urlSlug = relativePath
      .replace(/\.mdx?$/, "")
      .replace(/\/index$/, "")
      .replace(/\\/g, "/");
    const fullUrl = siteUrl ? `${siteUrl.replace(/\/$/, "")}/${urlSlug}` : `/${urlSlug}`;

    if (!sections[sectionName]) sections[sectionName] = [];
    sections[sectionName].push({ title, description, url: fullUrl });

    if (verbose) console.log(`[w2agent] Indexed: ${title}`);
  });

  if (Object.keys(sections).length === 0) return null;

  let output = "# AI Content Index\n\n";

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
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
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
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ event: "build", framework: "astro" }),
    });
  } catch (err) {
    console.warn("[w2agent] Webhook failed:", (err as Error).message);
  }
}
