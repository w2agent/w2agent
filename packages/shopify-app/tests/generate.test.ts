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
          descriptionHtml: "<p>A great widget</p>",
        },
        {
          title: "Gadget",
          handle: "gadget",
          descriptionHtml: "<p>An amazing gadget</p>",
        },
      ],
      [{ title: "About Us", handle: "about", body: "We are Acme." }],
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
      [{ title: "Long Product", handle: "long", descriptionHtml: longDesc }],
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
      [{ title: "No Desc Product", handle: "nodesc", descriptionHtml: "" }],
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
