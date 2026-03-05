import { parseHTML } from "../shared/html-parser.js";
import type { GenerateContext } from "./types.js";

interface SchemaOrgEntry {
  url: string;
  jsonLd: Record<string, unknown>;
}

export function generateSchemaOrg(ctx: GenerateContext): SchemaOrgEntry[] | null {
  const entries: SchemaOrgEntry[] = [];

  for (const page of ctx.rawPages) {
    if (page.status !== 200 || !page.html) continue;

    const parsed = parseHTML(page.html);

    const hasExistingJsonLd = parsed.jsonLd.length > 0;
    if (hasExistingJsonLd) continue;

    const schemaType = detectType(parsed);
    const mdPage = ctx.pages.find((p) => normalizeUrl(p.url) === normalizeUrl(page.url));

    const jsonLd: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": schemaType,
      name: parsed.title || mdPage?.title || "",
      description: parsed.metaDescription || mdPage?.description || "",
      url: page.url,
    };

    if (parsed.ogTags["og:image"]) {
      jsonLd.image = parsed.ogTags["og:image"];
    }

    if (schemaType === "Article") {
      if (parsed.ogTags["article:published_time"]) {
        jsonLd.datePublished = parsed.ogTags["article:published_time"];
      }
      if (parsed.ogTags["article:modified_time"]) {
        jsonLd.dateModified = parsed.ogTags["article:modified_time"];
      }
    }

    if (schemaType === "FAQPage") {
      // FAQ content will be handled by the dedicated faq generator
      // Here we just mark the type
    }

    entries.push({ url: page.url, jsonLd });
  }

  return entries.length > 0 ? entries : null;
}

function detectType(parsed: ReturnType<typeof parseHTML>): string {
  if (parsed.hasFaqContent) return "FAQPage";

  const hasArticleTime = !!parsed.ogTags["article:published_time"];
  const hasAuthorLink = parsed.links.some((l) => l.href.includes("/author") || l.rel === "author");
  if (hasArticleTime || hasAuthorLink) return "Article";

  return "WebPage";
}

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}
