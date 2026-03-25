import robotsParser from "robots-parser";
import { extractFromJsonLd } from "../../generate/ecommerce.js";
import { parseHTML } from "../../shared/html-parser.js";
import type { Check } from "../types.js";

export function validateGtin(gtin: string): boolean {
  const digits = gtin.replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const weight = i % 2 === 0 ? 1 : 3;
    sum += parseInt(digits[digits.length - 1 - i], 10) * weight;
  }
  return sum % 10 === 0;
}

const CHECKOUT_PATH_RE = /\/(cart|checkout|bag|basket)(\/|$|\?)/i;

export const ecommerceProductSchema: Check = {
  id: "ecommerce-product-schema",
  name: "Product pages have complete schema",
  category: "structured-data",
  weight: 2,
  severity: "warning",
  run: (pages) => {
    let productPages = 0;
    let completeSchema = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const product = extractFromJsonLd(parsed.jsonLd, page.url, parsed.canonical);
      if (!product) continue;

      productPages++;
      if (product.price !== undefined && product.availability !== undefined) {
        completeSchema++;
      }
    }

    if (productPages === 0) {
      return {
        id: "ecommerce-product-schema",
        name: "Product pages have complete schema",
        category: "structured-data",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 2,
        message: "No product pages detected",
        severity: "warning",
      };
    }

    const score = Math.round((completeSchema / productPages) * 100);

    return {
      id: "ecommerce-product-schema",
      name: "Product pages have complete schema",
      category: "structured-data",
      status: score === 100 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 2,
      message:
        score === 100
          ? "All product pages have complete Product JSON-LD"
          : `${completeSchema}/${productPages} product pages have complete Product JSON-LD (name + price + availability)`,
      severity: score < 50 ? "warning" : "info",
      fixSnippet:
        score < 100
          ? `<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "Product",\n  "name": "Product Name",\n  "offers": {\n    "@type": "Offer",\n    "price": "29.99",\n    "priceCurrency": "USD",\n    "availability": "https://schema.org/InStock"\n  }\n}\n</script>`
          : undefined,
    };
  },
};

export const ecommerceGtinValid: Check = {
  id: "ecommerce-gtin-valid",
  name: "Product GTINs are valid",
  category: "structured-data",
  weight: 1,
  severity: "info",
  run: (pages) => {
    let totalGtins = 0;
    let validGtins = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const product = extractFromJsonLd(parsed.jsonLd, page.url, parsed.canonical);
      if (!product?.gtin) continue;

      totalGtins++;
      if (validateGtin(product.gtin)) validGtins++;
    }

    if (totalGtins === 0) {
      return {
        id: "ecommerce-gtin-valid",
        name: "Product GTINs are valid",
        category: "structured-data",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 1,
        message: "No products with GTIN found — skipping GTIN validation",
        severity: "info",
      };
    }

    const score = Math.round((validGtins / totalGtins) * 100);

    return {
      id: "ecommerce-gtin-valid",
      name: "Product GTINs are valid",
      category: "structured-data",
      status: score === 100 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message:
        score === 100
          ? `All ${totalGtins} GTIN(s) pass GS1 check digit validation`
          : `${validGtins}/${totalGtins} GTINs pass GS1 check digit validation`,
      severity: "info",
    };
  },
};

export const ecommerceCheckoutAccessible: Check = {
  id: "ecommerce-checkout-accessible",
  name: "Checkout flow is agent-accessible",
  category: "bot-accessibility",
  weight: 1.5,
  severity: "warning",
  run: (pages, metadata) => {
    const checkoutPaths = new Set<string>();

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      for (const link of parsed.links) {
        try {
          const url = new URL(link.href, metadata.baseUrl);
          if (CHECKOUT_PATH_RE.test(url.pathname)) {
            checkoutPaths.add(url.pathname);
          }
        } catch {
          // skip invalid URLs
        }
      }
    }

    if (checkoutPaths.size === 0) {
      return {
        id: "ecommerce-checkout-accessible",
        name: "Checkout flow is agent-accessible",
        category: "bot-accessibility",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 1.5,
        message: "No cart or checkout URLs found in page links",
        severity: "warning",
      };
    }

    const blockedPaths: string[] = [];

    if (metadata.robotsTxt) {
      const robots = robotsParser(`${metadata.baseUrl}/robots.txt`, metadata.robotsTxt);
      for (const path of checkoutPaths) {
        const fullUrl = `${metadata.baseUrl}${path}`;
        if (!robots.isAllowed(fullUrl, "*")) {
          blockedPaths.push(path);
        }
      }
    }

    const score =
      blockedPaths.length === 0
        ? 100
        : Math.round(((checkoutPaths.size - blockedPaths.length) / checkoutPaths.size) * 100);

    return {
      id: "ecommerce-checkout-accessible",
      name: "Checkout flow is agent-accessible",
      category: "bot-accessibility",
      status: score === 100 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1.5,
      message:
        blockedPaths.length === 0
          ? `${checkoutPaths.size} checkout URL(s) found and accessible to agents`
          : `${blockedPaths.length} checkout path(s) blocked by robots.txt: ${blockedPaths.join(", ")}`,
      severity: "warning",
    };
  },
};

export const ecommerceChecks: Check[] = [
  ecommerceProductSchema,
  ecommerceGtinValid,
  ecommerceCheckoutAccessible,
];
