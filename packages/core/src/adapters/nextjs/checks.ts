import type { Check, FetchedPage, SiteMetadata } from "../../audit/types.js";

export const nextjsWellKnownCheck: Check = {
  id: "nextjs-well-known-served",
  name: "Next.js .well-known Serving",
  category: "agent-discovery",
  weight: 1,
  severity: "warning",
  run(_pages: FetchedPage[], metadata: SiteMetadata) {
    const hasAgentCard = !!metadata.wellKnown["agent-card.json"];
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

export const nextjsStaticGenerationCheck: Check = {
  id: "nextjs-static-generation",
  name: "Next.js Static Generation",
  category: "technical",
  weight: 1,
  severity: "info",
  run(pages: FetchedPage[]) {
    const hasStaticHints = pages.some(
      (p) =>
        p.headers["x-nextjs-cache"] === "HIT" ||
        p.headers["x-vercel-cache"] === "HIT" ||
        p.html.includes("__NEXT_DATA__"),
    );

    const hasSSROnly = pages.some(
      (p) =>
        p.headers["cache-control"]?.includes("no-cache") ||
        p.headers["cache-control"]?.includes("private"),
    );

    const isStatic = hasStaticHints && !hasSSROnly;

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
        ? "Pages appear to use static generation — fast and reliable for AI crawlers"
        : "Pages may use SSR-only rendering. Static generation improves AI crawler reliability.",
      details: isStatic
        ? undefined
        : "Consider using generateStaticParams() for key pages so AI bots get fast, cacheable responses.",
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
