import type { Check, FetchedPage } from "../../audit/types.js";

export const docusaurusSidebarCoverageCheck: Check = {
  id: "docusaurus-sidebar-coverage",
  name: "Docusaurus Sidebar Coverage",
  category: "content-quality",
  weight: 1,
  severity: "info",
  run(pages: FetchedPage[]) {
    // Check if sidebar navigation exists and covers docs
    const hasSidebar = pages.some(
      (p) =>
        p.html.includes("theme-doc-sidebar") ||
        p.html.includes("menu__list") ||
        p.html.includes("sidebar_"),
    );

    const docPages = pages.filter(
      (p) => p.url.includes("/docs/") || p.html.includes("theme-doc-markdown"),
    );

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: hasSidebar && docPages.length > 0 ? "pass" : "partial",
      score: hasSidebar && docPages.length > 0 ? 100 : 50,
      maxScore: 100,
      message: hasSidebar
        ? `Sidebar navigation found with ${docPages.length} doc pages — good for llms.txt structure`
        : "Sidebar navigation not detected — llms.txt section structure may be incomplete",
      details: !hasSidebar
        ? "Add sidebars.js/sidebars.ts to organize documentation for better AI discovery."
        : undefined,
    };
  },
};

export const docusaurusVersionedDocsCheck: Check = {
  id: "docusaurus-versioned-docs",
  name: "Docusaurus Versioned Docs Discovery",
  category: "agent-discovery",
  weight: 1,
  severity: "info",
  run(pages: FetchedPage[]) {
    const hasVersionDropdown = pages.some(
      (p) =>
        p.html.includes("docsVersionDropdown") ||
        p.html.includes("docs-version-") ||
        p.html.includes("version-"),
    );

    const versionedPaths = pages.filter(
      (p) => /\/docs\/\d+\.\d+/.test(p.url) || /\/docs\/next\//.test(p.url),
    );

    if (!hasVersionDropdown && versionedPaths.length === 0) {
      return {
        id: this.id,
        name: this.name,
        category: this.category,
        weight: this.weight,
        severity: this.severity,
        status: "skip",
        score: 100,
        maxScore: 100,
        message: "No versioned docs detected (single version is fine)",
      };
    }

    return {
      id: this.id,
      name: this.name,
      category: this.category,
      weight: this.weight,
      severity: this.severity,
      status: hasVersionDropdown ? "pass" : "partial",
      score: hasVersionDropdown ? 100 : 60,
      maxScore: 100,
      message: hasVersionDropdown
        ? `Versioned docs with version selector — AI agents can discover version-specific content`
        : `Versioned doc paths found (${versionedPaths.length}) but no version selector in navigation`,
    };
  },
};

export const docusaurusChecks: Check[] = [
  docusaurusSidebarCoverageCheck,
  docusaurusVersionedDocsCheck,
];
