import { isAgentCard } from "../../audit/shared/json.js";
import type { Check, FetchedPage, SiteMetadata } from "../../audit/types.js";

export const nextjsWellKnownCheck: Check = {
  id: "nextjs-well-known-served",
  name: "Next.js .well-known Serving",
  category: "agent-discovery",
  weight: 1,
  severity: "warning",
  run(_pages: FetchedPage[], metadata: SiteMetadata) {
    const hasAgentCard = isAgentCard(metadata.wellKnown["agent-card.json"]);
    const hasAny = hasAgentCard;

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: hasAny ? "pass" : "fail",
      score: hasAny ? 100 : 0,
      maxScore: 100,
      message: hasAny
        ? ".well-known/ directory serves agent discovery files correctly"
        : ".well-known/ agent discovery files not found — Next.js needs route handlers or public/ files for these",
      details: hasAny
        ? undefined
        : "Add files to public/.well-known/ or create route handlers in app/.well-known/",
    };
  },
};

const STATIC_CACHE_VALUES = new Set(["HIT", "STALE", "PRERENDER", "REVALIDATED"]);
const NEXT_DATA_RE = /<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

type PageRendering = "static" | "dynamic" | "unknown";

function readNextDataFlags(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function classifyPageRendering(page: FetchedPage): PageRendering {
  const cacheControl = (page.headers["cache-control"] ?? "").toLowerCase();
  const flags = readNextDataFlags(NEXT_DATA_RE.exec(page.html)?.[1] ?? "");
  const isGsp = flags.gsp === true;
  const isExported = flags.nextExport === true;
  const dynamic =
    /\b(private|no-store)\b/.test(cacheControl) ||
    (!isExported && (flags.gssp === true || flags.gip === true)) ||
    (flags.appGip === true && !isGsp && !isExported);
  if (dynamic) return "dynamic";

  const isStaticCacheValue = (v: string | undefined) =>
    v?.split(",").some((part) => STATIC_CACHE_VALUES.has(part.trim().toUpperCase())) === true;
  const isStatic =
    page.headers["x-nextjs-prerender"] !== undefined ||
    isStaticCacheValue(page.headers["x-nextjs-cache"]) ||
    isStaticCacheValue(page.headers["x-vercel-cache"]) ||
    /\b(s-maxage|public)\b/.test(cacheControl) ||
    isGsp ||
    isExported ||
    flags.autoExport === true;
  return isStatic ? "static" : "unknown";
}

export const nextjsStaticGenerationCheck: Check = {
  id: "nextjs-static-generation",
  name: "Next.js Static Generation",
  category: "technical",
  weight: 1,
  severity: "info",
  run(pages: FetchedPage[]) {
    const rendering = pages.map(classifyPageRendering);
    const staticCount = rendering.filter((r) => r === "static").length;
    const evidenced = staticCount + rendering.filter((r) => r === "dynamic").length;
    const isStatic = evidenced > 0 && staticCount / evidenced >= 0.5;
    const fraction = `${staticCount}/${evidenced} sampled pages with rendering evidence are statically served`;

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: isStatic ? "pass" : "partial",
      score: isStatic ? 100 : 60,
      maxScore: 100,
      message: isStatic
        ? `Most pages appear to use static generation (${fraction}) — fast and reliable for AI crawlers`
        : evidenced === 0
          ? "No static-generation evidence found on sampled pages. Static generation improves AI crawler reliability."
          : `Most pages appear to be rendered per request (${fraction}). Static generation improves AI crawler reliability.`,
      details: isStatic
        ? undefined
        : "Consider using generateStaticParams() for key pages so AI bots get fast, cacheable responses. Reading headers(), cookies() or searchParams in a layout makes every route beneath it dynamic.",
    };
  },
};

export const nextjsMetadataApiCheck: Check = {
  id: "nextjs-metadata-api",
  name: "Next.js Metadata API Usage",
  category: "structured-data",
  weight: 1,
  severity: "info",
  run(pages: FetchedPage[]) {
    let hasGoodMetadata = 0;
    for (const page of pages) {
      const hasTitle = /<title>[^<]+<\/title>/i.test(page.html);
      const hasDescription = /<meta\s+name=["']description["']/i.test(page.html);
      const hasOg = /<meta\s+property=["']og:/i.test(page.html);
      if (hasTitle && hasDescription && hasOg) hasGoodMetadata++;
    }

    const ratio = pages.length > 0 ? hasGoodMetadata / pages.length : 0;

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: ratio >= 0.8 ? "pass" : ratio >= 0.5 ? "partial" : "fail",
      score: Math.round(ratio * 100),
      maxScore: 100,
      message:
        ratio >= 0.8
          ? `${hasGoodMetadata}/${pages.length} pages have complete metadata (title, description, OG tags)`
          : `Only ${hasGoodMetadata}/${pages.length} pages have complete metadata. Use Next.js Metadata API for consistent SEO.`,
    };
  },
};

export const nextjsChecks: Check[] = [
  nextjsWellKnownCheck,
  nextjsStaticGenerationCheck,
  nextjsMetadataApiCheck,
];
