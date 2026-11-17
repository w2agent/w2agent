import { describe, expect, it } from "vitest";
import { generateLlmsTxt } from "../app/lib/generate";

function mockAdmin(shop: object, products: object[], pages: object[]) {
  const pageInfo = { hasNextPage: false, endCursor: null };
  return {
    graphql: async (query: string) => {
      if (query.includes("ShopInfo")) {
        return Response.json({ data: { shop } });
      }
      if (query.includes("Products")) {
        return Response.json({
          data: { products: { edges: products.map((p) => ({ node: p })), pageInfo } },
        });
      }
      if (query.includes("Pages")) {
        return Response.json({
          data: { pages: { edges: pages.map((p) => ({ node: p })), pageInfo } },
        });
      }
      return Response.json({ data: {} });
    },
  };
}

describe("generateLlmsTxt", () => {
  it("full store — formats shop, products, and pages", async () => {
    const admin = mockAdmin(
      {
        name: "Acme Store",
        description: "Quality goods since 1990",
        primaryDomain: { url: "https://acme.myshopify.com" },
      },
      [
        {
          title: "Widget",
          handle: "widget",
          onlineStoreUrl: "https://acme.myshopify.com/products/widget",
          descriptionHtml: "<p>A great widget</p>",
        },
        {
          title: "Gadget",
          handle: "gadget",
          onlineStoreUrl: "https://acme.myshopify.com/products/gadget",
          descriptionHtml: "<p>An amazing gadget</p>",
        },
      ],
      [{ title: "About Us", handle: "about", isPublished: true, body: "We are Acme." }],
    );

    const result = await generateLlmsTxt(admin);

    expect(result).toContain("# Acme Store");
    expect(result).toContain("> Quality goods since 1990");
    expect(result).toContain("## Products");
    expect(result).toContain("[Widget](https://acme.myshopify.com/products/widget)");
    expect(result).toContain("[Gadget](https://acme.myshopify.com/products/gadget)");
    expect(result).toContain("## Pages");
    expect(result).toContain("[About Us](https://acme.myshopify.com/pages/about)");
  });

  it("empty store — returns minimal output with no Products/Pages sections", async () => {
    const admin = mockAdmin(
      {
        name: "Empty Shop",
        description: "Nothing here yet",
        primaryDomain: { url: "https://empty.myshopify.com" },
      },
      [],
      [],
    );

    const result = await generateLlmsTxt(admin);

    expect(result).toBe("# Empty Shop\n\n> Nothing here yet\n\n");
    expect(result).not.toContain("## Products");
    expect(result).not.toContain("## Pages");
  });

  it("no description — omits blockquote line", async () => {
    const admin = mockAdmin(
      {
        name: "No Desc Shop",
        description: null,
        primaryDomain: { url: "https://nodesc.myshopify.com" },
      },
      [],
      [],
    );

    const result = await generateLlmsTxt(admin);

    expect(result).toContain("# No Desc Shop");
    expect(result).not.toContain(">");
  });

  it("HTML stripping — strips tags and decodes entities", async () => {
    const admin = mockAdmin(
      {
        name: "Shop",
        description: null,
        primaryDomain: { url: "https://shop.myshopify.com" },
      },
      [
        {
          title: "Test Product",
          handle: "test",
          onlineStoreUrl: "https://shop.myshopify.com/products/test",
          descriptionHtml: "<p>Hello <strong>world</strong> &amp; friends</p>",
        },
      ],
      [],
    );

    const result = await generateLlmsTxt(admin);

    expect(result).toContain("Hello world & friends");
    expect(result).not.toContain("<p>");
    expect(result).not.toContain("<strong>");
    expect(result).not.toContain("&amp;");
  });

  it("truncation — long descriptions are truncated to ≤25 words with ellipsis", async () => {
    const longDesc = Array.from({ length: 30 }, (_, i) => `word${i + 1}`).join(" ");
    const admin = mockAdmin(
      {
        name: "Shop",
        description: null,
        primaryDomain: { url: "https://shop.myshopify.com" },
      },
      [{ title: "Long Product", handle: "long", onlineStoreUrl: "u", descriptionHtml: longDesc }],
      [],
    );

    const result = await generateLlmsTxt(admin);

    const descLine = result.split("\n").find((l) => l.includes("[Long Product]"));
    expect(descLine).toBeDefined();
    const descPart = descLine?.split(": ")[1];
    expect(descPart).toMatch(/\.\.\.$/);
    expect(
      descPart
        ?.replace(/\.\.\.$/, "")
        .trim()
        .split(/\s+/).length,
    ).toBe(25);
  });

  it("product without description — formats as bare link without trailing colon", async () => {
    const admin = mockAdmin(
      {
        name: "Shop",
        description: null,
        primaryDomain: { url: "https://shop.myshopify.com" },
      },
      [{ title: "No Desc Product", handle: "nodesc", onlineStoreUrl: "u", descriptionHtml: "" }],
      [],
    );

    const result = await generateLlmsTxt(admin);

    expect(result).toContain("- [No Desc Product](https://shop.myshopify.com/products/nodesc)\n");
    expect(result).not.toContain("nodesc): ");
  });

  it("page with body HTML — strips tags and truncates", async () => {
    const admin = mockAdmin(
      {
        name: "Shop",
        description: null,
        primaryDomain: { url: "https://shop.myshopify.com" },
      },
      [],
      [
        {
          title: "Contact",
          handle: "contact",
          isPublished: true,
          body: "<h2>Get in touch</h2><p>Email us &amp; we will reply.</p>",
        },
      ],
    );

    const result = await generateLlmsTxt(admin);

    expect(result).toContain("## Pages");
    expect(result).toContain("[Contact](https://shop.myshopify.com/pages/contact)");
    expect(result).toContain("Get in touchEmail us & we will reply.");
    expect(result).not.toContain("<h2>");
    expect(result).not.toContain("&amp;");
  });
});

const SHOP = {
  name: "Shop",
  description: null,
  primaryDomain: { url: "https://shop.myshopify.com" },
};

describe("generateLlmsTxt published filter", () => {
  it("lists only products with an onlineStoreUrl and pages that are published", async () => {
    const admin = mockAdmin(
      SHOP,
      [
        {
          title: "Live",
          handle: "live",
          onlineStoreUrl: "https://x/products/live",
          descriptionHtml: "",
        },
        { title: "Hidden", handle: "hidden", onlineStoreUrl: null, descriptionHtml: "" },
        { title: "Missing", handle: "missing", descriptionHtml: "" },
      ],
      [
        { title: "Public Page", handle: "public", isPublished: true, body: "" },
        { title: "Hidden Page", handle: "secret", isPublished: false, body: "" },
        { title: "Unknown Page", handle: "unknown", body: "" },
      ],
    );

    const result = await generateLlmsTxt(admin);

    expect(result).toContain("[Live](https://shop.myshopify.com/products/live)");
    expect(result).toContain("[Public Page](https://shop.myshopify.com/pages/public)");
    expect(result).not.toContain("hidden");
    expect(result).not.toContain("missing");
    expect(result).not.toContain("secret");
    expect(result).not.toContain("unknown");
  });

  it("asks Shopify for published content and the published fields", async () => {
    const queries: string[] = [];
    const admin = {
      graphql: async (query: string) => {
        queries.push(query);
        return mockAdmin(SHOP, [], []).graphql(query);
      },
    };

    await generateLlmsTxt(admin);

    const products = queries.find((q) => q.includes("Products")) ?? "";
    const pages = queries.find((q) => q.includes("Pages")) ?? "";
    expect(products).toContain("status:active AND published_status:published");
    expect(products).toContain("onlineStoreUrl");
    expect(pages).toContain("published_status:published");
    expect(pages).toContain("isPublished");
  });
});

describe("generateLlmsTxt pagination", () => {
  function pagedAdmin(totalProducts: number) {
    const calls: { root: string; after: unknown }[] = [];
    const admin = {
      graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
        if (query.includes("ShopInfo")) return Response.json({ data: { shop: SHOP } });
        const root = query.includes("Products") ? "products" : "pages";
        const after = options?.variables?.after ?? null;
        calls.push({ root, after });
        if (root === "pages") {
          return Response.json({
            data: { pages: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          });
        }
        const start = after ? Number(String(after).replace("c", "")) : 0;
        const end = Math.min(start + 250, totalProducts);
        const edges = Array.from({ length: end - start }, (_, i) => ({
          node: {
            title: `P${start + i}`,
            handle: `p${start + i}`,
            onlineStoreUrl: "https://x",
            descriptionHtml: "",
          },
        }));
        return Response.json({
          data: {
            products: {
              edges,
              pageInfo: { hasNextPage: end < totalProducts, endCursor: `c${end}` },
            },
          },
        });
      },
    };
    return { admin, calls };
  }

  it("forwards the end cursor across pages", async () => {
    const { admin, calls } = pagedAdmin(600);
    const result = await generateLlmsTxt(admin);
    const productCalls = calls.filter((c) => c.root === "products");
    expect(productCalls.map((c) => c.after)).toEqual([null, "c250", "c500"]);
    expect(result).toContain("[P0]");
    expect(result).toContain("[P599]");
  });

  it("stops at 2,000 items", async () => {
    const { admin, calls } = pagedAdmin(5000);
    const result = await generateLlmsTxt(admin);
    expect(calls.filter((c) => c.root === "products")).toHaveLength(8);
    expect(result).toContain("[P1999]");
    expect(result).not.toContain("[P2000]");
  });
});

describe("generateLlmsTxt errors", () => {
  it("rejects when graphql() rejects", async () => {
    const admin = {
      graphql: async () => {
        throw new Error("throttled");
      },
    };
    await expect(generateLlmsTxt(admin)).rejects.toThrow("throttled");
  });

  it("rejects when a response carries errors", async () => {
    const admin = {
      graphql: async () =>
        Response.json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
    };
    await expect(generateLlmsTxt(admin)).rejects.toThrow(/Throttled/);
  });

  it("rejects when errors accompany partial data", async () => {
    const base = mockAdmin(SHOP, [], []);
    const admin = {
      graphql: async (query: string) => {
        if (query.includes("Pages")) {
          return Response.json({ data: { pages: null }, errors: [{ message: "Access denied" }] });
        }
        return base.graphql(query);
      },
    };
    await expect(generateLlmsTxt(admin)).rejects.toThrow(/Access denied/);
  });

  it("rejects with a clear message when data is missing", async () => {
    const admin = { graphql: async () => Response.json({}) };
    await expect(generateLlmsTxt(admin)).rejects.toThrow(/Shopify Admin API/);
  });

  it("rejects when the connection is missing", async () => {
    const admin = {
      graphql: async (query: string) =>
        query.includes("ShopInfo")
          ? Response.json({ data: { shop: SHOP } })
          : Response.json({ data: {} }),
    };
    await expect(generateLlmsTxt(admin)).rejects.toThrow(/Shopify Admin API/);
  });
});
