import { parseHTML } from "../../shared/html-parser.js";
import type { Check } from "../types.js";

export const httpsCheck: Check = {
  id: "https",
  name: "HTTPS",
  category: "technical",
  weight: 2,
  severity: "error",
  run: (pages) => {
    const allHttps = pages.every((p) => p.url.startsWith("https://"));

    return {
      id: "https",
      name: "HTTPS",
      category: "technical",
      status: allHttps ? "pass" : "fail",
      score: allHttps ? 100 : 0,
      maxScore: 100,
      weight: 2,
      message: allHttps ? "All pages use HTTPS" : "Some pages not using HTTPS",
      severity: allHttps ? "info" : "error",
    };
  },
};

export const securityHeaders: Check = {
  id: "security-headers",
  name: "Security headers",
  category: "technical",
  weight: 1,
  severity: "warning",
  run: (pages) => {
    if (pages.length === 0) {
      return {
        id: "security-headers",
        name: "Security headers",
        category: "technical",
        status: "skip",
        score: 0,
        maxScore: 100,
        weight: 1,
        message: "No pages to check",
        severity: "warning",
      };
    }

    const headers = pages[0].headers;
    const checks = [
      { name: "content-security-policy", present: !!headers["content-security-policy"] },
      { name: "x-frame-options", present: !!headers["x-frame-options"] },
      { name: "x-content-type-options", present: !!headers["x-content-type-options"] },
      { name: "strict-transport-security", present: !!headers["strict-transport-security"] },
    ];

    const present = checks.filter((c) => c.present).length;
    const score = Math.round((present / checks.length) * 100);

    return {
      id: "security-headers",
      name: "Security headers",
      category: "technical",
      status: score >= 75 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: `${present}/${checks.length} security headers present`,
      details: checks.map((c) => `${c.present ? "✓" : "✗"} ${c.name}`).join("\n"),
      severity: score < 50 ? "warning" : "info",
    };
  },
};

export const canonicalUrls: Check = {
  id: "canonical-urls",
  name: "Canonical URLs",
  category: "technical",
  weight: 1,
  severity: "warning",
  run: (pages) => {
    let pagesWithCanonical = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      if (parsed.canonical) pagesWithCanonical++;
    }

    const score = pages.length > 0 ? Math.round((pagesWithCanonical / pages.length) * 100) : 0;

    return {
      id: "canonical-urls",
      name: "Canonical URLs",
      category: "technical",
      status: score >= 80 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: `${pagesWithCanonical}/${pages.length} pages have canonical URLs`,
      severity: score < 50 ? "warning" : "info",
      fixSnippet:
        score < 100
          ? `<!-- Add to <head> -->\n<link rel="canonical" href="https://yoursite.com/current-page" />`
          : undefined,
    };
  },
};

export const mobileViewport: Check = {
  id: "mobile-viewport",
  name: "Mobile viewport",
  category: "technical",
  weight: 0.5,
  severity: "warning",
  run: (pages) => {
    let pagesWithViewport = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      if (parsed.viewport) pagesWithViewport++;
    }

    const score = pages.length > 0 ? Math.round((pagesWithViewport / pages.length) * 100) : 0;

    return {
      id: "mobile-viewport",
      name: "Mobile viewport",
      category: "technical",
      status: score >= 80 ? "pass" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message: `${pagesWithViewport}/${pages.length} pages have viewport meta tag`,
      severity: score < 80 ? "warning" : "info",
    };
  },
};

export const charsetUtf8: Check = {
  id: "charset-utf8",
  name: "UTF-8 charset",
  category: "technical",
  weight: 0.5,
  severity: "warning",
  run: (pages) => {
    let pagesWithCharset = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const hasCharsetMeta = parsed.charset?.toLowerCase() === "utf-8";
      const hasCharsetHeader = page.headers["content-type"]?.toLowerCase().includes("utf-8");
      if (hasCharsetMeta || hasCharsetHeader) pagesWithCharset++;
    }

    const score = pages.length > 0 ? Math.round((pagesWithCharset / pages.length) * 100) : 0;

    return {
      id: "charset-utf8",
      name: "UTF-8 charset",
      category: "technical",
      status: score >= 80 ? "pass" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message: `${pagesWithCharset}/${pages.length} pages declare UTF-8 charset`,
      severity: score < 80 ? "warning" : "info",
    };
  },
};

export const noJsDependency: Check = {
  id: "no-js-dependency",
  name: "Content accessible without JS",
  category: "technical",
  weight: 1,
  severity: "warning",
  run: (pages) => {
    let goodPages = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      // If we can extract meaningful text via cheerio (no JS execution),
      // the content is at least partially accessible without JS
      if (parsed.wordCount >= 50) {
        goodPages++;
      }
    }

    const score = pages.length > 0 ? Math.round((goodPages / pages.length) * 100) : 0;

    return {
      id: "no-js-dependency",
      name: "Content accessible without JS",
      category: "technical",
      status: score >= 70 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message:
        score >= 70
          ? "Content is accessible without JavaScript"
          : `Only ${goodPages}/${pages.length} pages have substantial content without JS rendering`,
      severity: score < 50 ? "warning" : "info",
    };
  },
};

export const technicalChecks: Check[] = [
  httpsCheck,
  securityHeaders,
  canonicalUrls,
  mobileViewport,
  charsetUtf8,
  noJsDependency,
];
