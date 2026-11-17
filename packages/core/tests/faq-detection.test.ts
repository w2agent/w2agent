import { describe, expect, it } from "vitest";
import type { FetchedPage } from "../src/audit/types.js";
import { generateFaq } from "../src/generate/faq.js";
import { detectTools } from "../src/generate/mcp-server.js";
import { generateSchemaOrg } from "../src/generate/schema-org.js";
import type { GenerateContext } from "../src/generate/types.js";

const BASE = "https://example.com";

function ctxFor(html: string): GenerateContext {
  const rawPages: FetchedPage[] = [
    { url: `${BASE}/p`, status: 200, html, headers: {}, responseTime: 1 },
  ];
  return { pages: [], rawPages, metadata: { baseUrl: BASE, wellKnown: {} }, baseUrl: BASE };
}

const page = (body: string, head = "") => `<html><head>${head}</head><body>${body}</body></html>`;
const ld = (json: unknown) => `<script type="application/ld+json">${JSON.stringify(json)}</script>`;

function faq(html: string) {
  const out = generateFaq(ctxFor(html));
  return out?.mainEntity.map((e) => ({ q: e.name, a: e.acceptedAnswer.text })) ?? null;
}

const question = (name: unknown, text: unknown = "An answer that is long enough to keep.") => ({
  "@type": "Question",
  name,
  acceptedAnswer: { "@type": "Answer", text },
});

describe("FAQ JSON-LD detection (GEN2-4)", () => {
  const faqNode = {
    "@type": "FAQPage",
    mainEntity: [question("How do refunds work here?")],
  };
  const expected = [
    { q: "How do refunds work here?", a: "An answer that is long enough to keep." },
  ];

  it("finds a FAQPage inside @graph on a page with no FAQ wording", () => {
    const html = page("<h1>Help</h1>", ld({ "@graph": [{ "@type": "WebSite" }, faqNode] }));
    expect(faq(html)).toEqual(expected);
  });

  it("finds a FAQPage inside nested @graph", () => {
    const html = page("<h1>FAQ</h1>", ld({ "@graph": [{ "@graph": [faqNode] }] }));
    expect(faq(html)).toEqual(expected);
  });

  it("accepts an array @type", () => {
    const html = page("<h1>Help</h1>", ld({ ...faqNode, "@type": ["WebPage", "FAQPage"] }));
    expect(faq(html)).toEqual(expected);
  });

  it("accepts a script whose top level is an array", () => {
    const html = page("<h1>Help</h1>", ld([{ "@type": "Organization" }, faqNode]));
    expect(faq(html)).toEqual(expected);
  });

  it("accepts a single-object mainEntity and array Question @type", () => {
    const q = { ...question("How do refunds work here?"), "@type": ["Question"] };
    const html = page("<h1>Help</h1>", ld({ "@type": "FAQPage", mainEntity: q }));
    expect(faq(html)).toEqual(expected);
  });

  it("uses the first acceptedAnswer with text when it is an array", () => {
    const q = {
      "@type": "Question",
      name: "How do refunds work here?",
      acceptedAnswer: [
        { "@type": "Answer" },
        { "@type": "Answer", text: 5 },
        { "@type": "Answer", text: "An answer that is long enough to keep." },
        { "@type": "Answer", text: "A later answer that is ignored entirely." },
      ],
    };
    const html = page("<h1>Help</h1>", ld({ "@type": "FAQPage", mainEntity: [q] }));
    expect(faq(html)).toEqual(expected);
  });

  it("ignores a non-string name without throwing", () => {
    const html = page(
      "<h1>Help</h1>",
      ld({
        "@type": "FAQPage",
        mainEntity: [question(12345), question("How do refunds work here?")],
      }),
    );
    expect(faq(html)).toEqual(expected);
  });

  it("ignores a non-string answer text without throwing", () => {
    const html = page(
      "<h1>Help</h1>",
      ld({ "@type": "FAQPage", mainEntity: [question("How do refunds work here?", { x: 1 })] }),
    );
    expect(faq(html)).toBeNull();
  });
});

describe("FAQ heuristic detection (GEN2-4)", () => {
  it("decodes entities in <details> and strips the summary", () => {
    const html = page(
      `<details><summary><strong>What is R&amp;D's refund policy?</strong></summary><p>30&nbsp;days &amp; no questions asked, &lt;b&gt;really&lt;/b&gt;.</p></details>
       <details><summary>How long does shipping take?</summary><p>Between three and five working days.</p></details>`,
    );
    expect(faq(html)).toEqual([
      {
        q: "What is R&D's refund policy?",
        a: "30 days & no questions asked, <b>really</b>.",
      },
      { q: "How long does shipping take?", a: "Between three and five working days." },
    ]);
  });

  it("does not treat a blog post with one question heading as a FAQ", () => {
    const html = page(
      "<p>Really? Yes. Why? Because. Sure? Yes.</p><h2>Why did we rewrite everything?</h2><p>Because the old stack was painful to maintain for years.</p>",
    );
    expect(faq(html)).toBeNull();
  });

  it("keeps a FAQ with two question headings", () => {
    const html = page(
      "<h1>Frequently asked questions</h1><h2>Why did we rewrite everything?</h2><p>Because the old stack was painful to maintain.</p><h2>Is there a free tier?</h2><p>Yes, the free tier covers small projects.</p>",
    );
    expect(faq(html)?.map((e) => e.q)).toEqual([
      "Why did we rewrite everything?",
      "Is there a free tier?",
    ]);
  });

  it("does not treat a pricing <dl> without questions as a FAQ", () => {
    const html = page(
      "<dl><dt>Starter plan</dt><dd>Everything a small team needs to get going.</dd><dt>Pro plan features</dt><dd>Everything in Starter plus priority support.</dd></dl>",
    );
    expect(faq(html)).toBeNull();
  });

  it("keeps a <dl> whose terms are questions", () => {
    const html = page(
      "<dl><dt>Can I cancel at any time?</dt><dd>Yes, cancel from the billing page whenever you like.</dd><dt>Starter plan</dt><dd>Everything a small team needs.</dd></dl>",
    );
    expect(faq(html)).toEqual([
      {
        q: "Can I cancel at any time?",
        a: "Yes, cancel from the billing page whenever you like.",
      },
    ]);
  });
});

describe("FAQ in schema-org output (GEN2-4)", () => {
  const heuristicFaq = page(
    "<h1>Frequently asked questions</h1><details><summary>How long does shipping take?</summary><p>Between three and five working days.</p></details>",
  );

  it("still emits FAQPage for a heuristic FAQ page without JSON-LD", () => {
    const entries = generateSchemaOrg(ctxFor(heuristicFaq));
    const entry = entries?.find((e) => e.url === `${BASE}/p`);
    expect(entry?.jsonLd["@type"]).toBe("FAQPage");
    expect(entry?.jsonLd.mainEntity).toHaveLength(1);
  });

  it("skips a page that already carries JSON-LD", () => {
    const html = page(
      "<h1>Help</h1>",
      ld({ "@type": "FAQPage", mainEntity: [question("How do refunds work here?")] }),
    );
    const entries = generateSchemaOrg(ctxFor(html));
    expect(entries?.find((e) => e.url === `${BASE}/p`)).toBeUndefined();
  });

  it("keeps a decoded </script> as data inside valid JSON output", () => {
    const html = page(
      `<h1>Frequently asked questions</h1><details><summary>What about scripts in answers?</summary><p>Here: &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; done.</p></details>`,
    );
    const entry = generateSchemaOrg(ctxFor(html))?.find((e) => e.url === `${BASE}/p`);
    const serialized = JSON.stringify(entry?.jsonLd);
    expect(JSON.parse(serialized).mainEntity[0].acceptedAnswer.text).toContain(
      "</script><script>alert(1)</script>",
    );
  });
});

describe("FAQ JSON-LD walk is bounded (gate fix round 1)", () => {
  const faqNode = { "@type": "FAQPage", mainEntity: [question("How do refunds work here?")] };
  const rawLd = (json: string) => `<script type="application/ld+json">${json}</script>`;
  const deepGraph = `${'{"@graph":'.repeat(10000)}{}${"}".repeat(10000)}`;

  it("does not throw on a hostile deeply nested @graph", () => {
    const html = page("<h1>Help</h1>", rawLd(deepGraph));
    expect(() => generateFaq(ctxFor(html))).not.toThrow();
    expect(faq(html)).toBeNull();
    expect(() => detectTools(ctxFor(html))).not.toThrow();
    expect(() => generateSchemaOrg(ctxFor(html))).not.toThrow();
  });

  it("still finds a FAQPage three @graph levels deep", () => {
    const html = page("<h1>Help</h1>", ld({ "@graph": [{ "@graph": [{ "@graph": [faqNode] }] }] }));
    expect(faq(html)).toEqual([
      { q: "How do refunds work here?", a: "An answer that is long enough to keep." },
    ]);
  });
  it("ignores a FAQPage nested beyond the depth cap", () => {
    const deepFaq = `${'{"@graph":'.repeat(40)}${JSON.stringify(faqNode)}${"}".repeat(40)}`;
    expect(faq(page("<h1>Help</h1>", rawLd(deepFaq)))).toBeNull();
  });

  it("ignores a FAQPage after the node cap", () => {
    const wide = `{"@graph":[${"{},".repeat(10001)}${JSON.stringify(faqNode)}]}`;
    expect(faq(page("<h1>Help</h1>", rawLd(wide)))).toBeNull();
  });
});
