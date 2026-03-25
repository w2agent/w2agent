import { describe, expect, it } from "vitest";
import type { FetchedPage } from "../src/audit/types.js";
import {
  buildEcommerceArtifacts,
  extractProducts,
  generateCommerceToolHandlers,
  generateProductCatalog,
  generateProductId,
} from "../src/generate/ecommerce.js";
import { generateSchemaOrg } from "../src/generate/schema-org.js";
import type { GenerateContext } from "../src/generate/types.js";

function makePage(html: string, url = "https://example.com/product"): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}

function makeContext(
  pages: FetchedPage[],
  siteType?: { siteType: string; confidence: number; signals: string[] },
): GenerateContext {
  return {
    pages: [],
    rawPages: pages,
    metadata: { baseUrl: "https://example.com", wellKnown: {} },
    baseUrl: "https://example.com",
    siteType,
  };
}

const ECOMMERCE_SITE_TYPE = { siteType: "ecommerce", confidence: 0.9, signals: ["Shopify"] };

const PRODUCT_JSONLD_HTML = `<html><head>
  <script type="application/ld+json">{
    "@context":"https://schema.org","@type":"Product",
    "name":"Test Widget","description":"A great widget",
    "image":"https://example.com/widget.jpg",
    "brand":{"@type":"Brand","name":"Acme"},
    "offers":{"@type":"Offer","price":"29.99","priceCurrency":"USD","availability":"https://schema.org/InStock"},
    "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.5","reviewCount":"123","bestRating":"5"},
    "sku":"WIDGET-001"
  }</script>
</head><body></body></html>`;

const MICRODATA_HTML = `<html><body>
  <div itemscope itemtype="https://schema.org/Product">
    <span itemprop="name">Microdata Product</span>
    <span itemprop="price" content="19.99">$19.99</span>
    <meta itemprop="priceCurrency" content="USD">
    <link itemprop="availability" href="https://schema.org/InStock">
  </div>
</body></html>`;

const OG_PRODUCT_HTML = `<html><head>
  <meta property="og:type" content="product">
  <meta property="og:title" content="OG Product">
  <meta property="og:description" content="An OG product">
  <meta property="product:price:amount" content="39.99">
  <meta property="product:price:currency" content="USD">
</head><body></body></html>`;

describe("JSON-LD extraction", () => {
  it("extracts product from JSON-LD with all fields", () => {
    const products = extractProducts(makeContext([makePage(PRODUCT_JSONLD_HTML)]));
    expect(products).toHaveLength(1);
    const p = products[0];
    expect(p.source).toBe("json-ld");
    expect(p.name).toBe("Test Widget");
    expect(p.description).toBe("A great widget");
    expect(p.price).toBe(29.99);
    expect(p.currency).toBe("USD");
    expect(p.availability).toBe("InStock");
    expect(p.brand).toBe("Acme");
    expect(p.sku).toBe("WIDGET-001");
    expect(p.rating).toBe(4.5);
    expect(p.reviewCount).toBe(123);
    expect(p.bestRating).toBe(5);
    expect(p.productId).toMatch(/^p_/);
  });
});

describe("Microdata extraction", () => {
  it("extracts product from microdata", () => {
    const products = extractProducts(makeContext([makePage(MICRODATA_HTML)]));
    expect(products).toHaveLength(1);
    const p = products[0];
    expect(p.source).toBe("microdata");
    expect(p.name).toBe("Microdata Product");
    expect(p.price).toBe(19.99);
    expect(p.currency).toBe("USD");
    expect(p.availability).toBe("InStock");
    expect(p.productId).toMatch(/^p_/);
  });
});

describe("OG tag extraction", () => {
  it("extracts product from OG product tags", () => {
    const products = extractProducts(makeContext([makePage(OG_PRODUCT_HTML)]));
    expect(products).toHaveLength(1);
    const p = products[0];
    expect(p.source).toBe("og");
    expect(p.name).toBe("OG Product");
    expect(p.description).toBe("An OG product");
    expect(p.price).toBe(39.99);
    expect(p.currency).toBe("USD");
    expect(p.productId).toMatch(/^p_/);
  });
});

describe("Extraction precedence", () => {
  it("prefers JSON-LD over OG tags when both are present", () => {
    const combined = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"JSON-LD Widget","description":"From JSON-LD","offers":{"price":"29.99","priceCurrency":"USD"}}</script>
      <meta property="og:type" content="product">
      <meta property="og:title" content="OG Widget">
    </head><body></body></html>`;
    const products = extractProducts(makeContext([makePage(combined)]));
    expect(products).toHaveLength(1);
    expect(products[0].source).toBe("json-ld");
    expect(products[0].name).toBe("JSON-LD Widget");
  });
});

describe("Quality filter", () => {
  it("filters out product with name but no price and no description", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Bare Widget"}</script>
    </head><body></body></html>`;
    const products = extractProducts(makeContext([makePage(html)]));
    expect(products).toHaveLength(0);
  });

  it("keeps product with name and price but no description", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Priced Widget","offers":{"price":"9.99","priceCurrency":"USD"}}</script>
    </head><body></body></html>`;
    const products = extractProducts(makeContext([makePage(html)]));
    expect(products).toHaveLength(1);
  });
});

describe("Product ID", () => {
  it("generates stable productId for same URL", () => {
    const id1 = generateProductId("https://example.com/product");
    const id2 = generateProductId("https://example.com/product");
    expect(id1).toBe(id2);
  });

  it("generates different productIds for different URLs", () => {
    const id1 = generateProductId("https://example.com/product-a");
    const id2 = generateProductId("https://example.com/product-b");
    expect(id1).not.toBe(id2);
  });
});

describe("buildEcommerceArtifacts", () => {
  it("returns null when siteType is undefined", () => {
    const result = buildEcommerceArtifacts(makeContext([makePage(PRODUCT_JSONLD_HTML)]));
    expect(result).toBeNull();
  });

  it("returns null when siteType is not ecommerce", () => {
    const ctx = makeContext([makePage(PRODUCT_JSONLD_HTML)], {
      siteType: "blog",
      confidence: 0.9,
      signals: [],
    });
    expect(buildEcommerceArtifacts(ctx)).toBeNull();
  });

  it("returns null when ecommerce site but no products found", () => {
    const ctx = makeContext(
      [makePage("<html><body>No products here</body></html>")],
      ECOMMERCE_SITE_TYPE,
    );
    expect(buildEcommerceArtifacts(ctx)).toBeNull();
  });

  it("returns artifacts with products when ecommerce site has products", () => {
    const ctx = makeContext([makePage(PRODUCT_JSONLD_HTML)], ECOMMERCE_SITE_TYPE);
    const result = buildEcommerceArtifacts(ctx);
    expect(result).not.toBeNull();
    expect(result?.products).toHaveLength(1);
    expect(result?.products[0].name).toBe("Test Widget");
  });
});

describe("generateProductCatalog", () => {
  it("generates markdown table with correct columns and header comment", () => {
    const products = extractProducts(makeContext([makePage(PRODUCT_JSONLD_HTML)]));
    const catalog = generateProductCatalog(products);
    expect(catalog).toContain("<!-- Generated by w2agent -->");
    expect(catalog).toContain("| Product | Price | Availability | Rating | URL |");
    expect(catalog).toContain("Test Widget");
    expect(catalog).toContain("$29.99");
    expect(catalog).toContain("InStock");
    expect(catalog).toContain("4.5/5");
    expect(catalog).toContain("123 reviews");
  });

  it("sorts products alphabetically by name", () => {
    const apple: Parameters<typeof generateProductCatalog>[0][0] = {
      productId: "p_1",
      name: "Apple",
      url: "https://example.com/apple",
      source: "json-ld",
    };
    const zebra: Parameters<typeof generateProductCatalog>[0][0] = {
      productId: "p_2",
      name: "Zebra",
      url: "https://example.com/zebra",
      source: "json-ld",
    };
    const catalog = generateProductCatalog([zebra, apple]);
    expect(catalog.indexOf("Apple")).toBeLessThan(catalog.indexOf("Zebra"));
  });
});

describe("generateCommerceToolHandlers", () => {
  it("returns string containing all 4 function names", () => {
    const code = generateCommerceToolHandlers();
    expect(typeof code).toBe("string");
    expect(code).toContain("searchProducts");
    expect(code).toContain("getProduct");
    expect(code).toContain("checkInventory");
    expect(code).toContain("getReviews");
  });
});

describe("schema-org Product generation", () => {
  it("generates Product JSON-LD for page with microdata product", () => {
    const ctx = makeContext([makePage(MICRODATA_HTML)]);
    const products = extractProducts(ctx);
    const entries = generateSchemaOrg(ctx, products);
    expect(entries).not.toBeNull();
    const productEntry = entries!.find((e) => e.jsonLd["@type"] === "Product");
    expect(productEntry).toBeDefined();
    expect(productEntry!.jsonLd.name).toBe("Microdata Product");
    expect(productEntry!.jsonLd.offers).toBeDefined();
    const offers = productEntry!.jsonLd.offers as Record<string, unknown>;
    expect(offers.price).toBe(19.99);
  });

  it("does not generate Product JSON-LD when page already has it", () => {
    const ctx = makeContext([makePage(PRODUCT_JSONLD_HTML)]);
    const products = extractProducts(ctx);
    const entries = generateSchemaOrg(ctx, products);
    // Page has existing Product JSON-LD, so schema-org generator skips it
    expect(entries).toBeNull();
  });

  it("works without products parameter", () => {
    const simpleHtml = "<html><head><title>Hello</title></head><body>World</body></html>";
    const ctx = makeContext([makePage(simpleHtml, "https://example.com/about")]);
    const entries = generateSchemaOrg(ctx);
    expect(entries).not.toBeNull();
    expect(entries![0].jsonLd["@type"]).toBe("WebPage");
  });
});

describe("engine wiring", () => {
  it("artifacts flow: build once, pass to schema-org and catalog", () => {
    const ctx = makeContext(
      [makePage(MICRODATA_HTML), makePage(OG_PRODUCT_HTML, "https://example.com/og-product")],
      ECOMMERCE_SITE_TYPE,
    );
    const artifacts = buildEcommerceArtifacts(ctx);
    expect(artifacts).not.toBeNull();

    // Same artifacts feed schema-org
    const schemaEntries = generateSchemaOrg(ctx, artifacts!.products);
    expect(schemaEntries).not.toBeNull();
    const productEntries = schemaEntries!.filter((e) => e.jsonLd["@type"] === "Product");
    expect(productEntries).toHaveLength(2);

    // Same artifacts feed catalog
    const catalog = generateProductCatalog(artifacts!.products);
    expect(catalog).toContain("Microdata Product");
    expect(catalog).toContain("OG Product");
  });
});
