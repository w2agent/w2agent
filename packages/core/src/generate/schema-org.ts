import { parseHTML } from "../shared/html-parser.js";
import type { ExtractedProduct } from "./ecommerce.js";
import type { GenerateContext } from "./types.js";

interface SchemaOrgEntry {
  url: string;
  jsonLd: Record<string, unknown>;
}

export function generateSchemaOrg(
  ctx: GenerateContext,
  products?: ExtractedProduct[],
): SchemaOrgEntry[] | null {
  const entries: SchemaOrgEntry[] = [];

  const productsByUrl = new Map<string, ExtractedProduct>();
  if (products) {
    for (const p of products) {
      productsByUrl.set(normalizeUrl(p.url), p);
    }
  }

  for (const page of ctx.rawPages) {
    if (page.status !== 200 || !page.html) continue;

    const parsed = parseHTML(page.html);

    const hasExistingJsonLd = parsed.jsonLd.length > 0;
    const hasProductJsonLd = parsed.jsonLd.some(
      (item) => item && typeof item === "object" && (item as Record<string, unknown>)["@type"] === "Product",
    );

    // If this is a product page (from microdata/OG extraction) and no Product JSON-LD exists, generate Product schema
    const product = productsByUrl.get(normalizeUrl(page.url));
    if (product && !hasProductJsonLd) {
      const productJsonLd: Record<string, unknown> = {
        "@context": "https://schema.org",
        "@type": "Product",
        name: product.name,
        url: product.url,
      };
      if (product.description) productJsonLd.description = product.description;
      if (product.image) productJsonLd.image = product.image;
      if (product.brand) {
        productJsonLd.brand = { "@type": "Brand", name: product.brand };
      }
      if (product.price !== undefined) {
        const offer: Record<string, unknown> = {
          "@type": "Offer",
          price: product.price,
        };
        if (product.currency) offer.priceCurrency = product.currency;
        if (product.availability) {
          offer.availability = `https://schema.org/${product.availability}`;
        }
        productJsonLd.offers = offer;
      }
      if (product.rating !== undefined) {
        const ar: Record<string, unknown> = {
          "@type": "AggregateRating",
          ratingValue: product.rating,
        };
        if (product.reviewCount !== undefined) ar.reviewCount = product.reviewCount;
        if (product.bestRating !== undefined) ar.bestRating = product.bestRating;
        productJsonLd.aggregateRating = ar;
      }
      if (product.sku) productJsonLd.sku = product.sku;
      if (product.gtin) productJsonLd.gtin = product.gtin;
      entries.push({ url: page.url, jsonLd: productJsonLd });
      continue;
    }

    // Skip pages that already have any JSON-LD (for non-product schema generation)
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
