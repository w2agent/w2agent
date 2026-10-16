import type { FetchedPage, SiteMetadata } from "../audit/types.js";
import { isCodeScript, parseHTML } from "../shared/html-parser.js";
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
    const { $, jsonLd, ogTags, links } = parsed;

    // Platform markers (0.8) — bound to markup/code tokens, never page prose or data payloads
    // (Next.js RSC flight scripts serialize the page text, so raw html.includes() is unsound).
    const attrHas = (selector: string, attr: string, needle: string | RegExp) =>
      $(selector)
        .toArray()
        .some((el) => {
          const value = $(el).attr(attr) ?? "";
          return typeof needle === "string" ? value.includes(needle) : needle.test(value);
        });
    const codeScripts = $("script:not([src])")
      .toArray()
      .map((el) => ({ type: $(el).attr("type"), code: $(el).html() ?? "" }))
      .filter((s) => isCodeScript(s.type, s.code))
      .map((s) => s.code);
    const inCode = (pattern: RegExp) => codeScripts.some((c) => pattern.test(c));
    const srcOrHrefHas = (needle: string | RegExp) =>
      attrHas("script[src]", "src", needle) || attrHas("link[href]", "href", needle);
    const wooBodyClass = ($("body").attr("class") ?? "")
      .split(/\s+/)
      .some((c) =>
        ["woocommerce", "woocommerce-page", "woocommerce-js", "woocommerce-no-js"].includes(c),
      );

    if (
      srcOrHrefHas("cdn.shopify.com") ||
      inCode(/\bShopify\.theme\s*=/) ||
      $('meta[name="shopify-checkout-api-token"]').length > 0
    ) {
      if (!matchedSignals.find((s) => s.label === "Shopify platform marker")) {
        matchedSignals.push({ label: "Shopify platform marker", weight: 0.8 });
      }
    }
    if (
      wooBodyClass ||
      srcOrHrefHas("/plugins/woocommerce/") ||
      srcOrHrefHas("wc-ajax=") ||
      attrHas("a[href]", "href", "wc-ajax=") ||
      attrHas("form[action]", "action", "wc-ajax=") ||
      inCode(/[?&]wc-ajax=/)
    ) {
      if (!matchedSignals.find((s) => s.label === "WooCommerce marker")) {
        matchedSignals.push({ label: "WooCommerce marker", weight: 0.8 });
      }
    }
    if (
      srcOrHrefHas(/(?:^|\/\/)cdn\d*\.bigcommerce\.com\//i) ||
      attrHas("img[src]", "src", /(?:^|\/\/)cdn\d*\.bigcommerce\.com\//i)
    ) {
      if (!matchedSignals.find((s) => s.label === "BigCommerce marker")) {
        matchedSignals.push({ label: "BigCommerce marker", weight: 0.8 });
      }
    }
    if (
      $('script[type="text/x-magento-init"]').length > 0 ||
      $("[data-mage-init]").length > 0 ||
      attrHas("script[src]", "src", "mage/cookies") ||
      inCode(/\bMage\.Cookies\b|mage\/cookies/)
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

    // "Add to Cart" / "Buy Now" commerce controls (0.3) — a form button or a link to a
    // cart/checkout path, not prose that merely mentions the phrase.
    const cartButtonPattern = /add\s+to\s+cart|buy\s+now|add\s+to\s+bag/i;
    const cartPathPattern = /\/(cart|checkout)\b/i;
    const formIds = new Set(
      $("form[id]")
        .toArray()
        .map((el) => $(el).attr("id") ?? ""),
    );
    const hasCartControl =
      $("form button, form input[type=submit], form input[type=button]")
        .toArray()
        .concat(
          $("button[form], input[type=submit][form], input[type=button][form]")
            .filter((_, el) => formIds.has($(el).attr("form") ?? ""))
            .toArray(),
        )
        .some((el) => cartButtonPattern.test(`${$(el).text()} ${$(el).attr("value") ?? ""}`)) ||
      $("a[href]")
        .toArray()
        .some(
          (el) =>
            cartPathPattern.test($(el).attr("href") ?? "") && cartButtonPattern.test($(el).text()),
        );
    if (hasCartControl && !matchedSignals.find((s) => s.label === "Add to cart / Buy now text")) {
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
