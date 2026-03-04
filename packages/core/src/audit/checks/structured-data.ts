import type { Check, FetchedPage, SiteMetadata } from "../types.js";
import { parseHTML } from "../../shared/html-parser.js";

export const schemaOrgPresent: Check = {
  id: "schema-org-present",
  name: "Schema.org JSON-LD present",
  category: "structured-data",
  weight: 2,
  severity: "warning",
  run: (pages) => {
    const parsed = pages.map((p) => ({ url: p.url, page: parseHTML(p.html) }));
    const withSchema = parsed.filter((p) => p.page.jsonLd.length > 0);
    const score = pages.length > 0 ? Math.round((withSchema.length / pages.length) * 100) : 0;

    return {
      id: "schema-org-present",
      name: "Schema.org JSON-LD present",
      category: "structured-data",
      status: score === 100 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 2,
      message:
        score === 100
          ? "All pages have Schema.org JSON-LD"
          : `${withSchema.length}/${pages.length} pages have JSON-LD structured data`,
      severity: score < 50 ? "warning" : "info",
      fixSnippet:
        score < 100
          ? `<!-- Add to <head> of your pages -->\n<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "WebPage",\n  "name": "Page Title",\n  "description": "Page description"\n}\n</script>`
          : undefined,
    };
  },
};

export const schemaOrgType: Check = {
  id: "schema-org-type",
  name: "Appropriate Schema.org type",
  category: "structured-data",
  weight: 1,
  severity: "info",
  run: (pages) => {
    const validTypes = [
      "WebPage", "Article", "BlogPosting", "Product", "LocalBusiness",
      "Organization", "Person", "FAQPage", "HowTo", "Recipe", "Event",
      "Course", "SoftwareApplication", "WebSite", "ItemList", "BreadcrumbList",
    ];

    const parsed = pages.map((p) => parseHTML(p.html));
    let typedCount = 0;

    for (const page of parsed) {
      for (const ld of page.jsonLd) {
        const ldObj = ld as Record<string, unknown>;
        const type = ldObj?.["@type"];
        if (typeof type === "string" && validTypes.some((t) => type.includes(t))) {
          typedCount++;
          break;
        }
      }
    }

    const score = pages.length > 0 ? Math.round((typedCount / pages.length) * 100) : 0;

    return {
      id: "schema-org-type",
      name: "Appropriate Schema.org type",
      category: "structured-data",
      status: score >= 50 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: `${typedCount}/${pages.length} pages use recognized Schema.org types`,
      severity: "info",
    };
  },
};

export const schemaOrgCompleteness: Check = {
  id: "schema-org-completeness",
  name: "Schema.org completeness",
  category: "structured-data",
  weight: 1,
  severity: "info",
  run: (pages) => {
    const requiredFields = ["name", "description"];
    const bonusFields = ["author", "datePublished", "dateModified", "image", "url"];
    const allFields = [...requiredFields, ...bonusFields];

    const parsed = pages.map((p) => parseHTML(p.html));
    let totalScore = 0;
    let pagesWithSchema = 0;

    for (const page of parsed) {
      if (page.jsonLd.length === 0) continue;
      pagesWithSchema++;

      const primaryLd = page.jsonLd[0] as Record<string, unknown>;
      const presentFields = allFields.filter((f) => primaryLd[f] !== undefined);
      totalScore += (presentFields.length / allFields.length) * 100;
    }

    const score = pagesWithSchema > 0 ? Math.round(totalScore / pagesWithSchema) : 0;

    return {
      id: "schema-org-completeness",
      name: "Schema.org completeness",
      category: "structured-data",
      status: score >= 70 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: pagesWithSchema > 0
        ? `Average field completeness: ${score}%`
        : "No Schema.org data to evaluate",
      severity: "info",
    };
  },
};

export const schemaOrgValid: Check = {
  id: "schema-org-valid",
  name: "JSON-LD valid",
  category: "structured-data",
  weight: 1,
  severity: "error",
  run: (pages) => {
    let validCount = 0;
    let totalSchemaPages = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      if (parsed.jsonLd.length === 0) continue;
      totalSchemaPages++;

      const hasContext = parsed.jsonLd.some(
        (ld) => (ld as Record<string, unknown>)?.["@context"]?.toString().includes("schema.org"),
      );
      const hasType = parsed.jsonLd.some(
        (ld) => typeof (ld as Record<string, unknown>)?.["@type"] === "string",
      );

      if (hasContext && hasType) validCount++;
    }

    const score = totalSchemaPages > 0 ? Math.round((validCount / totalSchemaPages) * 100) : 0;

    return {
      id: "schema-org-valid",
      name: "JSON-LD valid",
      category: "structured-data",
      status: score === 100 ? "pass" : score > 0 ? "partial" : totalSchemaPages === 0 ? "skip" : "fail",
      score: totalSchemaPages === 0 ? 0 : score,
      maxScore: 100,
      weight: 1,
      message: totalSchemaPages === 0
        ? "No JSON-LD found to validate"
        : `${validCount}/${totalSchemaPages} JSON-LD blocks are valid`,
      severity: score < 100 ? "error" : "info",
    };
  },
};

export const ogMetaTags: Check = {
  id: "og-meta-tags",
  name: "OpenGraph meta tags",
  category: "structured-data",
  weight: 1,
  severity: "warning",
  run: (pages) => {
    const requiredOg = ["og:title", "og:description", "og:image"];
    let totalScore = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const present = requiredOg.filter((tag) => parsed.ogTags[tag]);
      totalScore += (present.length / requiredOg.length) * 100;
    }

    const score = pages.length > 0 ? Math.round(totalScore / pages.length) : 0;

    return {
      id: "og-meta-tags",
      name: "OpenGraph meta tags",
      category: "structured-data",
      status: score >= 80 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: score >= 80
        ? "OpenGraph tags are well-configured"
        : "Missing OpenGraph tags on some pages",
      severity: score < 50 ? "warning" : "info",
      fixSnippet: score < 100
        ? `<!-- Add to <head> -->\n<meta property="og:title" content="Your Page Title" />\n<meta property="og:description" content="Your page description" />\n<meta property="og:image" content="https://yoursite.com/og-image.jpg" />`
        : undefined,
    };
  },
};

export const headingHierarchy: Check = {
  id: "heading-hierarchy",
  name: "Heading hierarchy",
  category: "structured-data",
  weight: 0.5,
  severity: "info",
  run: (pages) => {
    let goodPages = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      if (parsed.headings.length === 0) continue;

      const hasH1 = parsed.h1.length >= 1;
      const singleH1 = parsed.h1.length === 1;
      let properNesting = true;

      for (let i = 1; i < parsed.headings.length; i++) {
        if (parsed.headings[i].level - parsed.headings[i - 1].level > 1) {
          properNesting = false;
          break;
        }
      }

      if (hasH1 && singleH1 && properNesting) goodPages++;
    }

    const score = pages.length > 0 ? Math.round((goodPages / pages.length) * 100) : 0;

    return {
      id: "heading-hierarchy",
      name: "Heading hierarchy",
      category: "structured-data",
      status: score >= 80 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message: `${goodPages}/${pages.length} pages have proper heading hierarchy`,
      severity: "info",
    };
  },
};

export const semanticHtml: Check = {
  id: "semantic-html",
  name: "Semantic HTML elements",
  category: "structured-data",
  weight: 0.5,
  severity: "info",
  run: (pages) => {
    const targetElements = ["article", "section", "nav", "main", "aside"];
    let totalScore = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const found = targetElements.filter((el) => parsed.semanticElements.includes(el));
      totalScore += (found.length / targetElements.length) * 100;
    }

    const score = pages.length > 0 ? Math.round(totalScore / pages.length) : 0;

    return {
      id: "semantic-html",
      name: "Semantic HTML elements",
      category: "structured-data",
      status: score >= 60 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message: score >= 60
        ? "Good use of semantic HTML elements"
        : "Limited use of semantic HTML (<article>, <section>, <nav>, <main>)",
      severity: "info",
    };
  },
};

export const structuredDataChecks: Check[] = [
  schemaOrgPresent,
  schemaOrgType,
  schemaOrgCompleteness,
  schemaOrgValid,
  ogMetaTags,
  headingHierarchy,
  semanticHtml,
];
