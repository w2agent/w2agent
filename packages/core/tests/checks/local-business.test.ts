import { describe, expect, it } from "vitest";
import {
  localBusinessBookingAccessible,
  localBusinessHoursJsonLd,
  localBusinessNapStructured,
} from "../../src/audit/checks/local-business.js";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";

const baseMeta: SiteMetadata = {
  baseUrl: "https://mybusiness.example.com",
  wellKnown: {},
};

function makePage(html: string, url = "https://mybusiness.example.com/"): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}

function makeLocalBusinessHtml(opts: {
  hasAddress?: boolean;
  hasPhone?: boolean;
  hasHours?: boolean;
  hasBookingLink?: boolean;
  hasBookingIframe?: boolean;
  useMicrodata?: boolean;
} = {}): string {
  const { hasAddress = false, hasPhone = false, hasHours = false, hasBookingLink = false, hasBookingIframe = false, useMicrodata = false } = opts;

  if (useMicrodata) {
    const addressHtml = hasAddress
      ? `<span itemprop="streetAddress">123 Main St</span>
         <span itemprop="addressLocality">Springfield</span>`
      : "";
    const phoneHtml = hasPhone
      ? `<span itemprop="telephone">555-0100</span>`
      : "";
    return `<html><body>
      <div itemscope itemtype="https://schema.org/LocalBusiness">
        <span itemprop="name">Test Business</span>
        ${addressHtml}
        ${phoneHtml}
      </div>
    </body></html>`;
  }

  const addressJson = hasAddress
    ? `"address": { "@type": "PostalAddress", "streetAddress": "123 Main St", "addressLocality": "Springfield", "addressRegion": "IL", "postalCode": "62701" },`
    : "";
  const phoneJson = hasPhone ? `"telephone": "+1-555-010-0100",` : "";
  const hoursJson = hasHours
    ? `"openingHoursSpecification": [{ "@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday"], "opens": "09:00", "closes": "17:00" }],`
    : "";

  const bookingLink = hasBookingLink
    ? `<a href="/book">Book Now</a>`
    : "";
  const bookingIframe = hasBookingIframe
    ? `<iframe src="https://calendly.com/mybusiness/30min"></iframe>`
    : "";

  return `<html><head>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      "name": "Test Business",
      ${addressJson}
      ${phoneJson}
      ${hoursJson}
      "url": "https://mybusiness.example.com"
    }
    </script>
  </head><body>
    <h1>Test Business</h1>
    ${bookingLink}
    ${bookingIframe}
  </body></html>`;
}

// ─── local-business-nap-structured ──────────────────────────────────────────

describe("local-business-nap-structured", () => {
  it("passes when name + address + phone all present in JSON-LD", () => {
    const html = makeLocalBusinessHtml({ hasAddress: true, hasPhone: true });
    const result = localBusinessNapStructured.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("partial when name + phone but no address (score 67)", () => {
    const html = makeLocalBusinessHtml({ hasPhone: true });
    const result = localBusinessNapStructured.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "partial", score: 67 });
  });

  it("partial when name only, no address or phone (score 33)", () => {
    const html = makeLocalBusinessHtml({});
    const result = localBusinessNapStructured.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "partial", score: 33 });
  });

  it("skips when no LocalBusiness structured data found", () => {
    const html = "<html><body><h1>About Us</h1></body></html>";
    const result = localBusinessNapStructured.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "skip" });
  });

  it("detects microdata as fallback with name + phone (score 67)", () => {
    const html = makeLocalBusinessHtml({ hasPhone: true, useMicrodata: true });
    const result = localBusinessNapStructured.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "partial", score: 67 });
  });

  it("includes fix snippet when not passing", () => {
    const html = makeLocalBusinessHtml({});
    const result = localBusinessNapStructured.run([makePage(html)], baseMeta);
    expect(result.fixSnippet).toContain("LocalBusiness");
    expect(result.fixSnippet).toContain("telephone");
  });

  it("no fix snippet when passing", () => {
    const html = makeLocalBusinessHtml({ hasAddress: true, hasPhone: true });
    const result = localBusinessNapStructured.run([makePage(html)], baseMeta);
    expect(result.fixSnippet).toBeUndefined();
  });

  it("uses best NAP count across multiple pages", () => {
    const incomplete = makeLocalBusinessHtml({});
    const complete = makeLocalBusinessHtml({ hasAddress: true, hasPhone: true });
    const result = localBusinessNapStructured.run(
      [makePage(incomplete), makePage(complete, "https://mybusiness.example.com/about")],
      baseMeta,
    );
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });
});

// ─── local-business-hours-jsonld ─────────────────────────────────────────────

describe("local-business-hours-jsonld", () => {
  it("passes when JSON-LD has valid openingHoursSpecification", () => {
    const html = makeLocalBusinessHtml({ hasHours: true });
    const result = localBusinessHoursJsonLd.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when JSON-LD LocalBusiness found but no hours", () => {
    const html = makeLocalBusinessHtml({});
    const result = localBusinessHoursJsonLd.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });

  it("skips when no JSON-LD LocalBusiness detected", () => {
    const html = "<html><body><h1>No schema</h1></body></html>";
    const result = localBusinessHoursJsonLd.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "skip" });
  });

  it("skips when only microdata found (JSON-LD only check)", () => {
    const html = makeLocalBusinessHtml({ useMicrodata: true });
    const result = localBusinessHoursJsonLd.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "skip" });
  });

  it("includes fix snippet on fail", () => {
    const html = makeLocalBusinessHtml({});
    const result = localBusinessHoursJsonLd.run([makePage(html)], baseMeta);
    expect(result.fixSnippet).toContain("openingHoursSpecification");
  });
});

// ─── local-business-booking-accessible ──────────────────────────────────────

describe("local-business-booking-accessible", () => {
  it("passes when booking path link exists and not blocked by robots.txt", () => {
    const html = makeLocalBusinessHtml({ hasBookingLink: true });
    const result = localBusinessBookingAccessible.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("passes when external booking platform link found", () => {
    const html = `<html><body>
      <a href="https://opentable.com/restaurant/123">Book on OpenTable</a>
    </body></html>`;
    const result = localBusinessBookingAccessible.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("External booking");
  });

  it("passes when booking iframe (Calendly) embedded", () => {
    const html = makeLocalBusinessHtml({ hasBookingIframe: true });
    const result = localBusinessBookingAccessible.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("External booking");
  });

  it("fails when booking path blocked by robots.txt", () => {
    const meta: SiteMetadata = {
      ...baseMeta,
      robotsTxt: "User-agent: *\nDisallow: /book",
    };
    const html = makeLocalBusinessHtml({ hasBookingLink: true });
    const result = localBusinessBookingAccessible.run([makePage(html)], meta);
    expect(result.score).toBeLessThan(100);
    expect(result.message).toContain("blocked by robots.txt");
  });

  it("skips when no booking URLs found", () => {
    const html = "<html><body><a href='/about'>About</a></body></html>";
    const result = localBusinessBookingAccessible.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "skip" });
  });

  it("detects /appointment path", () => {
    const html = `<html><body>
      <a href="/appointment">Book Appointment</a>
    </body></html>`;
    const result = localBusinessBookingAccessible.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass" });
  });

  it("detects /schedule path", () => {
    const html = `<html><body>
      <a href="/schedule/consultation">Schedule</a>
    </body></html>`;
    const result = localBusinessBookingAccessible.run([makePage(html)], baseMeta);
    expect(result).toMatchObject({ status: "pass" });
  });
});
