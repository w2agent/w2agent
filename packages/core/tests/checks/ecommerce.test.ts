import { describe, expect, it } from "vitest";
import {
  ecommerceCheckoutAccessible,
  ecommerceGtinValid,
  ecommerceProductSchema,
  validateGtin,
} from "../../src/audit/checks/ecommerce.js";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";

const baseMeta: SiteMetadata = {
  baseUrl: "https://shop.example.com",
  wellKnown: {},
};

function makePage(html: string, url = "https://shop.example.com/product/1"): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}

function productHtml(
  overrides: { name?: string; price?: string; availability?: string; gtin?: string } = {},
): string {
  const { name = "Widget Pro", price, availability, gtin } = overrides;
  const offerFields = [
    price !== undefined ? `"price": "${price}"` : null,
    price !== undefined ? `"priceCurrency": "USD"` : null,
    availability !== undefined ? `"availability": "${availability}"` : null,
  ]
    .filter(Boolean)
    .join(",\n      ");
  const offers =
    offerFields.length > 0
      ? `,\n  "offers": {\n    "@type": "Offer",\n    ${offerFields}\n  }`
      : "";
  const gtinField = gtin ? `,\n  "gtin13": "${gtin}"` : "";

  return `<html><head><script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "${name}"${offers}${gtinField}
}
</script></head><body><h1>${name}</h1></body></html>`;
}

// ─── ecommerce-product-schema ───────────────────────────────────────────────

describe("ecommerce-product-schema", () => {
  it("passes when all product pages have complete JSON-LD", () => {
    const html = productHtml({ price: "29.99", availability: "https://schema.org/InStock" });
    const result = ecommerceProductSchema.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("partial when some product pages lack price or availability", () => {
    const complete = productHtml({ price: "29.99", availability: "https://schema.org/InStock" });
    const incomplete = productHtml({ name: "Basic Widget" }); // no price/availability
    const result = ecommerceProductSchema.run(
      [makePage(complete), makePage(incomplete, "https://shop.example.com/product/2")],
      baseMeta,
    );
    expect(result).toMatchObject({ status: "partial", score: 50 });
  });

  it("fails when product pages have no price or availability in schema", () => {
    const html = productHtml({ name: "Widget" }); // name only, no offers
    const result = ecommerceProductSchema.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });

  it("skips when no product pages detected", () => {
    const html = "<html><body><h1>About Us</h1></body></html>";
    const result = ecommerceProductSchema.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "skip" });
  });

  it("includes a fix snippet when not passing", () => {
    const html = productHtml({ name: "Widget" });
    const result = ecommerceProductSchema.run([makePage(html)], baseMeta);
    expect(result.fixSnippet).toContain("schema.org/InStock");
  });
});

// ─── ecommerce-gtin-valid ───────────────────────────────────────────────────

describe("validateGtin", () => {
  it("validates a correct GTIN-13", () => {
    expect(validateGtin("9780201379624")).toBe(true);
  });

  it("rejects a GTIN-13 with wrong check digit", () => {
    expect(validateGtin("9780201379625")).toBe(false);
  });

  it("validates a correct GTIN-12 (UPC-A)", () => {
    expect(validateGtin("012345678905")).toBe(true);
  });

  it("rejects an invalid length string", () => {
    expect(validateGtin("123")).toBe(false);
  });

  it("strips non-digit characters before validating", () => {
    expect(validateGtin("978-0201379624")).toBe(true);
  });
});

describe("ecommerce-gtin-valid", () => {
  it("passes when all GTINs are valid", () => {
    const html = productHtml({ gtin: "9780201379624" });
    const result = ecommerceGtinValid.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when GTIN has invalid check digit", () => {
    const html = productHtml({ gtin: "9780201379625" });
    const result = ecommerceGtinValid.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });

  it("skips when no products have GTINs", () => {
    const html = productHtml({ price: "9.99" }); // product but no gtin
    const result = ecommerceGtinValid.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "skip" });
  });

  it("skips on non-product pages", () => {
    const html = "<html><body><h1>No schema</h1></body></html>";
    const result = ecommerceGtinValid.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "skip" });
  });
});

// ─── ecommerce-checkout-accessible ─────────────────────────────────────────

const cartPageHtml = `<html><body>
  <a href="/cart">View Cart</a>
  <a href="/checkout">Checkout</a>
</body></html>`;

describe("ecommerce-checkout-accessible", () => {
  it("passes when checkout links exist and not blocked", () => {
    const result = ecommerceCheckoutAccessible.run([makePage(cartPageHtml)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("passes when robots.txt exists but does not block checkout", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      robotsTxt: "User-agent: *\nAllow: /\nDisallow: /admin/",
    };
    const result = ecommerceCheckoutAccessible.run([makePage(cartPageHtml)], meta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when checkout paths are blocked by robots.txt", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      robotsTxt: "User-agent: *\nDisallow: /cart\nDisallow: /checkout",
    };
    const result = ecommerceCheckoutAccessible.run([makePage(cartPageHtml)], meta);
    expect(result.score).toBeLessThan(100);
    expect(result.message).toContain("blocked by robots.txt");
  });

  it("skips when no checkout URLs found in links", () => {
    const html = "<html><body><a href='/about'>About</a></body></html>";
    const result = ecommerceCheckoutAccessible.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "skip" });
  });

  it("detects /bag and /basket paths", () => {
    const html = `<html><body>
      <a href="/bag">My Bag</a>
      <a href="/basket">Basket</a>
    </body></html>`;
    const result = ecommerceCheckoutAccessible.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass" });
    expect(result.message).toContain("2");
  });
});
