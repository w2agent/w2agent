import { describe, expect, it } from "vitest";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";
import { localBusinessDetector } from "../../src/site-types/local-business.js";
import { detectSiteType } from "../../src/site-types/registry.js";

// Ensure all detectors are registered
import "../../src/site-types/index.js";

function makePage(html: string, url = "https://example.com"): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

// ─── Individual signals ────────────────────────────────────────────────────

describe("LocalBusiness JSON-LD schema (0.8)", () => {
  it("detects LocalBusiness @type directly", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Joe's Diner"}</script>
    </head><body></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.siteType).toBe("local-business");
    expect(result?.signals).toContain("LocalBusiness JSON-LD schema");
    expect(result?.confidence).toBeCloseTo(0.8, 5);
  });

  it("detects Restaurant subtype", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Restaurant","name":"Bella Italia"}</script>
    </head><body></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("LocalBusiness JSON-LD schema");
  });

  it("detects Dentist subtype", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"Downtown Dental"}</script>
    </head><body></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("LocalBusiness JSON-LD schema");
  });

  it("detects via array @type containing LocalBusiness", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":["LocalBusiness","Restaurant"],"name":"Cafe"}</script>
    </head><body></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("LocalBusiness JSON-LD schema");
  });

  it("detects via @graph-wrapped JSON-LD (WordPress/Yoast pattern)", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Acme"},{"@type":"LocalBusiness","name":"Acme Shop"}]}</script>
    </head><body></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("LocalBusiness JSON-LD schema");
  });

  it("does NOT detect Product schema", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>
    </head><body></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).toBeNull();
  });
});

describe("Booking platform embeds (0.6)", () => {
  it("detects Calendly embed", () => {
    const html = `<html><body><script src="https://calendly.com/assets/external/widget.js"></script></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Booking platform embed");
    expect(result?.confidence).toBeCloseTo(0.6, 5);
  });

  it("detects OpenTable embed", () => {
    const html2 = `<html><body><div id="openTable-widget"></div></body></html>`;
    const result = localBusinessDetector.detect([makePage(html2)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Booking platform embed");
  });

  it("detects Acuity Scheduling embed", () => {
    const html = `<html><body><iframe src="https://app.acuityscheduling.com/schedule.php"></iframe></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Booking platform embed");
  });
});

describe("NAP microdata (0.6)", () => {
  it("detects streetAddress itemprop", () => {
    const html = `<html><body><span itemprop="streetAddress">123 Main St</span></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("NAP microdata");
    expect(result?.confidence).toBeCloseTo(0.6, 5);
  });

  it("detects telephone itemprop", () => {
    const html = `<html><body><span itemprop="telephone">(555) 123-4567</span></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("NAP microdata");
  });
});

describe("Map embed (0.5)", () => {
  it("detects Google Maps iframe embed", () => {
    const html = `<html><body><iframe src="https://www.google.com/maps/embed?pb=..."></iframe></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Map embed");
    expect(result?.confidence).toBeCloseTo(0.5, 5);
  });

  it("detects maps.google.com/maps? variant", () => {
    const html = `<html><body><iframe src="https://maps.google.com/maps?q=pizza+near+me"></iframe></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Map embed");
  });
});

describe("Business hours (0.5)", () => {
  it("detects openingHours itemprop", () => {
    const html = `<html><body><span itemprop="openingHours" content="Mo-Fr 09:00-17:00">Mon-Fri 9am-5pm</span></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Business hours");
    expect(result?.confidence).toBeCloseTo(0.5, 5);
  });

  it("detects day-of-week + time pattern in text", () => {
    const html = `<html><body><p>Hours: Mon 9:00am - Fri 6:00pm, Sat 10:00am-4:00pm</p></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Business hours");
  });
});

// ─── Signals below threshold ───────────────────────────────────────────────

describe("Signals below threshold (no detection)", () => {
  it("does not detect on menu URL alone (0.4 weight)", () => {
    const html = `<html><body><a href="/menu">Our Menu</a></body></html>`;
    const result = localBusinessDetector.detect(
      [makePage(html, "https://example.com/menu")],
      baseMeta,
    );
    expect(result).toBeNull();
  });

  it("does not detect on phone tel: link alone (0.3 weight)", () => {
    const html = `<html><body><a href="tel:+15551234567">Call us</a></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).toBeNull();
  });

  it("returns null for empty pages array", () => {
    const result = localBusinessDetector.detect([], baseMeta);
    expect(result).toBeNull();
  });

  it("returns null for plain blog page", () => {
    const html = `<html><head><title>My Blog</title></head><body><h1>Hello</h1><p>Tech tips.</p></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).toBeNull();
  });
});

// ─── Combinations ──────────────────────────────────────────────────────────

describe("Signal combinations", () => {
  it("menu URL (0.4) + phone (0.3) combines to exceed threshold", () => {
    // 1 - (1-0.4)(1-0.3) = 1 - 0.6*0.7 = 1 - 0.42 = 0.58
    const html = `<html><body>
      <a href="/menu">Menu</a>
      <a href="tel:+15551234567">Call us</a>
    </body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toContain("Menu/services URL paths");
    expect(result?.signals).toContain("Phone tel: links");
    expect(result?.confidence).toBeCloseTo(0.58, 2);
  });

  it("multiple strong signals produce high confidence", () => {
    // LocalBusiness JSON-LD (0.8) + NAP microdata (0.6)
    // 1 - (1-0.8)(1-0.6) = 1 - 0.2*0.4 = 1 - 0.08 = 0.92
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Acme"}</script>
    </head><body>
      <span itemprop="streetAddress">123 Main St</span>
    </body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBeCloseTo(0.92, 2);
    expect(result?.signals).toHaveLength(2);
  });
});

// ─── Deduplication ─────────────────────────────────────────────────────────

describe("Signal deduplication across pages", () => {
  it("deduplicates the same signal seen on multiple pages", () => {
    const html = `<html><body><span itemprop="telephone">555-1234</span></body></html>`;
    const pages = [
      makePage(html, "https://example.com/"),
      makePage(html, "https://example.com/contact"),
    ];
    const result = localBusinessDetector.detect(pages, baseMeta);
    expect(result).not.toBeNull();
    const napSignals = result?.signals.filter((s) => s === "NAP microdata");
    expect(napSignals).toHaveLength(1);
    // confidence unchanged by dedup — still from single 0.6 signal
    expect(result?.confidence).toBeCloseTo(0.6, 5);
  });
});

// ─── Registry integration ──────────────────────────────────────────────────

describe("detectSiteType registry integration", () => {
  it("returns local-business via registry for local business site", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Downtown Cafe"}</script>
    </head><body></body></html>`;
    const result = detectSiteType([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.siteType).toBe("local-business");
  });

  it("returns null via registry for non-local-business site", () => {
    const html = `<html><body><p>Corporate homepage. No location info.</p></body></html>`;
    const result = detectSiteType([makePage(html)], baseMeta);
    expect(result).toBeNull();
  });

  it("prefers ecommerce over local-business when ecommerce has higher confidence (Shopify restaurant)", () => {
    // Shopify (0.9) beats LocalBusiness JSON-LD (0.8) — registry returns highest confidence
    const html = `<html><head>
      <script src="https://cdn.shopify.com/s/files/1/0001/theme.js"></script>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Restaurant","name":"Shopify Cafe"}</script>
    </head><body></body></html>`;
    const result = detectSiteType([makePage(html)], baseMeta);
    // Ecommerce confidence (Shopify alone = 0.9) > local-business (0.8)
    expect(result?.siteType).toBe("ecommerce");
  });
});

// ─── Signal list accuracy ──────────────────────────────────────────────────

describe("Signal list accuracy", () => {
  it("returns only matched signals in result (no false positives in list)", () => {
    const html = `<html><body><span itemprop="telephone">555-9876</span></body></html>`;
    const result = localBusinessDetector.detect([makePage(html)], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.signals).toEqual(["NAP microdata"]);
  });
});

describe("booking markers need markup, not prose", () => {
  const prose =
    "Booking widgets: calendly.com, resy.com, opentable, openTable, acuityscheduling.com, booksy.com, vagaro.com, mindbodyonline.com. Map: google.com/maps/embed.";

  it("returns null for a docs page naming booking hosts in prose and an RSC payload", () => {
    const html = `<html><body><p>${prose}</p><script>self.__next_f.push([1,"${prose}"])</script></body></html>`;
    expect(localBusinessDetector.detect([makePage(html)], baseMeta)).toBeNull();
  });

  it("detects a restaurant with a Resy booking link", () => {
    const html = `<html><body><a href="https://resy.com/cities/ny/venue">Reserve</a></body></html>`;
    expect(localBusinessDetector.detect([makePage(html)], baseMeta)?.signals).toContain(
      "Booking platform embed",
    );
  });

  it("detects an OpenTable iframe", () => {
    const html = `<html><body><iframe src="https://www.opentable.com/widget/reservation/loader"></iframe></body></html>`;
    expect(localBusinessDetector.detect([makePage(html)], baseMeta)?.signals).toContain(
      "Booking platform embed",
    );
  });

  it("does not read business hours from script text", () => {
    const html = `<html><body><script>var h = "Mon 9:00 Tue 10:00";</script></body></html>`;
    expect(localBusinessDetector.detect([makePage(html)], baseMeta)).toBeNull();
  });

  it("does not treat a plain link to an opentable.com restaurant page as an embed", () => {
    const html = `<html><body><a href="https://www.opentable.com/r/some-restaurant">Review</a></body></html>`;
    expect(localBusinessDetector.detect([makePage(html)], baseMeta)).toBeNull();
  });

  it("detects an OpenTable script widget", () => {
    const html = `<html><body><script src="https://www.opentable.com/widget/reservation/loader?rid=1"></script></body></html>`;
    expect(localBusinessDetector.detect([makePage(html)], baseMeta)?.signals).toContain(
      "Booking platform embed",
    );
  });
});
