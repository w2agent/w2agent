import { parseHTML } from "../shared/html-parser.js";
import type { ExtractedProduct } from "./ecommerce.js";
import { extractPageFaqEntries, faqMainEntity } from "./faq.js";
import type { ExtractedLocalBusiness } from "./local-business.js";
import type { GenerateContext } from "./types.js";

const FOOD_ESTABLISHMENT_TYPES = new Set([
  "Restaurant",
  "CafeOrCoffeeShop",
  "Bakery",
  "BarOrPub",
  "FastFoodRestaurant",
  "IceCreamShop",
  "Brewery",
  "Distillery",
  "Winery",
  "FoodEstablishment",
]);

interface SchemaOrgEntry {
  url: string;
  jsonLd: Record<string, unknown>;
}

export function generateSchemaOrg(
  ctx: GenerateContext,
  products?: ExtractedProduct[],
  localBusiness?: ExtractedLocalBusiness | null,
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
      (item) =>
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>)["@type"] === "Product",
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

    const faqEntries = extractPageFaqEntries(parsed);
    const schemaType = detectType(parsed, faqEntries.length > 0);
    const mdPage = ctx.pages.find((p) => normalizeUrl(p.url) === normalizeUrl(page.url));

    const jsonLd: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": schemaType,
    };
    const name = parsed.title || mdPage?.title;
    if (name) jsonLd.name = name;
    const description = parsed.metaDescription || mdPage?.description;
    if (description) jsonLd.description = description;
    jsonLd.url = page.url;

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
      jsonLd.mainEntity = faqMainEntity(faqEntries);
    }

    entries.push({ url: page.url, jsonLd });
  }

  // Generate LocalBusiness JSON-LD if we have extracted business data
  if (localBusiness) {
    // Check if homepage already has LocalBusiness JSON-LD (avoid duplicating)
    const homepageAlreadyHasIt = ctx.rawPages.some((page) => {
      if (normalizeUrl(page.url) !== normalizeUrl(ctx.baseUrl)) return false;
      if (!page.html) return false;
      const parsed = parseHTML(page.html);
      return parsed.jsonLd.some((item) => {
        const type = (item as Record<string, unknown>)["@type"];
        if (!type) return false;
        const types = Array.isArray(type) ? type : [type];
        return types.some(
          (t) =>
            typeof t === "string" &&
            (t.includes("LocalBusiness") ||
              t.includes("Restaurant") ||
              t.includes("Dentist") ||
              t.includes("MedicalBusiness") ||
              t.includes("Store")),
        );
      });
    });

    if (!homepageAlreadyHasIt) {
      const lb: Record<string, unknown> = {
        "@context": "https://schema.org",
        "@type": localBusiness.type,
        name: localBusiness.name,
        url: localBusiness.url,
      };
      if (localBusiness.address) {
        const addr: Record<string, unknown> = { "@type": "PostalAddress" };
        if (localBusiness.address.street) addr.streetAddress = localBusiness.address.street;
        if (localBusiness.address.city) addr.addressLocality = localBusiness.address.city;
        if (localBusiness.address.state) addr.addressRegion = localBusiness.address.state;
        if (localBusiness.address.zip) addr.postalCode = localBusiness.address.zip;
        if (localBusiness.address.country) addr.addressCountry = localBusiness.address.country;
        lb.address = addr;
      }
      if (localBusiness.phone) lb.telephone = localBusiness.phone;
      if (localBusiness.email) lb.email = localBusiness.email;
      if (localBusiness.geo) {
        lb.geo = {
          "@type": "GeoCoordinates",
          latitude: localBusiness.geo.lat,
          longitude: localBusiness.geo.lng,
        };
      }
      if (localBusiness.priceRange) lb.priceRange = localBusiness.priceRange;
      if (localBusiness.image) lb.image = localBusiness.image;
      if (localBusiness.menu && FOOD_ESTABLISHMENT_TYPES.has(localBusiness.type)) {
        lb.hasMenu = localBusiness.menu;
      }
      if (localBusiness.hours && localBusiness.hours.length > 0) {
        lb.openingHoursSpecification = localBusiness.hours.map((h) => ({
          "@type": "OpeningHoursSpecification",
          dayOfWeek: h.days.map((d) => `https://schema.org/${d}`),
          opens: h.opens,
          closes: h.closes,
        }));
      }
      entries.push({ url: ctx.baseUrl, jsonLd: lb });
    }
  }

  return entries.length > 0 ? entries : null;
}

// Each type needs evidence on the page itself: FAQPage needs extracted question/answer
// entries (mainEntity), Article needs a publication time. A link to an author page proves neither.
function detectType(parsed: ReturnType<typeof parseHTML>, hasFaqEntries: boolean): string {
  if (hasFaqEntries) return "FAQPage";
  if (parsed.ogTags["article:published_time"]) return "Article";
  return "WebPage";
}

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}
