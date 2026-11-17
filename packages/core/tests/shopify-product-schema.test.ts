import { Liquid } from "liquidjs";
import { describe, expect, it } from "vitest";
import { shopifyProductSchemaCheck } from "../src/adapters/shopify/checks.js";
import { shopifyAdapter } from "../src/adapters/shopify/index.js";
import { detectProductSchema } from "../src/adapters/shopify/product-schema.js";
import type { FetchedPage } from "../src/audit/types.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";

const SITE = "https://shop.example";
const HEAD = "shopify/snippets/w2agent-head.liquid";
const INSTALL = "shopify/INSTALL.md";

// Output copied from https://shopify.dev/docs/api/liquid/filters/structured_data (mocked filter).
const DOC_STRUCTURED_DATA =
  '{"@context":"http:\\/\\/schema.org\\/","@id":"\\/products\\/crocodile-tears#product","@type":"Product","brand":{"@type":"Brand","name":"Polina\'s Potent Potions"},"category":"","description":"","image":"https:\\/\\/polinas-potent-potions.myshopify.com\\/cdn\\/shop\\/products\\/amber-beard-oil-bottle.jpg?v=1650642958\\u0026width=1920","name":"Crocodile tears","offers":{"@id":"\\/products\\/crocodile-tears?variant=39888242344001#offer","@type":"Offer","availability":"http:\\/\\/schema.org\\/OutOfStock","price":"56.00","priceCurrency":"CAD","url":"https:\\/\\/polinas-potent-potions.myshopify.com\\/products\\/crocodile-tears?variant=39888242344001"},"url":"https:\\/\\/polinas-potent-potions.myshopify.com\\/products\\/crocodile-tears"}';

function page(path: string, html: string, status = 200): FetchedPage {
  return { url: `${SITE}${path}`, status, html, headers: {}, responseTime: 1 };
}

function ld(json: unknown): string {
  return `<html><head><script type="application/ld+json">${typeof json === "string" ? json : JSON.stringify(json)}</script></head><body></body></html>`;
}

const NO_SCHEMA = "<html><head><title>Widget</title></head><body>Widget</body></html>";

function generate(rawPages: FetchedPage[]): GeneratedFile[] {
  const ctx: GenerateContext = {
    pages: [],
    rawPages,
    metadata: {} as unknown as GenerateContext["metadata"],
    baseUrl: SITE,
  };
  const core: GeneratedFile[] = [{ filename: "llms.txt", content: "# Shop\n", size: 7 }];
  return shopifyAdapter.generateIntegration(ctx, core);
}

function file(files: GeneratedFile[], name: string): string {
  const f = files.find((x) => x.filename === name);
  if (!f) throw new Error(`${name} not emitted`);
  return f.content;
}

function engine(): Liquid {
  const e = new Liquid({ strictVariables: false, strictFilters: true });
  e.registerFilter("structured_data", (p: unknown) => (p ? DOC_STRUCTURED_DATA : ""));
  return e;
}

function scripts(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
}

const headWithBlock = () => file(generate([page("/products/widget", NO_SCHEMA)]), HEAD);

describe("emitted head snippet rendered with a mocked structured_data filter", () => {
  it("renders exactly one parseable Product script with a decimal price and ISO currency on a product page", async () => {
    const html = await engine().parseAndRender(headWithBlock(), {
      request: { page_type: "product" },
      product: { title: "Crocodile tears" },
    });
    const found = scripts(html);
    expect(found).toHaveLength(1);
    const data = JSON.parse(found[0]);
    expect(data["@type"]).toBe("Product");
    expect(data.offers.price).toMatch(/^\d+\.\d{2}$/);
    expect(data.offers.priceCurrency).toMatch(/^[A-Z]{3}$/);
    expect(html).toContain('href="/llms.txt"');
  });

  it("renders no script on a custom page template whose name contains product", async () => {
    const html = await engine().parseAndRender(headWithBlock(), {
      template: "page.product-faq",
      request: { page_type: "page" },
      product: undefined,
    });
    expect(scripts(html)).toHaveLength(0);
    expect(html).toContain('href="/llms.txt"');
  });

  it("renders no script on a product page with no product object", async () => {
    const html = await engine().parseAndRender(headWithBlock(), {
      request: { page_type: "product" },
    });
    expect(scripts(html)).toHaveLength(0);
  });

  it("renders no script on a non-product page even when a product object is in scope", async () => {
    const html = await engine().parseAndRender(headWithBlock(), {
      request: { page_type: "collection" },
      product: { title: "Crocodile tears" },
    });
    expect(scripts(html)).toHaveLength(0);
  });

  it("uses no hand-built price or currency math", () => {
    const head = headWithBlock();
    for (const banned of ["money_without_currency", "shop.currency", "product.price", "| json"]) {
      expect(head).not.toContain(banned);
    }
    expect(head).toContain("product | structured_data");
  });

  it("passes shopify-product-schema on a product page that contains the rendered output", async () => {
    const rendered = await engine().parseAndRender(headWithBlock(), {
      request: { page_type: "product" },
      product: { title: "Crocodile tears" },
    });
    const result = shopifyProductSchemaCheck.run(
      [page("/products/crocodile-tears", `<html><head>${rendered}</head></html>`)],
      {} as never,
    ) as { status: string; score: number };
    expect(result.status).toBe("pass");
    expect(result.score).toBe(100);
  });
});

describe("shopify head snippet generation from crawl evidence", () => {
  it("omits the block when a crawled product page has Product JSON-LD", () => {
    const files = generate([
      page("/products/widget", ld({ "@context": "https://schema.org", "@type": "Product" })),
    ]);
    expect(file(files, HEAD)).not.toContain("structured_data");
    expect(file(files, HEAD)).toContain('href="/llms.txt"');
    expect(file(files, INSTALL)).toContain("already outputs Product schema");
  });

  it("omits the block when ProductGroup sits inside @graph", () => {
    const files = generate([
      page(
        "/products/widget",
        ld({
          "@context": "https://schema.org",
          "@graph": [{ "@type": "WebSite" }, { "@type": "ProductGroup" }],
        }),
      ),
    ]);
    expect(file(files, HEAD)).not.toContain("structured_data");
  });

  it("accepts an @type array and a top-level array of nodes", () => {
    expect(
      file(generate([page("/products/a", ld({ "@type": ["Thing", "Product"] }))]), HEAD),
    ).not.toContain("structured_data");
    expect(file(generate([page("/products/a", ld([{ "@type": "Product" }]))]), HEAD)).not.toContain(
      "structured_data",
    );
  });

  it("adds the block when product pages have no schema, and INSTALL.md says why", () => {
    const files = generate([page("/products/a", NO_SCHEMA), page("/products/b", NO_SCHEMA)]);
    expect(file(files, HEAD)).toContain("{% if request.page_type == 'product' and product %}");
    expect(file(files, HEAD)).toContain("{{ product | structured_data }}");
    expect(file(files, INSTALL)).toContain("had no Product schema");
  });

  it("treats invalid JSON-LD, non-product types and non-product pages as no evidence of schema", () => {
    const files = generate([
      page("/products/a", ld("{not json")),
      page("/products/b", ld({ "@type": "BreadcrumbList" })),
      page("/", ld({ "@type": "Product" })),
    ]);
    expect(file(files, HEAD)).toContain("structured_data");
  });

  it("ignores failed product fetches and treats no usable product page as unknown", () => {
    const files = generate([
      page("/products/a", "", 0),
      page("/products/b", "<html>Not found</html>", 404),
      page("/", NO_SCHEMA),
    ]);
    expect(file(files, HEAD)).not.toContain("structured_data");
    expect(file(files, INSTALL)).toContain("no crawled product page");
  });

  it("omits the block and says so in INSTALL.md when no pages were crawled", () => {
    const files = generate([]);
    expect(file(files, HEAD)).not.toContain("ld+json");
    expect(file(files, HEAD)).toContain('href="/llms.txt"');
    const install = file(files, INSTALL);
    expect(install).toContain("no crawled product page");
    expect(install).toContain("`structured_data` and for any `application/ld+json` Product script");
    expect(install).toContain("{{ product | structured_data }}");
  });

  it("tells no owner with existing Product schema to add the block", () => {
    const install = file(generate([page("/products/a", ld({ "@type": "Product" }))]), INSTALL);
    expect(install).toContain("nothing to add");
    expect(install).not.toContain("structured_data");
    expect(install).not.toContain("add this");
  });

  it("emits Liquid that parses under strict filters in every state", async () => {
    for (const pages of [
      [],
      [page("/products/a", NO_SCHEMA)],
      [page("/products/a", ld({ "@type": "Product" }))],
    ]) {
      await expect(engine().parseAndRender(file(generate(pages), HEAD), {})).resolves.toContain(
        'href="/llms.txt"',
      );
    }
  });
});

describe("detectProductSchema on schema forms a theme can already output", () => {
  const state = (html: string, path = "/products/a") => detectProductSchema([page(path, html)]);

  it("accepts fully qualified @type values, alone or in an array", () => {
    expect(state(ld({ "@type": "https://schema.org/Product" }))).toBe("present");
    expect(state(ld({ "@type": "http://schema.org/ProductGroup" }))).toBe("present");
    expect(state(ld({ "@type": ["Thing", "https://schema.org/Product"] }))).toBe("present");
    expect(state(ld({ "@type": "https://schema.org/Offer" }))).toBe("absent");
  });

  it("finds Product nested under any property, not only @graph", () => {
    expect(state(ld({ "@type": "WebPage", mainEntity: { "@type": "Product" } }))).toBe("present");
    expect(
      state(
        ld({
          "@type": "ItemList",
          itemListElement: [{ "@type": "ListItem", item: { "@type": "Product" } }],
        }),
      ),
    ).toBe("present");
    expect(state(ld({ "@type": "WebPage", mainEntity: { "@type": "Article" } }))).toBe("absent");
  });

  it("stops at a depth and node budget instead of walking hostile JSON", () => {
    let deep: Record<string, unknown> = { "@type": "Product" };
    for (let i = 0; i < 50; i++) deep = { child: deep };
    expect(state(ld(deep))).toBe("absent");
    const wide = { items: Array.from({ length: 20000 }, () => ({ "@type": "Thing" })) };
    const start = Date.now();
    expect(state(ld({ ...wide, late: { "@type": "Product" } }))).toBe("absent");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("accepts microdata itemtype for Product and ProductGroup, quoted or not", () => {
    expect(state('<div itemscope itemtype="http://schema.org/Product"></div>')).toBe("present");
    expect(state("<div itemscope itemtype='https://schema.org/ProductGroup'></div>")).toBe(
      "present",
    );
    expect(state("<div itemscope itemtype=https://schema.org/Product></div>")).toBe("present");
    expect(
      state('<div itemtype="https://schema.org/Thing https://schema.org/Product"></div>'),
    ).toBe("present");
    expect(state('<div itemscope itemtype="https://schema.org/Offer"></div>')).toBe("absent");
    expect(state('<div itemtype="Product"></div>')).toBe("absent");
  });

  it("ignores JSON-LD and microdata inside HTML comments", () => {
    const script = '<script type="application/ld+json">{"@type":"Product"}</script>';
    expect(state(`<!-- ${script} -->`)).toBe("absent");
    expect(state('<!-- <div itemtype="https://schema.org/Product"></div> -->')).toBe("absent");
    expect(state(`<!-- old --> ${script}`)).toBe("present");
    expect(state(`<!-- never closed ${script}`)).toBe("absent");
  });

  it("does not match attributes that merely end in itemtype", () => {
    expect(state('<div data-itemtype="https://schema.org/Product"></div>')).toBe("absent");
    expect(state('<div x-itemtype="https://schema.org/Product"></div>')).toBe("absent");
  });

  it("keeps valid JSON-LD whose string contains a comment opener", () => {
    expect(
      state(
        '<script type="application/ld+json">{"@type":"Product","description":"Use <!-- for comments"}</script>',
      ),
    ).toBe("present");
  });

  it("accepts the JSON-LD type case-insensitively, unquoted or with parameters", () => {
    const body = '{"@type":"Product"}';
    expect(state(`<script type=application/ld+json>${body}</script>`)).toBe("present");
    expect(state(`<script type="Application/LD+JSON">${body}</script>`)).toBe("present");
    expect(state(`<script type="application/ld+json; charset=utf-8">${body}</script>`)).toBe(
      "present",
    );
    expect(state(`<script type="application/json">${body}</script>`)).toBe("absent");
  });
});
