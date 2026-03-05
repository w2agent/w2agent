import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";

export interface ParsedPage {
  $: CheerioAPI;
  title: string;
  metaDescription: string;
  h1: string[];
  headings: { level: number; text: string }[];
  jsonLd: unknown[];
  ogTags: Record<string, string>;
  links: { href: string; text: string; rel?: string }[];
  text: string;
  wordCount: number;
  htmlLength: number;
  textLength: number;
  semanticElements: string[];
  hasFaqContent: boolean;
  lists: number;
  tables: number;
  images: { src: string; alt: string }[];
  canonical?: string;
  charset?: string;
  viewport?: string;
  alternateLinks: { type: string; href: string }[];
}

export function parseHTML(html: string): ParsedPage {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim();
  const metaDescription = $('meta[name="description"]').attr("content") || "";

  const h1 = $("h1")
    .map((_, el) => $(el).text().trim())
    .get();

  const headings: { level: number; text: string }[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag = (el as unknown as { tagName: string }).tagName;
    headings.push({
      level: parseInt(tag[1], 10),
      text: $(el).text().trim(),
    });
  });

  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      jsonLd.push(JSON.parse($(el).html() || ""));
    } catch {}
  });

  const ogTags: Record<string, string> = {};
  $('meta[property^="og:"], meta[property^="article:"]').each((_, el) => {
    const prop = $(el).attr("property") || "";
    ogTags[prop] = $(el).attr("content") || "";
  });

  const links: { href: string; text: string; rel?: string }[] = [];
  $("a[href]").each((_, el) => {
    links.push({
      href: $(el).attr("href") || "",
      text: $(el).text().trim(),
      rel: $(el).attr("rel") || undefined,
    });
  });

  const text = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  const semanticElements: string[] = [];
  for (const tag of ["article", "section", "nav", "main", "aside", "header", "footer", "figure"]) {
    if ($(tag).length > 0) semanticElements.push(tag);
  }

  const faqIndicators = [
    $('[itemtype*="FAQPage"]').length > 0,
    $("details").length >= 2,
    $("dt").length >= 2,
    text.toLowerCase().includes("frequently asked"),
    (text.match(/\?\s/g) || []).length >= 3,
  ];
  const hasFaqContent = faqIndicators.filter(Boolean).length >= 1;

  const lists = $("ul, ol").length;
  const tables = $("table").length;

  const images = $("img")
    .map((_, el) => ({
      src: $(el).attr("src") || "",
      alt: $(el).attr("alt") || "",
    }))
    .get();

  const canonical = $('link[rel="canonical"]').attr("href");
  const charset =
    $("meta[charset]").attr("charset") ||
    ($('meta[http-equiv="Content-Type"]').attr("content")?.includes("utf-8") ? "utf-8" : undefined);
  const viewport = $('meta[name="viewport"]').attr("content");

  const alternateLinks: { type: string; href: string }[] = [];
  $('link[rel="alternate"]').each((_, el) => {
    const type = $(el).attr("type") || "";
    const href = $(el).attr("href") || "";
    if (type && href) alternateLinks.push({ type, href });
  });

  return {
    $,
    title,
    metaDescription,
    h1,
    headings,
    jsonLd,
    ogTags,
    links,
    text,
    wordCount,
    htmlLength: html.length,
    textLength: text.length,
    semanticElements,
    hasFaqContent,
    lists,
    tables,
    images,
    canonical,
    charset,
    viewport,
    alternateLinks,
  };
}
