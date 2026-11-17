import * as cheerio from "cheerio";
import type { FetchedPage } from "../../audit/types.js";

export type ProductSchemaState = "present" | "absent" | "unknown";

const PRODUCT_TYPES = new Set(["Product", "ProductGroup"]);
const SCHEMA_ORG_PREFIX = /^https?:\/\/schema\.org\//i;
const MAX_DEPTH = 8;
const MAX_NODES = 5000;

function isProductPage(page: FetchedPage): boolean {
  if (page.status !== 200 || !page.html) return false;
  try {
    return new URL(page.url).pathname.includes("/products/");
  } catch {
    return false;
  }
}

function isProductType(type: unknown): boolean {
  return typeof type === "string" && PRODUCT_TYPES.has(type.replace(SCHEMA_ORG_PREFIX, ""));
}

function jsonHasProductType(root: unknown): boolean {
  let budget = MAX_NODES;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH || budget-- <= 0 || node === null || typeof node !== "object") {
      return false;
    }
    if (Array.isArray(node)) return node.some((n) => walk(n, depth + 1));
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    if (Array.isArray(type) ? type.some(isProductType) : isProductType(type)) return true;
    return Object.values(obj).some((v) => walk(v, depth + 1));
  };
  return walk(root, 0);
}

export function pageHasProductSchema(html: string): boolean {
  const $ = cheerio.load(html);
  let found = false;
  $("script[type]").each((_, el) => {
    const type = ($(el).attr("type") ?? "").split(";")[0].trim().toLowerCase();
    if (found || type !== "application/ld+json") return;
    try {
      if (jsonHasProductType(JSON.parse($(el).text()))) found = true;
    } catch {
      // invalid JSON-LD counts as no schema
    }
  });
  if (found) return true;
  $("[itemtype]").each((_, el) => {
    const value = $(el).attr("itemtype") ?? "";
    if (value.split(/\s+/).some((t) => SCHEMA_ORG_PREFIX.test(t) && isProductType(t))) found = true;
  });
  return found;
}

export function detectProductSchema(rawPages: FetchedPage[]): ProductSchemaState {
  const productPages = rawPages.filter(isProductPage);
  if (productPages.length === 0) return "unknown";
  return productPages.some((p) => pageHasProductSchema(p.html)) ? "present" : "absent";
}
