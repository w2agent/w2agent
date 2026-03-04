import type { Check } from "../types.js";
import { parseHTML } from "../../shared/html-parser.js";

export const answerFirst: Check = {
  id: "answer-first",
  name: "Answer-first content",
  category: "content-quality",
  weight: 1.5,
  severity: "info",
  run: (pages) => {
    let goodPages = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      // Check if first ~500 chars of visible text contain substantive content
      const firstChunk = parsed.text.slice(0, 500);
      const words = firstChunk.split(/\s+/).filter(Boolean);
      // Has enough content early and doesn't start with just navigation
      if (words.length >= 20 && parsed.metaDescription.length > 0) {
        goodPages++;
      }
    }

    const score = pages.length > 0 ? Math.round((goodPages / pages.length) * 100) : 0;

    return {
      id: "answer-first",
      name: "Answer-first content",
      category: "content-quality",
      status: score >= 70 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1.5,
      message: score >= 70
        ? "Pages lead with substantive content"
        : "Some pages lack early substantive content or meta descriptions",
      severity: "info",
    };
  },
};

export const tokenEfficiency: Check = {
  id: "token-efficiency",
  name: "Token efficiency (HTML-to-text ratio)",
  category: "content-quality",
  weight: 1,
  severity: "info",
  run: (pages) => {
    let totalRatio = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const ratio = parsed.htmlLength > 0 ? parsed.textLength / parsed.htmlLength : 0;
      totalRatio += ratio;
    }

    const avgRatio = pages.length > 0 ? totalRatio / pages.length : 0;
    // Good ratio is >0.15 (15% of HTML is actual text)
    let score: number;
    if (avgRatio >= 0.25) score = 100;
    else if (avgRatio >= 0.15) score = 80;
    else if (avgRatio >= 0.1) score = 60;
    else if (avgRatio >= 0.05) score = 30;
    else score = 0;

    return {
      id: "token-efficiency",
      name: "Token efficiency (HTML-to-text ratio)",
      category: "content-quality",
      status: score >= 60 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: `Average text-to-HTML ratio: ${(avgRatio * 100).toFixed(1)}%`,
      severity: "info",
    };
  },
};

export const contentLength: Check = {
  id: "content-length",
  name: "Content length",
  category: "content-quality",
  weight: 1,
  severity: "warning",
  run: (pages) => {
    let goodPages = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      if (parsed.wordCount >= 200) goodPages++;
    }

    const score = pages.length > 0 ? Math.round((goodPages / pages.length) * 100) : 0;

    return {
      id: "content-length",
      name: "Content length",
      category: "content-quality",
      status: score >= 70 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: `${goodPages}/${pages.length} pages have 200+ words`,
      severity: score < 50 ? "warning" : "info",
    };
  },
};

export const listAndTableUsage: Check = {
  id: "list-and-table-usage",
  name: "Lists and tables for structured info",
  category: "content-quality",
  weight: 1,
  severity: "info",
  run: (pages) => {
    let pagesWithStructured = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      if (parsed.lists >= 1 || parsed.tables >= 1) pagesWithStructured++;
    }

    const score = pages.length > 0 ? Math.round((pagesWithStructured / pages.length) * 100) : 0;

    return {
      id: "list-and-table-usage",
      name: "Lists and tables for structured info",
      category: "content-quality",
      status: score >= 50 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: `${pagesWithStructured}/${pages.length} pages use lists or tables`,
      severity: "info",
    };
  },
};

export const faqContent: Check = {
  id: "faq-content",
  name: "FAQ content",
  category: "content-quality",
  weight: 0.5,
  severity: "info",
  run: (pages) => {
    let faqPages = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      if (parsed.hasFaqContent) faqPages++;
    }

    const score = faqPages > 0 ? Math.min(100, faqPages * 33) : 0;

    return {
      id: "faq-content",
      name: "FAQ content",
      category: "content-quality",
      status: score > 0 ? "pass" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message: faqPages > 0
        ? `${faqPages} page(s) contain FAQ/Q&A content`
        : "No FAQ or Q&A content detected",
      severity: "info",
      fixSnippet: faqPages === 0
        ? `<!-- Add FAQ schema + content -->\n<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "FAQPage",\n  "mainEntity": [{\n    "@type": "Question",\n    "name": "Your question?",\n    "acceptedAnswer": {\n      "@type": "Answer",\n      "text": "Your answer."\n    }\n  }]\n}\n</script>`
        : undefined,
    };
  },
};

export const citationReadiness: Check = {
  id: "citation-readiness",
  name: "Citation readiness",
  category: "content-quality",
  weight: 1,
  severity: "info",
  run: (pages) => {
    let totalScore = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      let pageScore = 0;
      const text = parsed.text.toLowerCase();

      // Has statistics/numbers
      if (/\d+%|\d+\.\d+/.test(parsed.text)) pageScore += 25;
      // Has quotes
      if (parsed.$("blockquote").length > 0 || /"[^"]{20,}"/.test(parsed.text)) pageScore += 25;
      // Has references/sources
      if (text.includes("source") || text.includes("reference") || text.includes("according to") || text.includes("study")) pageScore += 25;
      // Has author attribution
      if (parsed.$('[rel="author"]').length > 0 || text.includes("by ") || text.includes("author")) pageScore += 25;

      totalScore += pageScore;
    }

    const score = pages.length > 0 ? Math.round(totalScore / pages.length) : 0;

    return {
      id: "citation-readiness",
      name: "Citation readiness",
      category: "content-quality",
      status: score >= 50 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: `Citation readiness score: ${score}%`,
      severity: "info",
    };
  },
};

export const freshnessSignals: Check = {
  id: "freshness-signals",
  name: "Freshness signals",
  category: "content-quality",
  weight: 1,
  severity: "info",
  run: (pages) => {
    let pagesWithDates = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const hasDateInSchema = parsed.jsonLd.some((ld) => {
        const obj = ld as Record<string, unknown>;
        return obj.datePublished || obj.dateModified;
      });
      const hasDateMeta =
        parsed.$('meta[property="article:published_time"]').length > 0 ||
        parsed.$('meta[property="article:modified_time"]').length > 0;
      const hasTimeElement = parsed.$("time[datetime]").length > 0;

      if (hasDateInSchema || hasDateMeta || hasTimeElement) pagesWithDates++;
    }

    const score = pages.length > 0 ? Math.round((pagesWithDates / pages.length) * 100) : 0;

    return {
      id: "freshness-signals",
      name: "Freshness signals",
      category: "content-quality",
      status: score >= 50 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: `${pagesWithDates}/${pages.length} pages have date/freshness signals`,
      severity: "info",
    };
  },
};

export const authorAttribution: Check = {
  id: "author-attribution",
  name: "Author attribution",
  category: "content-quality",
  weight: 0.5,
  severity: "info",
  run: (pages) => {
    let pagesWithAuthor = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const hasAuthorSchema = parsed.jsonLd.some(
        (ld) => (ld as Record<string, unknown>).author !== undefined,
      );
      const hasAuthorMeta = parsed.$('meta[name="author"]').length > 0;
      const hasAuthorLink = parsed.$('[rel="author"]').length > 0;

      if (hasAuthorSchema || hasAuthorMeta || hasAuthorLink) pagesWithAuthor++;
    }

    const score = pages.length > 0 ? Math.round((pagesWithAuthor / pages.length) * 100) : 0;

    return {
      id: "author-attribution",
      name: "Author attribution",
      category: "content-quality",
      status: score >= 50 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message: `${pagesWithAuthor}/${pages.length} pages have author attribution`,
      severity: "info",
    };
  },
};

export const contentQualityChecks: Check[] = [
  answerFirst,
  tokenEfficiency,
  contentLength,
  listAndTableUsage,
  faqContent,
  citationReadiness,
  freshnessSignals,
  authorAttribution,
];
