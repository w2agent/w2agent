import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

export interface W2agentAstroOptions {
  /** Write the generated llms.txt over an existing public/llms.txt (default: false) */
  overwrite?: boolean;
  /** Enable the /api/w2agent-webhook POST route in SSR mode (default: true) */
  webhookEnabled?: boolean;
  /** Log extra info during build (default: false) */
  verbose?: boolean;
}

interface PageEntry {
  title: string;
  description?: string;
  url: string;
  section: string;
}

type TrailingSlash = "always" | "never" | "ignore";

interface UrlConfig {
  site: string;
  base: string;
  trailingSlash: TrailingSlash;
}

export default function w2agentAstro(options: W2agentAstroOptions = {}): AstroIntegration {
  const { webhookEnabled = true, verbose = false } = options;
  const overwrite = options.overwrite === true;

  let siteRoot = process.cwd();
  let publicDir = join(siteRoot, "public");
  let urlConfig: UrlConfig = { site: "", base: "", trailingSlash: "ignore" };

  return {
    name: "@w2agent/astro",
    hooks: {
      "astro:config:setup": ({ config, injectRoute }) => {
        siteRoot = fileURLToPath(config.root);
        publicDir = config.publicDir ? toPath(config.publicDir) : join(siteRoot, "public");
        urlConfig = {
          site: config.site ? siteOrigin(config.site) : "",
          base: normalizeBase(config.base),
          trailingSlash: config.trailingSlash ?? "ignore",
        };

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

      "astro:build:done": async ({ dir, pages }) => {
        const outDir = fileURLToPath(dir);

        const llmsTxt = generateFromPages(outDir, pages ?? [], urlConfig, verbose);
        if (llmsTxt) {
          const existing = join(publicDir, "llms.txt");
          if (existsSync(existing) && !overwrite) {
            console.log(
              `[w2agent] Keeping existing ${relative(siteRoot, existing)}; set overwrite: true to replace it with a generated index`,
            );
          } else {
            writeFileSync(join(outDir, "llms.txt"), llmsTxt);
            console.log(`[w2agent] Generated llms.txt (${llmsTxt.length} bytes)`);
          }
        }

        // Copy agent-card.json
        const wellKnownDir = join(outDir, ".well-known");
        mkdirSync(wellKnownDir, { recursive: true });
        const agentCardSrc = join(publicDir, ".well-known", "agent-card.json");
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

function toPath(dir: URL | string): string {
  return typeof dir === "string" ? dir : fileURLToPath(dir);
}

function siteOrigin(site: string): string {
  try {
    return new URL(site).origin;
  } catch {
    return site.replace(/\/+$/, "");
  }
}

function normalizeBase(base: string | undefined): string {
  const trimmed = (base ?? "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "";
}

function applyTrailingSlash(path: string, rule: TrailingSlash): string {
  if (rule === "always") return path.endsWith("/") ? path : `${path}/`;
  if (rule === "never") return path.replace(/\/+$/, "") || "/";
  return path;
}

function findHtml(outDir: string, pathname: string): string | null {
  const bare = pathname.replace(/\/+$/, "");
  const candidates = bare
    ? [join(outDir, bare, "index.html"), join(outDir, `${bare}.html`)]
    : [join(outDir, "index.html")];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (match, dec, hex, name) => {
    if (name) return ENTITIES[name] ?? match;
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

function clean(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function mdText(value: string): string {
  return value.replace(/[\\`*_[\]<>|&]/g, "\\$&");
}

function mdDescription(value: string): string {
  return value.replace(/[\\[\]<>]/g, "\\$&");
}

function mdUrl(value: string): string {
  return value.replace(/[\s()<>]/g, (c) =>
    encodeURIComponent(c).replace("(", "%28").replace(")", "%29"),
  );
}

function metaTags(html: string): Array<Record<string, string>> {
  const tags: Array<Record<string, string>> = [];
  for (const tag of html.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    }
    tags.push(attrs);
  }
  return tags;
}

function headOf(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  const head = end === -1 ? html : html.slice(0, end);
  return head.replace(/<(script|style|template|svg)\b[\s\S]*?<\/\1\s*>/gi, "");
}

function readPage(doc: string): { title: string; description?: string; noindex: boolean } | null {
  const html = headOf(doc);
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? clean(titleMatch[1]) : "";
  const tags = metaTags(html);
  const noindex = tags.some(
    (t) => t.name?.toLowerCase() === "robots" && /noindex/i.test(t.content ?? ""),
  );
  const descTag = tags.find((t) => t.name?.toLowerCase() === "description");
  const description = descTag?.content ? clean(descTag.content) : undefined;
  if (!title) return null;
  return { title, description: description || undefined, noindex };
}

function generateFromPages(
  outDir: string,
  pages: Array<{ pathname: string }>,
  cfg: UrlConfig,
  verbose: boolean,
): string | null {
  const entries: PageEntry[] = [];

  for (const page of pages) {
    const pathname = page.pathname ?? "";
    const bare = pathname.replace(/\/+$/, "");
    if (bare === "404" || bare === "500") continue;

    const htmlPath = findHtml(outDir, pathname);
    if (!htmlPath) continue;

    let html: string;
    try {
      html = readFileSync(htmlPath, "utf-8");
    } catch {
      continue;
    }

    const info = readPage(html);
    if (!info || info.noindex) continue;

    const path = applyTrailingSlash(`${cfg.base}/${pathname}`, cfg.trailingSlash);
    const segments = bare.split("/");
    const sectionRaw = segments.length > 1 ? segments[0] : "";
    const section = sectionRaw
      ? sectionRaw.charAt(0).toUpperCase() + sectionRaw.slice(1).replace(/-/g, " ")
      : "Pages";

    entries.push({
      title: info.title,
      description: info.description,
      url: `${cfg.site}${path}`,
      section,
    });
    if (verbose) console.log(`[w2agent] Indexed: ${info.title}`);
  }

  if (entries.length === 0) return null;

  const sections = new Map<string, PageEntry[]>();
  for (const entry of entries) {
    const list = sections.get(entry.section) ?? [];
    list.push(entry);
    sections.set(entry.section, list);
  }

  let output = "# AI Content Index\n\n";
  for (const [section, items] of sections) {
    output += `## ${section}\n\n`;
    for (const item of items) {
      output += `- [${mdText(item.title)}](${mdUrl(item.url)})`;
      if (item.description) output += `: ${mdDescription(item.description)}`;
      output += "\n";
    }
    output += "\n";
  }
  return output;
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
