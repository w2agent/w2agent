import { describe, expect, it } from "vitest";
import { nextjsWellKnownCheck } from "../src/adapters/nextjs/checks.js";
import { shopifyProductSchemaCheck } from "../src/adapters/shopify/checks.js";
import type { FetchedPage, SiteMetadata } from "../src/audit/types.js";

function meta(wellKnown: Record<string, string>): SiteMetadata {
  return { baseUrl: "https://example.com", wellKnown } as SiteMetadata;
}

describe("nextjs-well-known-served applicability", () => {
  const run = (wellKnown: Record<string, string>) =>
    nextjsWellKnownCheck.run([], meta(wellKnown)) as {
      status: string;
      score: number;
      message: string;
      details?: string;
    };

  it("skips when no agent card was credited", () => {
    const r = run({});
    expect(r.status).toBe("skip");
    expect(r.message).toContain("No A2A agent card is published");
    expect(r.details).toBeUndefined();
  });

  it("does not credit other well-known files as an agent card", () => {
    expect(run({ "ai-plugin.json": '{"schema_version":"v1"}' }).status).toBe("skip");
  });

  it("fails a credited JSON body that is not an agent card", () => {
    const r = run({ "agent-card.json": '{"error":"not found"}' });
    expect(r).toMatchObject({ status: "fail", score: 0 });
    expect(r.details).toContain("must be an A2A agent card");
    expect(run({ "agent-card.json": "<html>" }).status).toBe("fail");
  });

  it("passes a valid agent card", () => {
    expect(run({ "agent-card.json": '{"name":"Support agent"}' })).toMatchObject({
      status: "pass",
      score: 100,
    });
  });
});

describe("shopify-product-schema predicate", () => {
  const product = (html: string, path = "/products/widget"): FetchedPage => ({
    url: `https://shop.example${path}`,
    status: 200,
    html,
    headers: {},
    responseTime: 1,
  });
  const ld = (json: string, type = "application/ld+json") =>
    `<html><head><script type="${type}">${json}</script></head><body></body></html>`;
  const run = (...pages: FetchedPage[]) =>
    shopifyProductSchemaCheck.run(pages, meta({})) as {
      status: string;
      score: number;
      message: string;
    };

  it("passes a ProductGroup with no nested Product", () => {
    expect(run(product(ld('{"@type":"ProductGroup","name":"Tee"}')))).toMatchObject({
      status: "pass",
      score: 100,
    });
  });

  it("passes an array @type, other spacing and @graph", () => {
    expect(run(product(ld('{"@type":["Thing","Product"]}'))).status).toBe("pass");
    expect(run(product(ld('{ "@type" :   "Product" }'))).status).toBe("pass");
    expect(run(product(ld('{"@graph":[{"@type":"WebSite"},{"@type":"Product"}]}'))).status).toBe(
      "pass",
    );
  });

  it("passes microdata and says what it credits", () => {
    const html =
      '<html><body><div itemscope itemtype="https://schema.org/Product"></div></body></html>';
    const r = run(product(html));
    expect(r.status).toBe("pass");
    expect(r.message).toContain("JSON-LD or microdata");
  });

  it("does not count a Product string outside JSON-LD", () => {
    const inScript = product(ld('{"@type":"Product"}', "text/javascript"));
    expect(run(inScript)).toMatchObject({ status: "fail", score: 0 });
    expect(run(inScript).message).toContain("JSON-LD or microdata");
    const inComment = product('<html><!-- {"@type":"Product"} --><body></body></html>');
    expect(run(inComment).status).toBe("fail");
  });

  it("does not count invalid JSON-LD", () => {
    expect(run(product(ld('{"@type":"Product",')))).toMatchObject({ status: "fail", score: 0 });
  });

  it("keeps the ratio thresholds and page selection", () => {
    const good = product(ld('{"@type":"Product"}'));
    const bad = product("<html></html>", "/products/other");
    const notProduct = product("<html></html>", "/pages/about");
    expect(run(good, bad, notProduct)).toMatchObject({ status: "partial", score: 50 });
    expect(run(notProduct).status).toBe("skip");
  });
});
