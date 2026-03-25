import type { FetchedPage, SiteMetadata } from "../audit/types.js";
import { parseHTML } from "../shared/html-parser.js";
import type { SiteTypeDetectionResult, SiteTypeDetector } from "./types.js";

function detectEcommerce(
  pages: FetchedPage[],
  _metadata: SiteMetadata,
): SiteTypeDetectionResult | null {
  const matchedSignals: Array<{ label: string; weight: number }> = [];

  for (const page of pages) {
    const html = page.html ?? "";
    const url = page.url ?? "";
    const parsed = parseHTML(html);
    const { $, jsonLd, ogTags, links, text } = parsed;

    // Platform markers (0.8)
    if (
      html.includes("cdn.shopify.com") ||
      html.includes("Shopify.theme") ||
      $('meta[name="shopify-checkout-api-token"]').length > 0
    ) {
      if (!matchedSignals.find((s) => s.label === "Shopify platform marker")) {
        matchedSignals.push({ label: "Shopify platform marker", weight: 0.8 });
      }
    }
    if (
      html.includes("woocommerce") ||
      $("body.woocommerce").length > 0 ||
      html.includes("wc-ajax=")
    ) {
      if (!matchedSignals.find((s) => s.label === "WooCommerce marker")) {
        matchedSignals.push({ label: "WooCommerce marker", weight: 0.8 });
      }
    }
    if (html.includes("bigcommerce") || html.includes("cdn.bigcommerce.com")) {
      if (!matchedSignals.find((s) => s.label === "BigCommerce marker")) {
        matchedSignals.push({ label: "BigCommerce marker", weight: 0.8 });
      }
    }
    if (
      html.includes("Magento") ||
      html.includes("mage/cookies") ||
      html.includes("Mage.Cookies")
    ) {
      if (!matchedSignals.find((s) => s.label === "Magento marker")) {
        matchedSignals.push({ label: "Magento marker", weight: 0.8 });
      }
    }

    // Product JSON-LD (0.7)
    const hasProductSchema = jsonLd.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>)["@type"] === "Product",
    );
    if (hasProductSchema && !matchedSignals.find((s) => s.label === "Product schema (JSON-LD)")) {
      matchedSignals.push({ label: "Product schema (JSON-LD)", weight: 0.7 });
    }

    // og:type=product (0.5)
    if (
      ogTags["og:type"] === "product" &&
      !matchedSignals.find((s) => s.label === "og:type=product")
    ) {
      matchedSignals.push({ label: "og:type=product", weight: 0.5 });
    }

    // Commerce URL paths (0.4) — check page URL and internal links
    const allUrls = [url, ...links.map((l) => l.href)];
    const commercePathPattern = /\/(cart|checkout|products?|shop|store|collection|category)\b/i;
    if (
      allUrls.some((u) => commercePathPattern.test(u)) &&
      !matchedSignals.find((s) => s.label === "Commerce URL paths")
    ) {
      matchedSignals.push({ label: "Commerce URL paths", weight: 0.4 });
    }

    // Price microdata (0.4)
    if (
      $('[itemprop="price"]').length > 0 &&
      !matchedSignals.find((s) => s.label === "Price microdata")
    ) {
      matchedSignals.push({ label: "Price microdata", weight: 0.4 });
    }

    // "Add to Cart" / "Buy Now" buttons (0.3)
    const cartButtonPattern = /add\s+to\s+cart|buy\s+now|add\s+to\s+bag/i;
    if (
      cartButtonPattern.test(text) &&
      !matchedSignals.find((s) => s.label === "Add to cart / Buy now text")
    ) {
      matchedSignals.push({ label: "Add to cart / Buy now text", weight: 0.3 });
    }
  }

  if (matchedSignals.length === 0) return null;

  // Confidence = 1 - product(1 - weight_i) — probability union formula
  const confidence = 1 - matchedSignals.reduce((acc, s) => acc * (1 - s.weight), 1);

  if (confidence < 0.5) return null;

  return {
    siteType: "ecommerce",
    confidence,
    signals: matchedSignals.map((s) => s.label),
  };
}

export const ecommerceDetector: SiteTypeDetector = {
  siteType: "ecommerce",
  detect: detectEcommerce,
};
