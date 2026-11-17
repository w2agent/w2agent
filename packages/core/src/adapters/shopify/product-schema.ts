import type { FetchedPage } from "../../audit/types.js";

export type ProductSchemaState = "present" | "absent" | "unknown";

const LD_JSON_SCRIPT =
  /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
const PRODUCT_TYPES = new Set(["Product", "ProductGroup"]);

function isProductPage(page: FetchedPage): boolean {
  if (page.status !== 200 || !page.html) return false;
  try {
    return new URL(page.url).pathname.includes("/products/");
  } catch {
    return false;
  }
}

function nodeHasProductType(node: unknown, depth = 0): boolean {
  if (depth > 4 || node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => nodeHasProductType(n, depth + 1));
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === "string" && PRODUCT_TYPES.has(t))) return true;
  return nodeHasProductType(obj["@graph"], depth + 1);
}

function htmlHasProductSchema(html: string): boolean {
  for (const match of html.matchAll(LD_JSON_SCRIPT)) {
    try {
      if (nodeHasProductType(JSON.parse(match[1]))) return true;
    } catch {
      // invalid JSON-LD counts as no schema
    }
  }
  return false;
}

export function detectProductSchema(rawPages: FetchedPage[]): ProductSchemaState {
  const productPages = rawPages.filter(isProductPage);
  if (productPages.length === 0) return "unknown";
  return productPages.some((p) => htmlHasProductSchema(p.html)) ? "present" : "absent";
}
