import robotsParser from "robots-parser";
import type { ExtractedLocalBusiness } from "../../generate/local-business.js";
import {
  extractLocalBusinessFromJsonLd,
  extractLocalBusinessFromMicrodata,
} from "../../generate/local-business.js";
import { parseHTML } from "../../shared/html-parser.js";
import type { Check } from "../types.js";

const BOOKING_PLATFORMS = [
  "opentable.com",
  "resy.com",
  "calendly.com",
  "acuityscheduling.com",
  "booksy.com",
  "vagaro.com",
  "mindbodyonline.com",
];

const BOOKING_PATH_RE = /\/(book|appointment|reserve|schedule)(\/|$|\?)/i;

function countNapFields(extracted: Partial<ExtractedLocalBusiness>): number {
  let count = 0;
  if (extracted.name) count++;
  if (extracted.address && Object.values(extracted.address).some(Boolean)) count++;
  if (extracted.phone) count++;
  return count;
}

export const localBusinessNapStructured: Check = {
  id: "local-business-nap-structured",
  name: "NAP data is in structured markup",
  category: "structured-data",
  weight: 2,
  severity: "warning",
  run: (pages) => {
    let bestNapCount = 0;
    let foundStructured = false;

    for (const page of pages) {
      const parsed = parseHTML(page.html);

      const jsonLdResult = extractLocalBusinessFromJsonLd(
        parsed.jsonLd,
        page.url,
        parsed.canonical,
      );
      if (jsonLdResult) {
        foundStructured = true;
        bestNapCount = Math.max(bestNapCount, countNapFields(jsonLdResult));
      }

      const microdataResult = extractLocalBusinessFromMicrodata(
        parsed.$,
        page.url,
        parsed.canonical,
      );
      if (microdataResult) {
        foundStructured = true;
        bestNapCount = Math.max(bestNapCount, countNapFields(microdataResult));
      }
    }

    if (!foundStructured) {
      return {
        id: "local-business-nap-structured",
        name: "NAP data is in structured markup",
        category: "structured-data",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 2,
        message: "No LocalBusiness structured data detected",
        severity: "warning",
      };
    }

    const score = Math.round((bestNapCount / 3) * 100);

    return {
      id: "local-business-nap-structured",
      name: "NAP data is in structured markup",
      category: "structured-data",
      status: score === 100 ? "pass" : "partial",
      score,
      maxScore: 100,
      weight: 2,
      message:
        score === 100
          ? "Name, address, and phone all present in structured markup"
          : `${bestNapCount}/3 NAP fields present in structured markup (name, address, phone)`,
      severity: "warning",
      fixSnippet:
        score < 100
          ? `<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "LocalBusiness",\n  "name": "Business Name",\n  "address": {\n    "@type": "PostalAddress",\n    "streetAddress": "123 Main St",\n    "addressLocality": "City",\n    "addressRegion": "ST",\n    "postalCode": "12345"\n  },\n  "telephone": "+1-555-000-0000"\n}\n</script>`
          : undefined,
    };
  },
};

export const localBusinessHoursJsonLd: Check = {
  id: "local-business-hours-jsonld",
  name: "Business hours in JSON-LD",
  category: "structured-data",
  weight: 1.5,
  severity: "warning",
  run: (pages) => {
    let foundJsonLd = false;
    let hasHours = false;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const biz = extractLocalBusinessFromJsonLd(parsed.jsonLd, page.url, parsed.canonical);
      if (!biz) continue;
      foundJsonLd = true;
      if (biz.hours && biz.hours.length > 0) {
        hasHours = true;
        break;
      }
    }

    if (!foundJsonLd) {
      return {
        id: "local-business-hours-jsonld",
        name: "Business hours in JSON-LD",
        category: "structured-data",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 1.5,
        message: "No LocalBusiness JSON-LD detected",
        severity: "warning",
      };
    }

    return {
      id: "local-business-hours-jsonld",
      name: "Business hours in JSON-LD",
      category: "structured-data",
      status: hasHours ? "pass" : "fail",
      score: hasHours ? 100 : 0,
      maxScore: 100,
      weight: 1.5,
      message: hasHours
        ? "openingHoursSpecification found in LocalBusiness JSON-LD"
        : "LocalBusiness JSON-LD found but openingHoursSpecification is missing",
      severity: "warning",
      fixSnippet: !hasHours
        ? `<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "LocalBusiness",\n  "name": "Business Name",\n  "openingHoursSpecification": [\n    {\n      "@type": "OpeningHoursSpecification",\n      "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],\n      "opens": "09:00",\n      "closes": "17:00"\n    }\n  ]\n}\n</script>`
        : undefined,
    };
  },
};

export const localBusinessBookingAccessible: Check = {
  id: "local-business-booking-accessible",
  name: "Booking link is agent-accessible",
  category: "bot-accessibility",
  weight: 1.5,
  severity: "warning",
  run: (pages, metadata) => {
    const bookingPaths = new Set<string>();
    let hasExternalBooking = false;

    const baseOrigin = new URL(metadata.baseUrl).origin;

    for (const page of pages) {
      const parsed = parseHTML(page.html);

      for (const link of parsed.links) {
        try {
          const url = new URL(link.href, metadata.baseUrl);
          if (url.origin === baseOrigin) {
            if (BOOKING_PATH_RE.test(url.pathname)) {
              bookingPaths.add(url.pathname);
            }
          } else {
            if (BOOKING_PLATFORMS.some((p) => url.hostname.includes(p))) {
              hasExternalBooking = true;
            }
          }
        } catch {
          // skip invalid URLs
        }
      }

      parsed.$("iframe[src]").each((_, el) => {
        const src = parsed.$(el).attr("src") || "";
        if (BOOKING_PLATFORMS.some((p) => src.includes(p))) {
          hasExternalBooking = true;
        }
      });
    }

    if (bookingPaths.size === 0 && !hasExternalBooking) {
      return {
        id: "local-business-booking-accessible",
        name: "Booking link is agent-accessible",
        category: "bot-accessibility",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 1.5,
        message: "No booking URLs or embeds found",
        severity: "warning",
      };
    }

    if (bookingPaths.size === 0 && hasExternalBooking) {
      return {
        id: "local-business-booking-accessible",
        name: "Booking link is agent-accessible",
        category: "bot-accessibility",
        status: "pass",
        score: 100,
        maxScore: 100,
        weight: 1.5,
        message: "External booking platform linked or embedded",
        severity: "warning",
      };
    }

    const blockedPaths: string[] = [];

    if (metadata.robotsTxt) {
      const robots = robotsParser(`${metadata.baseUrl}/robots.txt`, metadata.robotsTxt);
      for (const path of bookingPaths) {
        const fullUrl = `${metadata.baseUrl}${path}`;
        if (!robots.isAllowed(fullUrl, "*")) {
          blockedPaths.push(path);
        }
      }
    }

    const score =
      blockedPaths.length === 0
        ? 100
        : Math.round(((bookingPaths.size - blockedPaths.length) / bookingPaths.size) * 100);

    return {
      id: "local-business-booking-accessible",
      name: "Booking link is agent-accessible",
      category: "bot-accessibility",
      status: score === 100 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1.5,
      message:
        blockedPaths.length === 0
          ? `${bookingPaths.size} booking URL(s) found and accessible to agents`
          : `${blockedPaths.length} booking path(s) blocked by robots.txt: ${blockedPaths.join(", ")}`,
      severity: "warning",
    };
  },
};

export const localBusinessChecks: Check[] = [
  localBusinessNapStructured,
  localBusinessHoursJsonLd,
  localBusinessBookingAccessible,
];
