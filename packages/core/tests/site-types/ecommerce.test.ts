import { describe, expect, it } from "vitest";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";
import { ecommerceDetector } from "../../src/site-types/ecommerce.js";
import { detectSiteType } from "../../src/site-types/registry.js";

// Ensure detectors are registered (same pattern as adapters.test.ts)
import "../../src/site-types/index.js";

function makePage(html: string, url = "https://example.com"): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

describe("Shopify detection", () => {
  it("detects Shopify via CDN URL", () => {
    const html = `<html><head><script src="https://cdn.shopify.com/s/files/1/0001/theme.js"></script></head><body></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.siteType).toBe("ecommerce");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result?.signals).toContain("Shopify platform marker");
  });

  it("detects Shopify via checkout meta tag", () => {
    const html = `<html><head><meta name="shopify-checkout-api-token" content="abc123"></head><body></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Shopify platform marker");
  });
});

describe("WooCommerce detection", () => {
  it("detects WooCommerce via body class", () => {
    const html = `<html><body class="woocommerce"><div class="products"></div></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("WooCommerce marker");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("detects WooCommerce via wc-ajax query param in link", () => {
    const html = `<html><body><a href="/?wc-ajax=get_refreshed_fragments">cart</a></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("WooCommerce marker");
  });
});

describe("BigCommerce detection", () => {
  it("detects BigCommerce via CDN", () => {
    const html = `<html><head><script src="https://cdn.bigcommerce.com/s/abc/assets/js/theme.js"></script></head><body></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("BigCommerce marker");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe("Magento detection", () => {
  it("detects Magento via Mage.Cookies reference", () => {
    const html = `<html><body><script>Mage.Cookies.set('mage-messages', '');</script></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Magento marker");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe("Product JSON-LD", () => {
  it("detects Product schema in JSON-LD", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Test Product","price":"29.99"}</script>
    </head><body></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Product schema (JSON-LD)");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe("og:type=product", () => {
  it("detects og:type product signal", () => {
    const html = `<html><head><meta property="og:type" content="product"></head><body></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    // og:type=product alone has weight 0.5 → confidence = 0.5 → right on threshold
    // The detector returns null if confidence < 0.5 — 0.5 is NOT less than 0.5, so should detect
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("og:type=product");
  });
});

describe("Commerce URL paths", () => {
  it("does not detect on commerce URL alone (0.4 weight)", () => {
    const html = `<html><body><p>Welcome</p></body></html>`;
    const result = ecommerceDetector.detect(
      [makePage(html, "https://example.com/products/widget")],
      baseMeta,
    );
    // Commerce URL alone = 0.4 → below threshold → null
    expect(result).toBeNull();
  });

  it("detects when commerce URLs combine with price microdata to exceed threshold", () => {
    const html = `<html><body>
      <a href="/cart">Cart</a>
      <span itemprop="price">$29.99</span>
    </body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    // Commerce URL (0.4) + Price microdata (0.4) = 1 - (0.6 * 0.6) = 0.64 → detected
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Commerce URL paths");
    expect(result?.signals).toContain("Price microdata");
    expect(result?.confidence).toBeCloseTo(0.64, 1);
  });
});

describe("Price microdata", () => {
  it("picks up itemprop=price", () => {
    const html = `<html><body><span itemprop="price">$19.99</span></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    // Alone: 0.4 → below threshold → null
    expect(result).toBeNull();
  });
});

describe("Non-ecommerce sites", () => {
  it("returns null for a plain docs/blog page", () => {
    const html = `<html><head><title>My Blog</title></head><body><h1>Hello World</h1><p>Welcome to my blog about programming.</p></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result).toBeNull();
  });

  it("returns null for empty HTML", () => {
    const result = ecommerceDetector.detect([makePage("<html><body></body></html>")], baseMeta);
    expect(result).toBeNull();
  });

  it("returns null for empty pages array", () => {
    const result = ecommerceDetector.detect([], baseMeta);
    expect(result).toBeNull();
  });
});

describe("Mixed signals below threshold", () => {
  it("does not detect on Add to Cart text alone (0.3 weight)", () => {
    const html = `<html><body><button>Add to Cart</button></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    // 0.3 < 0.5 → null
    expect(result).toBeNull();
  });

  it("does not detect on commerce URL alone (0.4 weight)", () => {
    const html = `<html><body><a href="/checkout">Checkout</a></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    // 0.4 < 0.5 → null
    expect(result).toBeNull();
  });

  it("detects when 3 weak signals combine", () => {
    // Add to Cart (0.3) + Commerce URL (0.4) + Price microdata (0.4)
    // → 1 - (0.7)(0.6)(0.6) = 1 - 0.252 = 0.748
    const html = `<html><body>
      <button>Add to Cart</button>
      <a href="/cart">Go to cart</a>
      <span itemprop="price">$9.99</span>
    </body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBeGreaterThan(0.5);
  });
});

describe("Signal list accuracy", () => {
  it("returns only matched signals (no false positives in list)", () => {
    const html = `<html><head><script src="https://cdn.shopify.com/theme.js"></script></head><body></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    // Should only contain Shopify, not WooCommerce/BigCommerce/etc.
    expect(result?.signals).toEqual(["Shopify platform marker"]);
  });

  it("deduplicates signals across multiple pages", () => {
    const shopifyHtml = `<html><head><script src="https://cdn.shopify.com/theme.js"></script></head><body></body></html>`;
    const pages = [makePage(shopifyHtml), makePage(shopifyHtml, "https://example.com/products")];
    const result = ecommerceDetector.detect(pages, baseMeta);
    expect(result).not.toBeNull();
    // Shopify marker should only appear once even though 2 pages matched
    const shopifySignals = result?.signals.filter((s) => s === "Shopify platform marker");
    expect(shopifySignals).toHaveLength(1);
  });
});

describe("detectSiteType registry", () => {
  it("returns ecommerce via registry when Shopify detected", () => {
    const html = `<html><head><script src="https://cdn.shopify.com/theme.js"></script></head><body></body></html>`;
    const result = detectSiteType([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.siteType).toBe("ecommerce");
  });

  it("returns null via registry for non-ecommerce site", () => {
    const html = `<html><body><p>Just a blog post.</p></body></html>`;
    const result = detectSiteType([makePage(html)], baseMeta);
    expect(result).toBeNull();
  });
});
