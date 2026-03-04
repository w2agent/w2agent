import type { Check, FetchedPage, SiteMetadata } from "../../audit/types.js";

export const nuxtSeoModuleCheck: Check = {
  id: "nuxt-seo-module",
  name: "Nuxt SEO Module",
  category: "bot-accessibility",
  weight: 1,
  severity: "warning",
  run(pages: FetchedPage[]) {
    const hasSitemapIndex = pages.some(p =>
      p.html.includes("sitemap-index") || p.html.includes("sitemap_index"),
    );
    const hasNuxtSeoHints = pages.some(p =>
      p.html.includes("nuxt-seo") || p.html.includes("@nuxtjs/seo"),
    );
    const hasAny = hasSitemapIndex || hasNuxtSeoHints;

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
        ? "Nuxt SEO module detected — sitemap and SEO features are active"
        : "Nuxt SEO module not detected. Install @nuxtjs/seo for automatic sitemap, robots.txt, and meta tags.",
      details: hasAny
        ? undefined
        : "Run: npx nuxi module add @nuxtjs/seo",
    };
  },
};

export const nuxtLlmsModuleCheck: Check = {
  id: "nuxt-llms-module",
  name: "Nuxt LLMs Module",
  category: "agent-discovery",
  weight: 1,
  severity: "info",
  run(pages: FetchedPage[], metadata: SiteMetadata) {
    const hasLlmsTxt = !!metadata.wellKnown["llms.txt"] || pages.some(p =>
      p.url.endsWith("/llms.txt"),
    );
    const hasNuxtLlms = pages.some(p =>
      p.html.includes("nuxt-llms") || p.html.includes("@nuxtjs/llms"),
    );
    const hasAny = hasLlmsTxt || hasNuxtLlms;

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
        ? "Nuxt LLMs module or llms.txt detected — AI content discovery is active"
        : "No nuxt-llms module or llms.txt found. Install nuxt-llms for automatic llms.txt generation.",
      details: hasAny
        ? undefined
        : "Run: npx nuxi module add nuxt-llms",
    };
  },
};

export const nuxtSchemaOrgCheck: Check = {
  id: "nuxt-schema-org",
  name: "Nuxt Schema.org Coverage",
  category: "structured-data",
  weight: 1,
  severity: "info",
  run(pages: FetchedPage[]) {
    let withSchema = 0;
    for (const page of pages) {
      const hasJsonLd = page.html.includes("application/ld+json");
      const hasUseSchemaOrg = page.html.includes("useSchemaOrg") || page.html.includes("schema-org");
      if (hasJsonLd || hasUseSchemaOrg) withSchema++;
    }

    const ratio = pages.length > 0 ? withSchema / pages.length : 0;

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: ratio >= 0.8 ? "pass" : ratio >= 0.5 ? "partial" : "fail",
      score: Math.round(ratio * 100),
      maxScore: 100,
      message: ratio >= 0.8
        ? `${withSchema}/${pages.length} pages have JSON-LD structured data`
        : `Only ${withSchema}/${pages.length} pages have structured data. Use @nuxtjs/schema-org for automatic JSON-LD.`,
    };
  },
};

export const nuxtSsrHintsCheck: Check = {
  id: "nuxt-ssr-hints",
  name: "Nuxt SSR Rendering",
  category: "technical",
  weight: 1,
  severity: "warning",
  run(pages: FetchedPage[]) {
    const spaOnly = pages.every(p => {
      const hasEmptyBody = /<body[^>]*>\s*<div\s+id=["'](__nuxt|app)["']\s*><\/div>/i.test(p.html);
      const noContent = p.html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").trim().length < 200;
      return hasEmptyBody || noContent;
    });

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: spaOnly ? "fail" : "pass",
      score: spaOnly ? 0 : 100,
      maxScore: 100,
      message: spaOnly
        ? "Pages appear to be client-rendered only (SPA mode). AI crawlers need server-rendered HTML."
        : "Pages are server-rendered — AI crawlers can access content directly.",
      details: spaOnly
        ? "Ensure ssr: true in nuxt.config.ts (this is the default). If using routeRules, check that key pages are not set to SPA mode."
        : undefined,
    };
  },
};

export const nuxtChecks: Check[] = [
  nuxtSeoModuleCheck,
  nuxtLlmsModuleCheck,
  nuxtSchemaOrgCheck,
  nuxtSsrHintsCheck,
];
