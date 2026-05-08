import { parseHTML } from "../../shared/html-parser.js";
import type { Check } from "../types.js";

const JS_FRAMEWORK_MARKERS: { marker: string; name: string }[] = [
  { marker: "__NEXT_DATA__", name: "Next.js" },
  { marker: "window.__nuxt__", name: "Nuxt.js" },
  { marker: "ng-app", name: "Angular" },
  { marker: "ng-version", name: "Angular" },
  { marker: "data-reactroot", name: "React" },
  { marker: "data-v-app", name: "Vue" },
  { marker: "__svelte", name: "Svelte" },
  { marker: "ember-application", name: "Ember" },
];

function detectJsFrameworks(html: string): string[] {
  const detected = new Set<string>();
  for (const { marker, name } of JS_FRAMEWORK_MARKERS) {
    if (html.includes(marker)) detected.add(name);
  }
  return [...detected];
}

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

// Empty mount points used by SPA frameworks. The trailing `\s*</div>` requires
// an empty div in the source, so SSR pages that pre-hydrate content into the
// root are NOT classified as shells (they have content the agent can read).
const ROOT_MOUNT_RE = /<div[^>]*id=["'](?:__next|root|app|__nuxt)["'][^>]*>\s*<\/div>/i;
const REACTROOT_RE = /<div[^>]*data-reactroot[^>]*>\s*<\/div>/i;

// SPA-shell detection thresholds. All three signals must agree (AND).
// Calibrated against openai.com / anthropic.com / perplexity.ai homepages
// (true positives) and a sampling of mainstream tech-doc pages (true negatives).
const SHELL_MAX_ANCHORS = 5; // < 5 anchors with href → link-starved homepage
const SHELL_MAX_TEXT_RATIO = 0.2; // body-text-bytes / script-bytes < 0.2 → script-dominated
const TEXT_BYTES_PER_WORD = 5; // ~4.5 chars + 1 space; close enough for ratio purposes

function looksLikeSpaShell(html: string, parsed: { wordCount: number }): boolean {
  // Signal 1 (cheap): empty SPA mount point present?
  const hasRootMount = ROOT_MOUNT_RE.test(html) || REACTROOT_RE.test(html);
  if (!hasRootMount) return false;

  // Signal 2 (cheap): too few anchors with href to navigate without JS?
  const anchorCount = (html.match(/<a\s+[^>]*href=/gi) ?? []).length;
  if (anchorCount >= SHELL_MAX_ANCHORS) return false;

  // Signal 3: script weight dominates the page?
  // We compare wordCount-derived body text against full <script>...</script>
  // tag bytes. The wrapper ~18 bytes per tag is noise vs typical 5KB+ payloads.
  const scriptBytes = (html.match(/<script[\s\S]*?<\/script>/gi) ?? []).join("").length;
  const bodyTextBytes = parsed.wordCount * TEXT_BYTES_PER_WORD;
  if (scriptBytes === 0) return false;
  return bodyTextBytes / scriptBytes < SHELL_MAX_TEXT_RATIO;
}

export const noJsDependency: Check = {
  id: "no-js-dependency",
  name: "Content accessible without JS",
  category: "technical",
  weight: 1,
  severity: "warning",
  run: (pages) => {
    let goodPages = 0;
    const frameworksFound = new Set<string>();
    let shellPages = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const frameworks = detectJsFrameworks(page.html);
      for (const f of frameworks) frameworksFound.add(f);

      const isShell = looksLikeSpaShell(page.html, parsed);
      if (isShell) {
        shellPages++;
        continue;
      }

      const threshold = frameworks.length > 0 ? 100 : 50;
      if (parsed.wordCount >= threshold) goodPages++;
    }

    const score = pages.length > 0 ? Math.round((goodPages / pages.length) * 100) : 0;
    const frameworkList = [...frameworksFound].join(", ");
    const shellNote =
      shellPages > 0 ? ` (${shellPages}/${pages.length} pages are JS-only shells)` : "";

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
          : `Only ${goodPages}/${pages.length} pages have substantial content without JS rendering${shellNote}`,
      details: frameworkList ? `Detected JS frameworks: ${frameworkList}` : undefined,
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
