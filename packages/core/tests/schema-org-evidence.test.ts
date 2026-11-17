import { describe, expect, it } from "vitest";
import type { FetchedPage } from "../src/audit/types.js";
import type { ExtractedLocalBusiness } from "../src/generate/local-business.js";
import { generateSchemaOrg } from "../src/generate/schema-org.js";
import type { GenerateContext } from "../src/generate/types.js";

const BASE = "https://example.com";

function ctxFor(pages: { path: string; html: string }[]): GenerateContext {
  const rawPages: FetchedPage[] = pages.map((p) => ({
    url: `${BASE}${p.path}`,
    status: 200,
    html: p.html,
    headers: {},
    responseTime: 1,
  }));
  return {
    pages: [],
    rawPages,
    metadata: { baseUrl: BASE, wellKnown: {} },
    baseUrl: BASE,
  };
}

const page = (head: string, body: string) =>
  `<html><head>${head}</head><body>${body}</body></html>`;

function jsonLdFor(path: string, html: string): Record<string, unknown> {
  const entries = generateSchemaOrg(ctxFor([{ path, html }]));
  const entry = entries?.find((e) => e.url === `${BASE}${path}`);
  if (!entry) throw new Error("no entry");
  return entry.jsonLd;
}

describe("schema-org evidence rules (GEN-11)", () => {
  it("an author link alone is a WebPage, not an Article", () => {
    const ld = jsonLdFor(
      "/about",
      page("<title>About</title>", '<p>Hi</p><a href="/author/jane">Jane</a>'),
    );
    expect(ld["@type"]).toBe("WebPage");
  });

  it("rel=author alone is a WebPage", () => {
    const ld = jsonLdFor(
      "/about",
      page("<title>About</title>", '<a rel="author" href="/people/jane">Jane</a>'),
    );
    expect(ld["@type"]).toBe("WebPage");
  });

  it("article:published_time makes an Article with datePublished", () => {
    const ld = jsonLdFor(
      "/post",
      page(
        '<title>Post</title><meta property="article:published_time" content="2026-01-02">',
        "<p>Body</p>",
      ),
    );
    expect(ld["@type"]).toBe("Article");
    expect(ld.datePublished).toBe("2026-01-02");
  });

  it("omits an empty description and an empty name instead of emitting an empty string", () => {
    const ld = jsonLdFor("/bare", page("", "<p>Hi</p>"));
    expect("description" in ld).toBe(false);
    expect("name" in ld).toBe(false);
    for (const v of Object.values(ld)) expect(v).not.toBe("");
  });

  it("a page with FAQ entries becomes FAQPage with that page's mainEntity", () => {
    const ld = jsonLdFor(
      "/faq",
      page(
        "<title>FAQ</title>",
        "<details><summary>How do I sign up here?</summary><p>Use the contact form on the contact page to sign up.</p></details>" +
          "<details><summary>Is there a free plan today?</summary><p>Yes, the basic plan is free for everyone forever.</p></details>",
      ),
    );
    expect(ld["@type"]).toBe("FAQPage");
    const main = ld.mainEntity as { name: string; acceptedAnswer: { text: string } }[];
    expect(main.map((q) => q.name)).toEqual([
      "How do I sign up here?",
      "Is there a free plan today?",
    ]);
    expect(main[0].acceptedAnswer.text).toContain("contact form");
  });

  it("FAQ-looking text with no extractable entries is a WebPage, never FAQPage without mainEntity", () => {
    const ld = jsonLdFor(
      "/faq",
      page("<title>FAQ</title>", "<h1>Frequently asked questions</h1><p>Coming soon.</p>"),
    );
    expect(ld["@type"]).toBe("WebPage");
    expect("mainEntity" in ld).toBe(false);
  });

  it("every emitted FAQPage carries a non-empty mainEntity", () => {
    const entries = generateSchemaOrg(
      ctxFor([
        { path: "/a", html: page("", "<h1>Frequently asked</h1><p>none</p>") },
        {
          path: "/b",
          html: page(
            "",
            "<dl><dt>What are your opening hours?</dt><dd>We are open every weekday from nine until five.</dd></dl>",
          ),
        },
      ]),
    );
    for (const e of entries ?? []) {
      if (e.jsonLd["@type"] === "FAQPage") {
        expect((e.jsonLd.mainEntity as unknown[]).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("LocalBusiness evidence rules (GEN-11)", () => {
  const business = (type: string, menu?: string): ExtractedLocalBusiness => ({
    name: "Biz",
    type,
    url: BASE,
    menu,
    source: "json-ld",
  });
  const lbFor = (type: string, menu?: string) => {
    const entries = generateSchemaOrg(
      { ...ctxFor([]), rawPages: [] },
      undefined,
      business(type, menu),
    );
    return entries?.[0].jsonLd as Record<string, unknown>;
  };

  it("never emits speakable", () => {
    expect("speakable" in lbFor("Dentist")).toBe(false);
    expect("speakable" in lbFor("Restaurant")).toBe(false);
  });

  it("hasMenu only for food establishment types", () => {
    const menu = `${BASE}/menu`;
    expect(lbFor("Dentist", menu).hasMenu).toBeUndefined();
    expect(lbFor("LocalBusiness", menu).hasMenu).toBeUndefined();
    for (const t of [
      "Restaurant",
      "CafeOrCoffeeShop",
      "Bakery",
      "BarOrPub",
      "FastFoodRestaurant",
      "IceCreamShop",
      "Brewery",
      "Distillery",
      "Winery",
      "FoodEstablishment",
    ]) {
      expect(lbFor(t, menu).hasMenu).toBe(menu);
    }
  });
});
