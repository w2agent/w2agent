import { describe, expect, it } from "vitest";
import type { FetchedPage } from "../src/audit/types.js";
import {
  buildLocalBusinessArtifacts,
  extractLocalBusiness,
  extractLocalBusinessFromJsonLd,
  generateBusinessInfoTable,
  generateLocalBusinessToolHandlers,
} from "../src/generate/local-business.js";
import { generateSchemaOrg } from "../src/generate/schema-org.js";
import type { GenerateContext } from "../src/generate/types.js";

function makePage(html: string, url = "https://joesdiner.com"): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}

function makeContext(
  pages: FetchedPage[],
  siteType?: { siteType: string; confidence: number; signals: string[] },
): GenerateContext {
  return {
    pages: [],
    rawPages: pages,
    metadata: { baseUrl: "https://joesdiner.com", wellKnown: {} },
    baseUrl: "https://joesdiner.com",
    siteType,
  };
}

const LOCAL_BUSINESS_SITE_TYPE = {
  siteType: "local-business",
  confidence: 0.9,
  signals: ["LocalBusiness JSON-LD"],
};

const RESTAURANT_JSONLD_HTML = `<html><head>
  <script type="application/ld+json">{
    "@context": "https://schema.org",
    "@type": "Restaurant",
    "name": "Joe's Diner",
    "telephone": "+1-555-123-4567",
    "email": "joe@joesdiner.com",
    "url": "https://joesdiner.com",
    "priceRange": "$$",
    "image": "https://joesdiner.com/img/diner.jpg",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "123 Main St",
      "addressLocality": "Springfield",
      "addressRegion": "IL",
      "postalCode": "62701",
      "addressCountry": "US"
    },
    "openingHoursSpecification": [
      {
        "@type": "OpeningHoursSpecification",
        "dayOfWeek": ["https://schema.org/Monday", "https://schema.org/Tuesday"],
        "opens": "09:00",
        "closes": "17:00"
      }
    ],
    "hasMenu": "https://joesdiner.com/menu",
    "geo": { "@type": "GeoCoordinates", "latitude": "39.7817", "longitude": "-89.6501" },
    "reservationUrl": "https://opentable.com/joes-diner"
  }</script>
</head><body></body></html>`;

const _GRAPH_JSONLD_HTML = `<html><head>
  <script type="application/ld+json">{
    "@graph": [
      { "@type": "WebSite", "name": "Joe's Diner Website" },
      { "@type": "Restaurant", "name": "Graph Diner", "telephone": "+1-555-999-0000", "url": "https://joesdiner.com" }
    ]
  }</script>
</head><body></body></html>`;

const MICRODATA_HTML = `<html><body>
  <div itemscope itemtype="https://schema.org/LocalBusiness">
    <span itemprop="name">Micro Cafe</span>
    <span itemprop="telephone">+1-555-888-2222</span>
    <span itemprop="streetAddress">456 Oak Ave</span>
    <span itemprop="addressLocality">Portland</span>
    <span itemprop="addressRegion">OR</span>
    <span itemprop="postalCode">97201</span>
  </div>
</body></html>`;

const HTML_FALLBACK_HTML = `<html><body>
  <a href="tel:+1-555-777-8888">Call us</a>
  <a href="https://calendly.com/joesdiner/appointment">Book appointment</a>
</body></html>`;

// Restaurant JSON-LD without a booking URL (for merge test)
const RESTAURANT_NO_BOOKING_HTML = `<html><head>
  <script type="application/ld+json">{
    "@context": "https://schema.org",
    "@type": "Restaurant",
    "name": "Joe's Diner",
    "url": "https://joesdiner.com"
  }</script>
</head><body></body></html>`;

describe("extractLocalBusinessFromJsonLd", () => {
  it("extracts all fields from full Restaurant JSON-LD", () => {
    const jsonLd = [
      {
        "@context": "https://schema.org",
        "@type": "Restaurant",
        name: "Joe's Diner",
        telephone: "+1-555-123-4567",
        email: "joe@joesdiner.com",
        url: "https://joesdiner.com",
        priceRange: "$$",
        image: "https://joesdiner.com/img/diner.jpg",
        address: {
          "@type": "PostalAddress",
          streetAddress: "123 Main St",
          addressLocality: "Springfield",
          addressRegion: "IL",
          postalCode: "62701",
          addressCountry: "US",
        },
        openingHoursSpecification: [
          {
            "@type": "OpeningHoursSpecification",
            dayOfWeek: ["https://schema.org/Monday", "https://schema.org/Tuesday"],
            opens: "09:00",
            closes: "17:00",
          },
        ],
        hasMenu: "https://joesdiner.com/menu",
        geo: { "@type": "GeoCoordinates", latitude: "39.7817", longitude: "-89.6501" },
        reservationUrl: "https://opentable.com/joes-diner",
      },
    ];
    const result = extractLocalBusinessFromJsonLd(jsonLd, "https://joesdiner.com");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Joe's Diner");
    expect(result?.type).toBe("Restaurant");
    expect(result?.phone).toBe("+1-555-123-4567");
    expect(result?.email).toBe("joe@joesdiner.com");
    expect(result?.address?.city).toBe("Springfield");
    expect(result?.hours).toHaveLength(1);
    expect(result?.hours?.[0].days).toContain("Monday");
    expect(result?.hours?.[0].days).toContain("Tuesday");
    expect(result?.menu).toBe("https://joesdiner.com/menu");
    expect(result?.bookingUrl).toBe("https://opentable.com/joes-diner");
    expect(result?.geo?.lat).toBeCloseTo(39.7817);
    expect(result?.priceRange).toBe("$$");
    expect(result?.source).toBe("json-ld");
  });

  it("extracts business from @graph wrapped JSON-LD", () => {
    const jsonLd = [
      {
        "@graph": [
          { "@type": "WebSite", name: "Website" },
          {
            "@type": "Restaurant",
            name: "Graph Diner",
            telephone: "+1-555-999-0000",
            url: "https://joesdiner.com",
          },
        ],
      },
    ];
    const result = extractLocalBusinessFromJsonLd(jsonLd, "https://joesdiner.com");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Graph Diner");
    expect(result?.type).toBe("Restaurant");
  });

  it("accepts a single openingHoursSpecification object", () => {
    const result = extractLocalBusinessFromJsonLd(
      [
        {
          "@type": "Restaurant",
          name: "Solo Hours Diner",
          openingHoursSpecification: {
            "@type": "OpeningHoursSpecification",
            dayOfWeek: "https://schema.org/Monday",
            opens: "09:00",
            closes: "17:00",
          },
        },
      ],
      "https://joesdiner.com",
    );
    expect(result?.hours).toEqual([{ days: ["Monday"], opens: "09:00", closes: "17:00" }]);
  });

  it("returns null when no LocalBusiness type in JSON-LD", () => {
    const result = extractLocalBusinessFromJsonLd(
      [{ "@type": "WebPage", name: "Home" }],
      "https://joesdiner.com",
    );
    expect(result).toBeNull();
  });

  it("returns null when matched type but no name", () => {
    const result = extractLocalBusinessFromJsonLd(
      [{ "@type": "Restaurant" }],
      "https://joesdiner.com",
    );
    expect(result).toBeNull();
  });
});

describe("extractLocalBusiness via microdata", () => {
  it("extracts name, phone, address from microdata", () => {
    const ctx = makeContext([makePage(MICRODATA_HTML)]);
    const result = extractLocalBusiness(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Micro Cafe");
    expect(result?.phone).toBe("+1-555-888-2222");
    expect(result?.address?.city).toBe("Portland");
    expect(result?.source).toBe("microdata");
  });

  it("returns null when HTML has no microdata or JSON-LD", () => {
    const ctx = makeContext([makePage("<html><body>plain text</body></html>")]);
    const result = extractLocalBusiness(ctx);
    expect(result).toBeNull();
  });
});

describe("extractLocalBusiness via HTML fallback", () => {
  it("merges data from multiple pages — name from JSON-LD, bookingUrl from HTML", () => {
    const page1 = makePage(RESTAURANT_NO_BOOKING_HTML, "https://joesdiner.com");
    const page2 = makePage(HTML_FALLBACK_HTML, "https://joesdiner.com/contact");
    const ctx = makeContext([page1, page2]);
    const result = extractLocalBusiness(ctx);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Joe's Diner");
    expect(result?.bookingUrl).toBe("https://calendly.com/joesdiner/appointment");
  });
});

describe("buildLocalBusinessArtifacts", () => {
  it("returns null when siteType is undefined", () => {
    const ctx = makeContext([makePage(RESTAURANT_JSONLD_HTML)]);
    expect(buildLocalBusinessArtifacts(ctx)).toBeNull();
  });

  it("returns null when siteType is not local-business", () => {
    const ctx = makeContext([makePage(RESTAURANT_JSONLD_HTML)], {
      siteType: "ecommerce",
      confidence: 0.9,
      signals: [],
    });
    expect(buildLocalBusinessArtifacts(ctx)).toBeNull();
  });

  it("returns null when siteType is local-business but no business data found", () => {
    const ctx = makeContext(
      [makePage("<html><body>no business data</body></html>")],
      LOCAL_BUSINESS_SITE_TYPE,
    );
    expect(buildLocalBusinessArtifacts(ctx)).toBeNull();
  });

  it("returns artifacts when local-business site has JSON-LD", () => {
    const ctx = makeContext([makePage(RESTAURANT_JSONLD_HTML)], LOCAL_BUSINESS_SITE_TYPE);
    const result = buildLocalBusinessArtifacts(ctx);
    expect(result).not.toBeNull();
    expect(result?.business.name).toBe("Joe's Diner");
  });
});

describe("generateBusinessInfoTable", () => {
  it("generates markdown table with header comment and all available fields", () => {
    const business = {
      name: "Joe's Diner",
      type: "Restaurant",
      phone: "+1-555-123-4567",
      address: {
        street: "123 Main St",
        city: "Springfield",
        state: "IL",
        zip: "62701",
        country: "US",
      },
      hours: [{ days: ["Monday", "Tuesday"], opens: "09:00", closes: "17:00" }],
      menu: "https://joesdiner.com/menu",
      bookingUrl: "https://opentable.com/joes-diner",
      priceRange: "$$",
      url: "https://joesdiner.com",
      source: "json-ld" as const,
    };
    const table = generateBusinessInfoTable(business);
    expect(table).toContain("<!-- Generated by w2agent -->");
    expect(table).toContain("| Field | Value |");
    expect(table).toContain("Joe's Diner");
    expect(table).toContain("Restaurant");
    expect(table).toContain("+1-555-123-4567");
    expect(table).toContain("123 Main St");
    expect(table).toContain("Monday/Tuesday 09:00–17:00");
    expect(table).toContain("https://joesdiner.com/menu");
    expect(table).toContain("https://opentable.com");
    expect(table).toContain("$$");
  });

  it("omits rows for missing optional fields", () => {
    const business = {
      name: "Minimal Shop",
      type: "Store",
      url: "https://minimalshop.com",
      source: "json-ld" as const,
    };
    const table = generateBusinessInfoTable(business);
    expect(table).not.toContain("Phone");
    expect(table).not.toContain("Address");
    expect(table).not.toContain("Hours");
    expect(table).not.toContain("Menu");
    expect(table).not.toContain("Booking");
  });
});

describe("generateLocalBusinessToolHandlers", () => {
  it("returns string containing all 4 function names", () => {
    const code = generateLocalBusinessToolHandlers();
    expect(typeof code).toBe("string");
    expect(code).toContain("getHours");
    expect(code).toContain("getMenu");
    expect(code).toContain("getServices");
    expect(code).toContain("bookAppointment");
  });
});

describe("schema-org LocalBusiness generation", () => {
  it("generates LocalBusiness JSON-LD for microdata business (no existing JSON-LD)", () => {
    const ctx = makeContext([makePage(MICRODATA_HTML)]);
    const business = extractLocalBusiness(ctx);
    expect(business).not.toBeNull();
    const entries = generateSchemaOrg(ctx, undefined, business);
    expect(entries).not.toBeNull();
    const businessEntry = entries?.find((e) => {
      const type = e.jsonLd["@type"] as string;
      return (
        type === "LocalBusiness" || type === "Restaurant" || type === "Store" || type === "Dentist"
      );
    });
    expect(businessEntry).toBeDefined();
    expect(businessEntry?.jsonLd.name).toBe("Micro Cafe");
    expect(businessEntry?.jsonLd.speakable).toBeUndefined();
  });

  it("skips LocalBusiness JSON-LD when homepage already has it", () => {
    const ctx = makeContext([makePage(RESTAURANT_JSONLD_HTML)]);
    const business = extractLocalBusiness(ctx);
    const entries = generateSchemaOrg(ctx, undefined, business);
    // Homepage already has Restaurant JSON-LD, so no new entry is generated
    // The page also has existing JSON-LD, so even WebPage schema is skipped
    expect(entries).toBeNull();
  });

  it("works without localBusiness parameter (backward compat)", () => {
    const simpleHtml = "<html><head><title>Hello</title></head><body>World</body></html>";
    const ctx = makeContext([makePage(simpleHtml)]);
    expect(() => generateSchemaOrg(ctx)).not.toThrow();
  });
});

describe("engine wiring — artifacts flow", () => {
  it("buildLocalBusinessArtifacts feeds schema-org and business-info table", () => {
    const ctx = makeContext([makePage(MICRODATA_HTML)], LOCAL_BUSINESS_SITE_TYPE);
    const artifacts = buildLocalBusinessArtifacts(ctx);
    expect(artifacts).not.toBeNull();

    const schemaEntries = generateSchemaOrg(ctx, undefined, artifacts?.business);
    expect(schemaEntries).not.toBeNull();
    const businessEntry = schemaEntries?.find((e) => e.jsonLd["@type"] === "LocalBusiness");
    expect(businessEntry).toBeDefined();

    const table = generateBusinessInfoTable(artifacts?.business);
    expect(table).toContain("Micro Cafe");
  });
});
