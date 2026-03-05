import type { Check, FetchedPage, SiteMetadata } from "../../audit/types.js";

export const shopifyRobotsEditableCheck: Check = {
  id: "shopify-robots-editable",
  name: "Shopify Robots.txt Customizable",
  category: "bot-accessibility",
  weight: 1,
  severity: "warning",
  run(_pages: FetchedPage[], metadata: SiteMetadata) {
    const robots = metadata.robotsTxt || "";
    // Shopify 2.0+ allows robots.txt.liquid customization
    // The default Shopify robots.txt has specific patterns
    const isShopifyDefault =
      robots.includes("Disallow: /admin") &&
      robots.includes("Disallow: /cart") &&
      robots.includes("Disallow: /checkout");

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: isShopifyDefault ? "partial" : "pass",
      score: isShopifyDefault ? 60 : 100,
      maxScore: 100,
      message: isShopifyDefault
        ? "Using default Shopify robots.txt — customize via robots.txt.liquid to add AI bot rules"
        : "robots.txt appears customized — good foundation for AI bot rules",
      details: isShopifyDefault
        ? "In your Shopify theme, create or edit templates/robots.txt.liquid to add AI-friendly rules."
        : undefined,
    };
  },
};

export const shopifyProductSchemaCheck: Check = {
  id: "shopify-product-schema",
  name: "Shopify Product Schema.org",
  category: "structured-data",
  weight: 1,
  severity: "warning",
  run(pages: FetchedPage[]) {
    let productPages = 0;
    let withSchema = 0;

    for (const page of pages) {
      if (page.url.includes("/products/")) {
        productPages++;
        const hasProductSchema =
          page.html.includes('"@type":"Product"') || page.html.includes('"@type": "Product"');
        if (hasProductSchema) withSchema++;
      }
    }

    if (productPages === 0) {
      return {
        id: this.id,
        name: this.name,
        category: this.category,
        weight: this.weight,
        severity: this.severity,
        status: "skip",
        score: 100,
        maxScore: 100,
        message: "No product pages found to check",
      };
    }

    const ratio = withSchema / productPages;
    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: ratio >= 0.8 ? "pass" : ratio > 0 ? "partial" : "fail",
      score: Math.round(ratio * 100),
      maxScore: 100,
      message:
        ratio >= 0.8
          ? `${withSchema}/${productPages} product pages have Product JSON-LD schema`
          : `Only ${withSchema}/${productPages} product pages have Product JSON-LD. AI agents need structured product data.`,
      details:
        ratio < 0.8
          ? "Ensure your Shopify theme includes Product structured data with price, availability, and reviews."
          : undefined,
    };
  },
};

export const shopifyThemeAppBlocksCheck: Check = {
  id: "shopify-theme-app-blocks",
  name: "Shopify Theme App Blocks Support",
  category: "technical",
  weight: 1,
  severity: "info",
  run(pages: FetchedPage[]) {
    // Online Store 2.0 themes use JSON templates and support app blocks
    const hasOS2Signals = pages.some(
      (p) =>
        p.html.includes("shopify-section") ||
        p.html.includes("data-section-type") ||
        p.html.includes("shopify-block"),
    );

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: hasOS2Signals ? "pass" : "partial",
      score: hasOS2Signals ? 100 : 50,
      maxScore: 100,
      message: hasOS2Signals
        ? "Theme appears to support Online Store 2.0 app blocks — easy to add AI integration snippets"
        : "Theme may not support app blocks. Manual Liquid template editing may be required.",
    };
  },
};

export const shopifyChecks: Check[] = [
  shopifyRobotsEditableCheck,
  shopifyProductSchemaCheck,
  shopifyThemeAppBlocksCheck,
];
