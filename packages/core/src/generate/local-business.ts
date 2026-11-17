import type { CheerioAPI } from "cheerio";
import { parseHTML } from "../shared/html-parser.js";
import type { GenerateContext } from "./types.js";

export interface OpeningHours {
  days: string[];
  opens: string;
  closes: string;
}

export interface ExtractedLocalBusiness {
  name: string;
  type: string;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  phone?: string;
  email?: string;
  url: string;
  hours?: OpeningHours[];
  menu?: string;
  services?: string;
  bookingUrl?: string;
  geo?: { lat: number; lng: number };
  priceRange?: string;
  image?: string;
  source: "json-ld" | "microdata" | "html";
}

export interface LocalBusinessArtifacts {
  business: ExtractedLocalBusiness;
}

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

const BOOKING_PLATFORMS = [
  "opentable.com",
  "resy.com",
  "calendly.com",
  "acuityscheduling.com",
  "booksy.com",
  "vagaro.com",
  "mindbodyonline.com",
];

function parseOpeningHoursSpec(spec: unknown): OpeningHours[] {
  if (!Array.isArray(spec)) return [];
  const result: OpeningHours[] = [];
  for (const entry of spec) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const opens = typeof e.opens === "string" ? e.opens : "";
    const closes = typeof e.closes === "string" ? e.closes : "";
    if (!opens || !closes) continue;

    const rawDays = e.dayOfWeek;
    const daysRaw = Array.isArray(rawDays) ? rawDays : [rawDays];
    const days: string[] = [];
    for (const d of daysRaw) {
      if (typeof d !== "string") continue;
      const day = d.replace("https://schema.org/", "").replace("http://schema.org/", "");
      if (day) days.push(day);
    }
    if (days.length === 0) continue;
    result.push({ days, opens, closes });
  }
  return result;
}

export function extractLocalBusinessFromJsonLd(
  jsonLd: unknown[],
  url: string,
  canonical?: string,
): Partial<ExtractedLocalBusiness> | null {
  const allItems: unknown[] = [];
  for (const item of jsonLd) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (Array.isArray(obj["@graph"])) {
      for (const child of obj["@graph"]) {
        allItems.push(child);
      }
    } else {
      allItems.push(item);
    }
  }

  for (const item of allItems) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const rawType = obj["@type"];
    const types = Array.isArray(rawType) ? rawType : [rawType];
    const matchedType = types.find((t) => typeof t === "string" && LOCAL_BUSINESS_TYPES.has(t));
    if (!matchedType) continue;

    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) return null;

    let address: ExtractedLocalBusiness["address"] | undefined;
    if (obj.address && typeof obj.address === "object") {
      const a = obj.address as Record<string, unknown>;
      address = {
        street: typeof a.streetAddress === "string" ? a.streetAddress : undefined,
        city: typeof a.addressLocality === "string" ? a.addressLocality : undefined,
        state: typeof a.addressRegion === "string" ? a.addressRegion : undefined,
        zip: typeof a.postalCode === "string" ? a.postalCode : undefined,
        country: typeof a.addressCountry === "string" ? a.addressCountry : undefined,
      };
    }

    let image: string | undefined;
    if (typeof obj.image === "string") image = obj.image;
    else if (Array.isArray(obj.image) && typeof obj.image[0] === "string") image = obj.image[0];

    let geo: { lat: number; lng: number } | undefined;
    if (obj.geo && typeof obj.geo === "object") {
      const g = obj.geo as Record<string, unknown>;
      const lat = parseFloat(String(g.latitude ?? ""));
      const lng = parseFloat(String(g.longitude ?? ""));
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) geo = { lat, lng };
    }

    let bookingUrl: string | undefined;
    if (typeof obj.reservationUrl === "string") {
      bookingUrl = obj.reservationUrl;
    } else if (obj.potentialAction && typeof obj.potentialAction === "object") {
      const action = obj.potentialAction as Record<string, unknown>;
      if (action["@type"] === "ReserveAction" && typeof action.target === "string") {
        bookingUrl = action.target;
      }
    }

    let menu: string | undefined;
    if (typeof obj.hasMenu === "string") menu = obj.hasMenu;
    else if (typeof obj.menu === "string") menu = obj.menu;

    return {
      name,
      type: matchedType as string,
      address,
      phone: typeof obj.telephone === "string" ? obj.telephone : undefined,
      email: typeof obj.email === "string" ? obj.email : undefined,
      url: typeof obj.url === "string" ? obj.url : (canonical ?? url),
      hours: parseOpeningHoursSpec(obj.openingHoursSpecification),
      menu,
      bookingUrl,
      geo,
      priceRange: typeof obj.priceRange === "string" ? obj.priceRange : undefined,
      image,
      source: "json-ld",
    };
  }

  return null;
}

export function extractLocalBusinessFromMicrodata(
  $: CheerioAPI,
  url: string,
  canonical?: string,
): Partial<ExtractedLocalBusiness> | null {
  const container = $('[itemtype*="schema.org/"]').first();

  const findProp = (prop: string) => {
    if (container.length > 0) {
      return container.find(`[itemprop="${prop}"]`).first();
    }
    return $(`[itemprop="${prop}"]`).first();
  };

  const nameEl = findProp("name");
  const name = nameEl.attr("content") || nameEl.text().trim();
  if (!name) return null;

  const phoneEl = findProp("telephone");
  const phone = phoneEl.attr("content") || phoneEl.text().trim() || undefined;

  const street = findProp("streetAddress").text().trim() || undefined;
  const city = findProp("addressLocality").text().trim() || undefined;
  const state = findProp("addressRegion").text().trim() || undefined;
  const zip = findProp("postalCode").text().trim() || undefined;

  const address: ExtractedLocalBusiness["address"] =
    street || city || state || zip ? { street, city, state, zip } : undefined;

  return {
    name,
    type: "LocalBusiness",
    address,
    phone,
    url: canonical ?? url,
    source: "microdata",
  };
}

export function extractLocalBusinessFromHtml(
  $: CheerioAPI,
  url: string,
  _html: string,
): Partial<ExtractedLocalBusiness> | null {
  const telHref = $('a[href^="tel:"]').first().attr("href");
  const phone = telHref ? telHref.replace("tel:", "").trim() : undefined;

  let bookingUrl: string | undefined;
  $("a[href]").each((_, el) => {
    if (bookingUrl) return;
    const href = $(el).attr("href") || "";
    if (BOOKING_PLATFORMS.some((p) => href.includes(p))) {
      bookingUrl = href;
    }
  });
  if (!bookingUrl) {
    $("iframe[src]").each((_, el) => {
      if (bookingUrl) return;
      const src = $(el).attr("src") || "";
      if (BOOKING_PLATFORMS.some((p) => src.includes(p))) {
        bookingUrl = src;
      }
    });
  }

  if (!phone && !bookingUrl) return null;

  return {
    name: "",
    type: "LocalBusiness",
    url,
    phone,
    bookingUrl,
    source: "html",
  };
}

function mergeLocalBusiness(
  parts: Partial<ExtractedLocalBusiness>[],
  baseUrl: string,
): ExtractedLocalBusiness | null {
  let name = "";
  let source: ExtractedLocalBusiness["source"] = "html";

  for (const part of parts) {
    if (part.name && !name) {
      name = part.name;
      source = part.source ?? "html";
    }
  }

  if (!name) return null;

  const first = <T>(fn: (p: Partial<ExtractedLocalBusiness>) => T | undefined): T | undefined => {
    for (const part of parts) {
      const v = fn(part);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const firstNonEmpty = <T>(
    fn: (p: Partial<ExtractedLocalBusiness>) => T | undefined,
    isEmpty: (v: T) => boolean,
  ): T | undefined => {
    for (const part of parts) {
      const v = fn(part);
      if (v !== undefined && !isEmpty(v)) return v;
    }
    return undefined;
  };

  const mergedAddress = (() => {
    const street = first((p) => p.address?.street);
    const city = first((p) => p.address?.city);
    const state = first((p) => p.address?.state);
    const zip = first((p) => p.address?.zip);
    const country = first((p) => p.address?.country);
    if (!street && !city && !state && !zip && !country) return undefined;
    return { street, city, state, zip, country };
  })();

  return {
    name,
    type: first((p) => p.type) ?? "LocalBusiness",
    url: first((p) => p.url) ?? baseUrl,
    address: mergedAddress,
    phone: first((p) => p.phone),
    email: first((p) => p.email),
    hours: firstNonEmpty(
      (p) => p.hours,
      (v) => v.length === 0,
    ),
    menu: first((p) => p.menu),
    services: first((p) => p.services),
    bookingUrl: first((p) => p.bookingUrl),
    geo: first((p) => p.geo),
    priceRange: first((p) => p.priceRange),
    image: first((p) => p.image),
    source,
  };
}

export function extractLocalBusiness(ctx: GenerateContext): ExtractedLocalBusiness | null {
  const parts: Partial<ExtractedLocalBusiness>[] = [];

  for (const page of ctx.rawPages) {
    if (page.status !== 200 || !page.html) continue;
    const parsed = parseHTML(page.html);

    const fromJsonLd = extractLocalBusinessFromJsonLd(parsed.jsonLd, page.url, parsed.canonical);
    if (fromJsonLd) parts.push(fromJsonLd);

    const fromMicrodata = extractLocalBusinessFromMicrodata(parsed.$, page.url, parsed.canonical);
    if (fromMicrodata) parts.push(fromMicrodata);

    const fromHtml = extractLocalBusinessFromHtml(parsed.$, page.url, page.html);
    if (fromHtml) parts.push(fromHtml);
  }

  if (parts.length === 0) return null;
  return mergeLocalBusiness(parts, ctx.baseUrl);
}

export function buildLocalBusinessArtifacts(ctx: GenerateContext): LocalBusinessArtifacts | null {
  if (ctx.siteType?.siteType !== "local-business") return null;
  const business = extractLocalBusiness(ctx);
  if (!business) return null;
  return { business };
}

export function generateBusinessInfoTable(business: ExtractedLocalBusiness): string {
  const rows: string[] = [`| Name | ${business.name} |`, `| Type | ${business.type} |`];

  if (business.phone) {
    rows.push(`| Phone | ${business.phone} |`);
  }

  if (business.address) {
    const a = business.address;
    const parts = [a.street, a.city, a.state, a.zip, a.country].filter(Boolean);
    if (parts.length > 0) {
      rows.push(`| Address | ${parts.join(", ")} |`);
    }
  }

  if (business.hours && business.hours.length > 0) {
    const hoursStr = business.hours
      .map((h) => `${h.days.join("/")} ${h.opens}–${h.closes}`)
      .join(", ");
    rows.push(`| Hours | ${hoursStr} |`);
  }

  if (business.menu) {
    rows.push(`| Menu | ${business.menu} |`);
  }

  if (business.services) {
    rows.push(`| Services | ${business.services} |`);
  }

  if (business.bookingUrl) {
    rows.push(`| Booking | ${business.bookingUrl} |`);
  }

  if (business.priceRange) {
    rows.push(`| Price Range | ${business.priceRange} |`);
  }

  return ["<!-- Generated by w2agent -->", "| Field | Value |", "| --- | --- |", ...rows].join(
    "\n",
  );
}

export function generateLocalBusinessToolHandlers(lang: "js" | "ts" = "js"): string {
  const ts = lang === "ts";
  const b = ts ? ": any" : "";
  const h = ts ? ": any" : "";
  return `function getHours(business${b}) {
  if (!business.hours || business.hours.length === 0) return 'Hours not available.';
  return business.hours
    .map((h${h}) => \`\${h.days.join('/')}: \${h.opens}–\${h.closes}\`)
    .join('\\n');
}

function getMenu(business${b}) {
  if (!business.menu) return 'Menu not available.';
  return { url: business.menu };
}

function getServices(business${b}) {
  if (!business.services) return 'Services page not available.';
  return { url: business.services };
}

function bookAppointment(business${b}) {
  if (!business.bookingUrl) return 'Online booking not available.';
  return { url: business.bookingUrl, instructions: 'Visit the booking URL to schedule an appointment.' };
}`;
}
