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
    // Add to Cart control (0.3) + Commerce URL (0.4) + Price microdata (0.4)
    // → 1 - (0.7)(0.6)(0.6) = 1 - 0.252 = 0.748
    const html = `<html><body>
      <form action="/subscribe"><button>Add to Cart</button></form>
      <a href="/cart">Go to cart</a>
      <span itemprop="price">$9.99</span>
    </body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result?.signals).toEqual([
      "Commerce URL paths",
      "Price microdata",
      "Add to cart / Buy now text",
    ]);
    expect(result?.confidence).toBeCloseTo(0.748, 3);
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

describe("structural commerce evidence (no prose false positives)", () => {
  const prose =
    "We detect Magento, WooCommerce, BigCommerce, woocommerce, bigcommerce, cdn.bigcommerce.com, cdn.shopify.com, Shopify.theme = x, wc-ajax=1, mage/cookies, add to cart and buy now.";

  it("does not classify a docs page that names platforms in prose and an RSC payload", () => {
    const html = `<html><body><p>${prose}</p><code>cdn.shopify.com</code><script>self.__next_f.push([1,"${prose.replace(/"/g, '\\"')} Mage.Cookies Shopify.theme = 1"])</script></body></html>`;
    expect(ecommerceDetector.detect([makePage(html)], baseMeta)).toBeNull();
  });

  it("does not classify a SaaS pricing page with a Buy now CTA and a Products nav link", () => {
    const html = `<html><body><nav><a href="/products">Products</a><a href="/pricing">Pricing</a></nav><h1>Pricing</h1><a href="/signup">Buy now</a><button>Buy now</button></body></html>`;
    expect(ecommerceDetector.detect([makePage(html)], baseMeta)).toBeNull();
  });

  it("still classifies a Shopify store (script src, Product JSON-LD, add-to-cart form)", () => {
    const html = `<html><head><script src="https://cdn.shopify.com/s/files/theme.js"></script><script type="application/ld+json">{"@type":"Product","name":"Mug"}</script></head><body><form action="/cart/add" method="post"><button type="submit">Add to cart</button></form></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result?.siteType).toBe("ecommerce");
    expect(result?.signals).toEqual(
      expect.arrayContaining([
        "Shopify platform marker",
        "Product schema (JSON-LD)",
        "Add to cart / Buy now text",
      ]),
    );
  });

  it("detects Shopify.theme assignment in a real inline script", () => {
    const html = `<html><body><script>window.Shopify = window.Shopify || {}; Shopify.theme = {"id":1};</script></body></html>`;
    expect(ecommerceDetector.detect([makePage(html)], baseMeta)?.signals).toContain(
      "Shopify platform marker",
    );
  });

  it("detects Magento via x-magento-init and data-mage-init markup", () => {
    const init = `<html><body><script type="text/x-magento-init">{"*":{}}</script></body></html>`;
    const attr = `<html><body><div data-mage-init='{"x":1}'></div></body></html>`;
    expect(ecommerceDetector.detect([makePage(init)], baseMeta)?.signals).toContain(
      "Magento marker",
    );
    expect(ecommerceDetector.detect([makePage(attr)], baseMeta)?.signals).toContain(
      "Magento marker",
    );
  });

  it("detects WooCommerce via body class and a link to /cart with cart text", () => {
    const html = `<html><body class="woocommerce-page"><a href="/cart">Buy now</a></body></html>`;
    const result = ecommerceDetector.detect([makePage(html)], baseMeta);
    expect(result?.signals).toContain("WooCommerce marker");
    expect(result?.signals).toContain("Add to cart / Buy now text");
  });
});

describe("detector fix round 1", () => {
  const detect = (html: string) => ecommerceDetector.detect([makePage(html)], baseMeta);

  it("ignores woocommerce substrings in non-body class names", () => {
    expect(
      detect(
        `<html><body class="home"><img class="logo logo-woocommerce" src="/w.png"></body></html>`,
      ),
    ).toBeNull();
    expect(
      detect(`<html><body><div class="woocommerce-docs-callout">Docs</div></body></html>`),
    ).toBeNull();
  });

  it("detects a store by woocommerce-no-js body class token", () => {
    expect(detect(`<html><body class="home woocommerce-no-js"></body></html>`)?.signals).toContain(
      "WooCommerce marker",
    );
  });

  it("detects WooCommerce plugin assets even without a body class", () => {
    const html = `<html><head><link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css"></head><body class="home"><script src="/wp-content/plugins/woocommerce/assets/js/frontend/cart-fragments.min.js"></script></body></html>`;
    expect(detect(html)?.signals).toContain("WooCommerce marker");
  });

  it("does not treat developer.bigcommerce.com links as a BigCommerce store", () => {
    expect(
      detect(
        `<html><head><link rel="preconnect" href="https://developer.bigcommerce.com"><link rel="alternate" href="https://www.bigcommerce.com/blog/feed"></head><body></body></html>`,
      ),
    ).toBeNull();
  });

  it("detects BigCommerce via numbered asset CDN host", () => {
    const html = `<html><head><script src="https://cdn11.bigcommerce.com/s-abc/stencil/app.js"></script></head><body></body></html>`;
    expect(detect(html)?.signals).toContain("BigCommerce marker");
  });

  it("detects BigCommerce via asset CDN image", () => {
    const html = `<html><body><img src="https://cdn11.bigcommerce.com/s-abc/img/p.png"></body></html>`;
    expect(detect(html)?.signals).toContain("BigCommerce marker");
  });

  it.each([
    "text/javascript; charset=utf-8",
    "text/rocketscript",
    "0123456789abcdef-text/javascript",
    "text/partytown",
  ])("treats script type %s as code for Shopify.theme", (type) => {
    const html = `<html><body><script type="${type}">Shopify.theme = {"id":1};</script></body></html>`;
    expect(detect(html)?.signals).toContain("Shopify platform marker");
  });

  it.each([
    "application/json",
    "application/ld+json",
    "importmap",
    "speculationrules",
    "text/x-template",
  ])("treats script type %s as data for Shopify.theme", (type) => {
    const html = `<html><body><script type="${type}">Shopify.theme = {"id":1};</script></body></html>`;
    expect(detect(html)).toBeNull();
  });
});
