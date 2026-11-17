import type { CheerioAPI } from "cheerio";
import type { FetchedPage } from "../../audit/types.js";
import { isCodeScript, parseHTML } from "../../shared/html-parser.js";

export interface PageMarkers {
  $: CheerioAPI;
  assetUrls: string[];
  imageUrls: string[];
  codeScripts: string[];
  generators: string[];
}

const cache = new WeakMap<FetchedPage, PageMarkers>();

export function pageMarkers(page: FetchedPage): PageMarkers {
  const cached = cache.get(page);
  if (cached) return cached;

  const { $ } = parseHTML(page.html ?? "");
  const assetUrls = [
    ...$("script[src]")
      .toArray()
      .map((el) => $(el).attr("src") ?? ""),
    ...$("link[href]")
      .toArray()
      .map((el) => $(el).attr("href") ?? ""),
  ];
  const imageUrls = $("img")
    .toArray()
    .flatMap((el) => [
      $(el).attr("src") ?? "",
      ...($(el).attr("srcset") ?? "").split(",").map((c) => c.trim().split(/\s+/)[0] ?? ""),
    ])
    .filter(Boolean);
  const codeScripts = $("script:not([src])")
    .toArray()
    .map((el) => ({ type: $(el).attr("type"), code: $(el).html() ?? "" }))
    .filter((s) => isCodeScript(s.type, s.code))
    .map((s) => s.code);
  const generators = $('meta[name="generator" i]')
    .toArray()
    .map((el) => ($(el).attr("content") ?? "").trim());

  const markers = { $, assetUrls, imageUrls, codeScripts, generators };
  cache.set(page, markers);
  return markers;
}

export function generatorVersion(
  markers: PageMarkers,
  name: RegExp,
): { version: string | undefined } | null {
  for (const content of markers.generators) {
    const match = content.match(name);
    if (match) return { version: match[1] || undefined };
  }
  return null;
}

export function isRelativeOrSameHost(url: string, pageUrl: string): boolean {
  try {
    return new URL(url, pageUrl).host === new URL(pageUrl).host;
  } catch {
    return false;
  }
}

export function hasClassToken(classAttr: string | undefined, prefix: string): boolean {
  return (classAttr ?? "").split(/\s+/).some((token) => token.startsWith(prefix));
}
