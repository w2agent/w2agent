import type { FetchedPage, SiteMetadata } from "../audit/types.js";
import { parseHTML } from "../shared/html-parser.js";
import type { SiteTypeDetectionResult, SiteTypeDetector } from "./types.js";

const LOCAL_BUSINESS_TYPES = new Set([
  "Restaurant",
  "FoodEstablishment",
  "Bakery",
  "BarOrPub",
  "CafeOrCoffeeShop",
  "FastFoodRestaurant",
  "Dentist",
  "MedicalBusiness",
  "Physician",
  "Optician",
  "HealthAndBeautyBusiness",
  "BeautySalon",
  "HairSalon",
  "NailSalon",
  "DaySpa",
  "LegalService",
  "Lawyer",
  "Accountant",
  "FinancialService",
  "AutoRepair",
  "AutomotiveBusiness",
  "GasStation",
  "HomeAndConstructionBusiness",
  "Plumber",
  "Electrician",
  "HVACBusiness",
  "Locksmith",
  "LocalBusiness",
  "ProfessionalService",
  "SportsActivityLocation",
  "Store",
  "EntertainmentBusiness",
]);

function isLocalBusinessType(type: unknown): boolean {
  if (typeof type !== "string") return false;
  return type === "LocalBusiness" || LOCAL_BUSINESS_TYPES.has(type);
}

function detectLocalBusiness(
  pages: FetchedPage[],
  _metadata: SiteMetadata,
): SiteTypeDetectionResult | null {
  const matchedSignals: Array<{ label: string; weight: number }> = [];

  for (const page of pages) {
    const html = page.html ?? "";
    const url = page.url ?? "";
    const parsed = parseHTML(html);
    const { $, jsonLd, links } = parsed;

    // @graph flattening (WordPress/Yoast wraps JSON-LD in @graph arrays)
    const allJsonLd: unknown[] = [];
    for (const item of jsonLd) {
      allJsonLd.push(item);
      const graph = (item as Record<string, unknown>)["@graph"];
      if (Array.isArray(graph)) allJsonLd.push(...graph);
    }

    // Signal 1: LocalBusiness JSON-LD schema (0.8)
    const hasLocalBusinessSchema = allJsonLd.some((item) => {
      if (typeof item !== "object" || item === null) return false;
      const rec = item as Record<string, unknown>;
      const type = rec["@type"];
      if (Array.isArray(type)) return type.some(isLocalBusinessType);
      return isLocalBusinessType(type);
    });
    if (
      hasLocalBusinessSchema &&
      !matchedSignals.find((s) => s.label === "LocalBusiness JSON-LD schema")
    ) {
      matchedSignals.push({ label: "LocalBusiness JSON-LD schema", weight: 0.8 });
    }

    // Signal 2: Booking platform embeds (0.6)
    // Bound to markup (iframe/script src, link href), never prose or serialized RSC payloads.
    const bookingPattern =
      /opentable|resy\.com|calendly\.com|acuityscheduling\.com|booksy\.com|vagaro\.com|mindbodyonline\.com/i;
    const attrMatches = (selector: string, attr: string, pattern: RegExp) =>
      $(selector)
        .toArray()
        .some((el) => pattern.test($(el).attr(attr) ?? ""));
    if (
      (attrMatches("iframe[src]", "src", bookingPattern) ||
        attrMatches("script[src]", "src", bookingPattern) ||
        attrMatches("[id]", "id", /opentable/i) ||
        attrMatches("a[href]", "href", bookingPattern)) &&
      !matchedSignals.find((s) => s.label === "Booking platform embed")
    ) {
      matchedSignals.push({ label: "Booking platform embed", weight: 0.6 });
    }

    // Signal 3: NAP microdata — address or phone structured data (0.6)
    if (
      ($('[itemprop="streetAddress"]').length > 0 || $('[itemprop="telephone"]').length > 0) &&
      !matchedSignals.find((s) => s.label === "NAP microdata")
    ) {
      matchedSignals.push({ label: "NAP microdata", weight: 0.6 });
    }

    // Signal 4: Map embed (0.5)
    if (
      (attrMatches("iframe[src]", "src", /maps\.google\.com\/maps\?|google\.com\/maps\/embed/) ||
        attrMatches("a[href]", "href", /maps\.google\.com\/maps\?|google\.com\/maps\/embed/)) &&
      !matchedSignals.find((s) => s.label === "Map embed")
    ) {
      matchedSignals.push({ label: "Map embed", weight: 0.5 });
    }

    // Signal 5: Business hours (0.5)
    const markupOnly = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
    const hasHoursItemprop = $('[itemprop="openingHours"]').length > 0;
    const hasHoursText = /\b(mon|tue|wed|thu|fri|sat|sun)\b.*\d{1,2}:\d{2}/i.test(markupOnly);
    if (
      (hasHoursItemprop || hasHoursText) &&
      !matchedSignals.find((s) => s.label === "Business hours")
    ) {
      matchedSignals.push({ label: "Business hours", weight: 0.5 });
    }

    // Signal 6: Menu/services URL paths (0.4)
    const allUrls = [url, ...links.map((l) => l.href)];
    const localPathPattern = /(menu|services|treatments|appointments|reservations|booking)\b/i;
    if (
      allUrls.some((u) => localPathPattern.test(u)) &&
      !matchedSignals.find((s) => s.label === "Menu/services URL paths")
    ) {
      matchedSignals.push({ label: "Menu/services URL paths", weight: 0.4 });
    }

    // Signal 7: Phone tel: links (0.3)
    if (
      $('a[href^="tel:"]').length > 0 &&
      !matchedSignals.find((s) => s.label === "Phone tel: links")
    ) {
      matchedSignals.push({ label: "Phone tel: links", weight: 0.3 });
    }
  }

  if (matchedSignals.length === 0) return null;

  // Confidence = 1 - product(1 - weight_i) — probability union formula
  const confidence = 1 - matchedSignals.reduce((acc, s) => acc * (1 - s.weight), 1);

  if (confidence < 0.5) return null;

  return {
    siteType: "local-business",
    confidence,
    signals: matchedSignals.map((s) => s.label),
  };
}

export const localBusinessDetector: SiteTypeDetector = {
  siteType: "local-business",
  detect: detectLocalBusiness,
};
