import type { Check } from "../types.js";
import { parseHTML } from "../../shared/html-parser.js";

export const mcpDiscovery: Check = {
  id: "mcp-discovery",
  name: "MCP endpoint",
  category: "agent-protocols",
  weight: 1.5,
  severity: "info",
  run: (_pages, metadata) => {
    const exists = !!metadata.wellKnown["mcp"];

    return {
      id: "mcp-discovery",
      name: "MCP endpoint",
      category: "agent-protocols",
      status: exists ? "pass" : "fail",
      score: exists ? 100 : 0,
      maxScore: 100,
      weight: 1.5,
      message: exists
        ? "MCP discovery endpoint found"
        : "No /.well-known/mcp endpoint found",
      severity: "info",
    };
  },
};

export const apiEndpoints: Check = {
  id: "api-endpoints",
  name: "Discoverable API endpoints",
  category: "agent-protocols",
  weight: 1,
  severity: "info",
  run: (pages, metadata) => {
    const indicators: string[] = [];

    // Check for OpenAPI / Swagger links
    for (const page of pages) {
      const parsed = parseHTML(page.html);
      for (const link of parsed.links) {
        if (
          link.href.includes("openapi") ||
          link.href.includes("swagger") ||
          link.href.includes("api-docs") ||
          link.href.includes("graphql")
        ) {
          indicators.push(link.href);
        }
      }
    }

    // Check for common API meta tags
    for (const page of pages) {
      const parsed = parseHTML(page.html);
      if (parsed.$('link[rel="api"]').length > 0) {
        indicators.push("link[rel=api]");
      }
    }

    const score = indicators.length > 0 ? 100 : 0;

    return {
      id: "api-endpoints",
      name: "Discoverable API endpoints",
      category: "agent-protocols",
      status: score > 0 ? "pass" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: score > 0
        ? `Found ${indicators.length} API endpoint reference(s)`
        : "No discoverable API endpoints (OpenAPI, GraphQL, etc.)",
      severity: "info",
    };
  },
};

export const formsStructured: Check = {
  id: "forms-structured",
  name: "Structured forms",
  category: "agent-protocols",
  weight: 1,
  severity: "info",
  run: (pages) => {
    let totalForms = 0;
    let wellStructuredForms = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const forms = parsed.$("form");
      totalForms += forms.length;

      forms.each((_, form) => {
        const $form = parsed.$(form);
        const inputs = $form.find("input, select, textarea");
        let hasLabels = true;
        let hasNames = true;

        inputs.each((_, input) => {
          const $input = parsed.$(input);
          const type = $input.attr("type");
          if (type === "hidden" || type === "submit") return;

          if (!$input.attr("name")) hasNames = false;
          const id = $input.attr("id");
          const hasLabel = id
            ? parsed.$(`label[for="${id}"]`).length > 0
            : $input.closest("label").length > 0;
          const hasAria = $input.attr("aria-label") || $input.attr("aria-labelledby");
          if (!hasLabel && !hasAria) hasLabels = false;
        });

        if (hasLabels && hasNames) wellStructuredForms++;
      });
    }

    if (totalForms === 0) {
      return {
        id: "forms-structured",
        name: "Structured forms",
        category: "agent-protocols",
        status: "skip",
        score: 100,
        maxScore: 100,
        weight: 1,
        message: "No forms found (not applicable)",
        severity: "info",
      };
    }

    const score = Math.round((wellStructuredForms / totalForms) * 100);

    return {
      id: "forms-structured",
      name: "Structured forms",
      category: "agent-protocols",
      status: score >= 80 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: `${wellStructuredForms}/${totalForms} forms have proper labels and names`,
      severity: score < 50 ? "warning" : "info",
    };
  },
};

export const wellKnownUcp: Check = {
  id: "well-known-ucp",
  name: "/.well-known/ucp",
  category: "agent-protocols",
  weight: 0.5,
  severity: "info",
  run: (_pages, metadata) => {
    const exists = !!metadata.wellKnown["ucp"];

    return {
      id: "well-known-ucp",
      name: "/.well-known/ucp",
      category: "agent-protocols",
      status: exists ? "pass" : "fail",
      score: exists ? 100 : 0,
      maxScore: 100,
      weight: 0.5,
      message: exists
        ? "UCP endpoint found"
        : "No UCP (Universal Commerce Protocol) endpoint found",
      severity: "info",
    };
  },
};

export const actionSchemas: Check = {
  id: "action-schemas",
  name: "Action schemas",
  category: "agent-protocols",
  weight: 1,
  severity: "info",
  run: (pages) => {
    let pagesWithActions = 0;

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const hasActionSchema = parsed.jsonLd.some((ld) => {
        const obj = ld as Record<string, unknown>;
        return (
          obj?.potentialAction !== undefined ||
          obj?.["@type"] === "SearchAction" ||
          obj?.["@type"] === "OrderAction"
        );
      });

      if (hasActionSchema) pagesWithActions++;
    }

    const score = pagesWithActions > 0 ? Math.min(100, pagesWithActions * 33) : 0;

    return {
      id: "action-schemas",
      name: "Action schemas",
      category: "agent-protocols",
      status: score > 0 ? "pass" : "fail",
      score,
      maxScore: 100,
      weight: 1,
      message: pagesWithActions > 0
        ? `${pagesWithActions} page(s) have machine-readable action schemas`
        : "No action schemas found (SearchAction, OrderAction, etc.)",
      severity: "info",
    };
  },
};

export const authDiscovery: Check = {
  id: "auth-discovery",
  name: "Auth discovery",
  category: "agent-protocols",
  weight: 0.5,
  severity: "info",
  run: (pages, metadata) => {
    const indicators: string[] = [];

    // Check headers for auth-related info
    for (const page of pages) {
      if (page.headers["www-authenticate"]) indicators.push("WWW-Authenticate header");
      if (page.headers["link"]?.includes("oauth")) indicators.push("OAuth link header");
    }

    // Check for OAuth/auth links in pages
    for (const page of pages) {
      const parsed = parseHTML(page.html);
      for (const link of parsed.links) {
        if (
          link.href.includes("oauth") ||
          link.href.includes("authorize") ||
          link.href.includes("openid-configuration")
        ) {
          indicators.push(link.href);
          break;
        }
      }
    }

    // Check .well-known for OpenID
    // This is a lightweight check — just see if any auth-related .well-known hints exist

    const score = indicators.length > 0 ? 100 : 0;

    return {
      id: "auth-discovery",
      name: "Auth discovery",
      category: "agent-protocols",
      status: score > 0 ? "pass" : "fail",
      score,
      maxScore: 100,
      weight: 0.5,
      message: score > 0
        ? "Authentication discovery mechanism found"
        : "No discoverable authentication mechanism",
      severity: "info",
    };
  },
};

export const protocolChecks: Check[] = [
  mcpDiscovery,
  apiEndpoints,
  formsStructured,
  wellKnownUcp,
  actionSchemas,
  authDiscovery,
];
