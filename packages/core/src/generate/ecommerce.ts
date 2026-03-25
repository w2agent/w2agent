import type { CheerioAPI } from "cheerio";
import { parseHTML } from "../shared/html-parser.js";
import type { GenerateContext } from "./types.js";

export interface ExtractedProduct {
  productId: string;
  name: string;
  description?: string;
  url: string;
  image?: string;
  price?: number;
  currency?: string;
  availability?: string;
  brand?: string;
  sku?: string;
  gtin?: string;
  category?: string;
  rating?: number;
  reviewCount?: number;
  bestRating?: number;
  source: "json-ld" | "microdata" | "og";
}

export interface EcommerceArtifacts {
  products: ExtractedProduct[];
}

export function generateProductId(url: string, sku?: string, gtin?: string): string {
  const input = sku ?? gtin ?? url.toLowerCase().replace(/\/$/, "").replace(/\?.*$/, "");
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    hash = hash >>> 0;
  }
  return `p_${hash.toString(16)}`;
}

function normalizeAvailability(value: string): string {
  return value.replace(/https?:\/\/schema\.org\//, "");
}

function parsePrice(value: string | number): number | undefined {
  if (typeof value === "number") return Number.isNaN(value) ? undefined : value;
  const cleaned = value.replace(/[^0-9.]/g, "");
  const parsed = parseFloat(cleaned);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function extractFromJsonLd(
  jsonLd: unknown[],
  url: string,
  canonical?: string,
): ExtractedProduct | null {
  const pageUrl = canonical || url;

  for (const item of jsonLd) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const type = obj["@type"];
    const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
    if (!isProduct) continue;

    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) continue;

    const description = typeof obj.description === "string" ? obj.description.trim() : undefined;

    let image: string | undefined;
    if (typeof obj.image === "string") image = obj.image;
    else if (Array.isArray(obj.image) && typeof obj.image[0] === "string") image = obj.image[0];

    let brand: string | undefined;
    if (obj.brand && typeof obj.brand === "object") {
      const b = obj.brand as Record<string, unknown>;
      if (typeof b.name === "string") brand = b.name;
    }

    let price: number | undefined;
    let currency: string | undefined;
    let availability: string | undefined;

    if (obj.offers) {
      const offersRaw = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
      if (offersRaw && typeof offersRaw === "object") {
        const offer = offersRaw as Record<string, unknown>;
        if (offer.price !== undefined) price = parsePrice(String(offer.price));
        if (typeof offer.priceCurrency === "string") currency = offer.priceCurrency;
        if (typeof offer.availability === "string")
          availability = normalizeAvailability(offer.availability);
      }
    }

    let rating: number | undefined;
    let reviewCount: number | undefined;
    let bestRating: number | undefined;
    if (obj.aggregateRating && typeof obj.aggregateRating === "object") {
      const ar = obj.aggregateRating as Record<string, unknown>;
      const rv = parseFloat(String(ar.ratingValue ?? ""));
      const rc = parseInt(String(ar.reviewCount ?? ""), 10);
      const br = parseFloat(String(ar.bestRating ?? ""));
      if (!Number.isNaN(rv)) rating = rv;
      if (!Number.isNaN(rc)) reviewCount = rc;
      if (!Number.isNaN(br)) bestRating = br;
    }

    const sku = typeof obj.sku === "string" ? obj.sku : undefined;
    const gtin =
      typeof obj.gtin === "string"
        ? obj.gtin
        : typeof obj.gtin13 === "string"
          ? obj.gtin13
          : typeof obj.gtin12 === "string"
            ? obj.gtin12
            : undefined;

    return {
      productId: generateProductId(pageUrl, sku, gtin),
      name,
      description,
      url: pageUrl,
      image,
      price,
      currency,
      availability,
      brand,
      sku,
      gtin,
      rating,
      reviewCount,
      bestRating,
      source: "json-ld",
    };
  }

  return null;
}

export function extractFromMicrodata(
  $: CheerioAPI,
  url: string,
  canonical?: string,
): ExtractedProduct | null {
  const pageUrl = canonical || url;
  const container = $('[itemtype*="schema.org/Product"]').first();

  const find = (prop: string) => {
    if (container.length > 0) {
      return container.find(`[itemprop="${prop}"]`).first();
    }
    return $(`[itemprop="${prop}"]`).first();
  };

  const name = find("name").text().trim();
  if (!name) return null;

  const priceEl = find("price");
  const priceRaw = priceEl.attr("content") || priceEl.text().trim();
  const price = priceRaw ? parsePrice(priceRaw) : undefined;

  const currencyEl = find("priceCurrency");
  const currency = currencyEl.attr("content") || currencyEl.text().trim() || undefined;

  const availEl = find("availability");
  const availRaw = availEl.attr("href") || availEl.attr("content") || availEl.text().trim();
  const availability = availRaw ? normalizeAvailability(availRaw) : undefined;

  const imageEl = find("image");
  const image = imageEl.attr("src") || imageEl.attr("content") || undefined;

  const brandEl = find("brand");
  const brand =
    brandEl.attr("content") ||
    brandEl.find('[itemprop="name"]').text().trim() ||
    brandEl.text().trim() ||
    undefined;

  const skuEl = find("sku");
  const sku = skuEl.attr("content") || skuEl.text().trim() || undefined;

  const descEl = find("description");
  const description = descEl.attr("content") || descEl.text().trim() || undefined;

  return {
    productId: generateProductId(pageUrl, sku),
    name,
    description: description || undefined,
    url: pageUrl,
    image,
    price,
    currency: currency || undefined,
    availability,
    brand: brand || undefined,
    sku: sku || undefined,
    source: "microdata",
  };
}

export function extractFromOgTags(
  ogTags: Record<string, string>,
  url: string,
  canonical?: string,
): ExtractedProduct | null {
  const type = ogTags["og:type"] || "";
  if (!type.startsWith("product")) return null;

  const name = ogTags["og:title"] || "";
  if (!name) return null;

  const pageUrl = canonical || url;
  const description = ogTags["og:description"] || undefined;
  const image = ogTags["og:image"] || undefined;

  const priceRaw = ogTags["product:price:amount"] || ogTags["og:price:amount"] || "";
  const price = priceRaw ? parseFloat(priceRaw) : undefined;

  const currency = ogTags["product:price:currency"] || ogTags["og:price:currency"] || undefined;
  const availRaw = ogTags["product:availability"] || "";
  const availability = availRaw ? normalizeAvailability(availRaw) : undefined;

  return {
    productId: generateProductId(pageUrl),
    name,
    description,
    url: pageUrl,
    image,
    price: price !== undefined && !Number.isNaN(price) ? price : undefined,
    currency,
    availability,
    source: "og",
  };
}

export function extractProducts(ctx: GenerateContext): ExtractedProduct[] {
  const seenUrls = new Set<string>();
  const products: ExtractedProduct[] = [];

  for (const page of ctx.rawPages) {
    if (page.status !== 200 || !page.html) continue;

    const parsed = parseHTML(page.html);
    const pageUrl = parsed.canonical || page.url;

    if (seenUrls.has(pageUrl)) continue;
    seenUrls.add(pageUrl);

    let product: ExtractedProduct | null = null;

    // Strategy 1: JSON-LD
    product = extractFromJsonLd(parsed.jsonLd, page.url, parsed.canonical);

    // Strategy 2: Microdata
    if (!product) {
      product = extractFromMicrodata(parsed.$, page.url, parsed.canonical);
    }

    // Strategy 3: OG tags (extend with product: meta tags not captured by html-parser)
    if (!product) {
      const extendedOgTags = { ...parsed.ogTags };
      parsed.$('meta[property^="product:"]').each((_, el) => {
        const prop = parsed.$(el).attr("property") || "";
        if (prop) extendedOgTags[prop] = parsed.$(el).attr("content") || "";
      });
      product = extractFromOgTags(extendedOgTags, page.url, parsed.canonical);
    }

    if (!product) continue;

    // Quality filter: must have name AND (price or description)
    if (!product.name || (product.price === undefined && !product.description)) continue;

    products.push(product);
  }

  return products;
}

export function buildEcommerceArtifacts(ctx: GenerateContext): EcommerceArtifacts | null {
  if (ctx.siteType?.siteType !== "ecommerce") return null;

  const products = extractProducts(ctx);
  if (products.length === 0) return null;

  return { products };
}

export function generateProductCatalog(products: ExtractedProduct[]): string {
  const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name));

  const rows = sorted.map((p) => {
    const priceStr =
      p.price !== undefined
        ? p.currency && p.currency !== "USD"
          ? `${p.price} ${p.currency}`
          : `$${p.price.toFixed(2)}`
        : "";
    const availStr = p.availability || "";
    const ratingStr =
      p.rating !== undefined
        ? `${p.rating}/5${p.reviewCount !== undefined ? ` (${p.reviewCount} reviews)` : ""}`
        : "";
    return `| ${p.name} | ${priceStr} | ${availStr} | ${ratingStr} | ${p.url} |`;
  });

  return [
    "<!-- Generated by w2agent -->",
    "| Product | Price | Availability | Rating | URL |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function generateCommerceToolHandlers(): string {
  return `function searchProducts(query, products) {
  const q = query.toLowerCase();
  return products
    .filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.category && p.category.toLowerCase().includes(q)) ||
      (p.description && p.description.toLowerCase().includes(q))
    )
    .map(p => ({ productId: p.productId, name: p.name, price: p.price, url: p.url }));
}

function getProduct(productId, products) {
  return products.find(p => p.productId === productId) ||
    products.find(p => p.name.toLowerCase().includes(productId.toLowerCase())) ||
    null;
}

function checkInventory(productId, products) {
  const p = getProduct(productId, products);
  if (!p) return null;
  return { productId: p.productId, name: p.name, availability: p.availability, price: p.price };
}

function getReviews(productId, products) {
  const p = getProduct(productId, products);
  if (!p) return null;
  return { productId: p.productId, name: p.name, rating: p.rating, reviewCount: p.reviewCount, bestRating: p.bestRating };
}`;
}
