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

export function stripStringsAndComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      i = end < 0 ? code.length : end;
    } else if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      out += " ";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < code.length && code[i] !== ch) i += code[i] === "\\" ? 2 : 1;
      i++;
      out += `${ch}${ch}`;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
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
    ...$("link[href]:not([as=image i])")
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
    .map((s) => stripStringsAndComments(s.code));
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

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function isRelativeOrSameHost(url: string, pageUrl: string): boolean {
  try {
    return bareHost(new URL(url, pageUrl).host) === bareHost(new URL(pageUrl).host);
  } catch {
    return false;
  }
}

export function urlPathname(url: string, pageUrl: string): string {
  try {
    return new URL(url, pageUrl).pathname;
  } catch {
    return "";
  }
}

export function hasPathMarker(urls: string[], pageUrl: string, marker: string): boolean {
  return urls.some((u) => urlPathname(u, pageUrl).includes(marker));
}

export function hasClassToken(classAttr: string | undefined, prefix: string): boolean {
  return (classAttr ?? "").split(/\s+/).some((token) => token.startsWith(prefix));
}
