import { parseHTML } from "../../shared/html-parser.js";
import { parseJsonObject } from "../shared/json.js";
import type { Check } from "../types.js";

export const mcpDiscovery: Check = {
  id: "mcp-discovery",
  name: "MCP endpoint",
  category: "agent-protocols",
  weight: 1.5,
  severity: "info",
  run: (_pages, metadata) => {
    const base = {
      id: "mcp-discovery" as const,
      name: "MCP endpoint",
      category: "agent-protocols" as const,
      maxScore: 100,
      weight: 1.5,
      severity: "info" as const,
    };

    const endpoint = metadata.mcpEndpoint;
    if (endpoint === undefined) {
      return {
        ...base,
        status: "fail",
        score: 0,
        message: "No MCP endpoint found (tried homepage links, /mcp and mcp.<domain>)",
      };
    }
    const init = metadata.mcpInit;
    const details = `Endpoint: ${endpoint}`;
    if (init?.transport === "http+sse") {
      return {
        ...base,
        status: "partial",
        score: 50,
        message: "MCP endpoint uses the deprecated HTTP+SSE transport",
        details: init.status === 401 ? `${details} → 401` : details,
      };
    }
    if (init?.status === 401) {
      return {
        ...base,
        status: "pass",
        score: 75,
        message: "MCP endpoint requires auth (401 — OAuth or other auth expected)",
        details: `${details} → 401`,
      };
    }
    const server = init?.serverInfo;
    return {
      ...base,
      status: "pass",
      score: 100,
      message: server ? `MCP server found: ${server.name}` : "MCP server found",
      details: server ? `${details}\nServer: ${server.name} v${server.version || "?"}` : details,
    };
  },
};

export const apiEndpoints: Check = {
  id: "api-endpoints",
  name: "Discoverable API endpoints",
  category: "agent-protocols",
  weight: 1,
  severity: "info",
  run: (pages, _metadata) => {
    const indicators: string[] = [];

    // Check for OpenAPI / Swagger links and human-labeled API entry points (e.g. "API reference")
    const apiTextPattern =
      /\b(rest|graphql)\s+api\b|\bapi\s+(reference|docs?|documentation|explorer)\b/i;
    for (const page of pages) {
      const parsed = parseHTML(page.html);
      for (const link of parsed.links) {
        if (
          link.href.includes("openapi") ||
          link.href.includes("swagger") ||
          link.href.includes("api-docs") ||
          link.href.includes("graphql") ||
          apiTextPattern.test(link.text)
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
      message:
        score > 0
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

const UCP_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyObjectOfArrays(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every(Array.isArray);
}

function ucpProblems(raw: string | undefined): string[] {
  if (raw === undefined) return ["No UCP (Universal Commerce Protocol) profile found"];
  const ucp = parseJsonObject(raw)?.ucp;
  if (ucp === null || typeof ucp !== "object" || Array.isArray(ucp)) {
    return ["/.well-known/ucp is not a JSON object with a top-level `ucp` object"];
  }
  const { version, services, payment_handlers } = ucp as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof version !== "string" || !UCP_VERSION_RE.test(version)) {
    problems.push("`ucp.version` is missing or not a YYYY-MM-DD date");
  }
  if (!isNonEmptyObjectOfArrays(services)) {
    problems.push("`ucp.services` is missing, empty, or has non-array values");
  }
  if (!isNonEmptyObjectOfArrays(payment_handlers)) {
    problems.push("`ucp.payment_handlers` is missing, empty, or has non-array values");
  }
  return problems;
}

export const wellKnownUcp: Check = {
  id: "well-known-ucp",
  name: "/.well-known/ucp",
  category: "agent-protocols",
  weight: 0.5,
  severity: "info",
  run: (_pages, metadata) => {
    const problems = ucpProblems(metadata.wellKnown.ucp);
    const valid = problems.length === 0;

    return {
      id: "well-known-ucp",
      name: "/.well-known/ucp",
      category: "agent-protocols",
      status: valid ? "pass" : "fail",
      score: valid ? 100 : 0,
      maxScore: 100,
      weight: 0.5,
      message: valid
        ? "UCP profile found with version, services, and payment handlers"
        : problems.join("; "),
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
      message:
        pagesWithActions > 0
          ? `${pagesWithActions} page(s) have machine-readable action schemas`
          : "No action schemas found (SearchAction, OrderAction, etc.)",
      severity: "info",
    };
  },
};

export const webmcpDeclarative: Check = {
  id: "webmcp-declarative",
  name: "WebMCP declarative API",
  category: "agent-protocols",
  weight: 0.75,
  severity: "info",
  run: (pages) => {
    let totalForms = 0;
    let webmcpForms = 0;
    const webmcpDetails: string[] = [];

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const forms = parsed.$("form");
      totalForms += forms.length;

      forms.each((_, form) => {
        const $form = parsed.$(form);
        if ($form.attr("toolname")) {
          webmcpForms++;
          webmcpDetails.push(`${page.url}: <form toolname="${$form.attr("toolname")}">`);
        }
      });
    }

    const base = {
      id: "webmcp-declarative" as const,
      name: "WebMCP declarative API",
      category: "agent-protocols" as const,
      maxScore: 100,
      weight: 0.75,
      severity: "info" as const,
      fixSnippet: `<form toolname="searchFlights" tooldescription="Search available flights" toolautosubmit="true">
  <input type="text" name="origin" toolparamdescription="IATA airport code for departure" />
  <input type="text" name="destination" toolparamdescription="IATA airport code for arrival" />
</form>`,
    };

    if (totalForms === 0) {
      return { ...base, status: "skip", score: 100, message: "No forms found (not applicable)" };
    }

    const score = Math.round((webmcpForms / totalForms) * 100);

    return {
      ...base,
      status: score >= 80 ? "pass" : score > 0 ? "partial" : "fail",
      score,
      message:
        webmcpForms > 0
          ? `${webmcpForms}/${totalForms} forms have WebMCP attributes`
          : "No forms have WebMCP tool declarations",
      ...(webmcpDetails.length > 0 ? { details: webmcpDetails.join("\n") } : {}),
    };
  },
};

export const webmcpImperative: Check = {
  id: "webmcp-imperative",
  name: "WebMCP imperative API",
  category: "agent-protocols",
  weight: 0.5,
  severity: "info",
  run: (pages) => {
    const detectedPages: string[] = [];

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const scripts = parsed.$("script:not([src])");
      let found = false;

      scripts.each((_, script) => {
        if (found) return;
        const content = parsed.$(script).html() || "";
        if (
          content.includes("navigator.modelContext") ||
          content.includes("modelContext.registerTool")
        ) {
          found = true;
          detectedPages.push(page.url);
        }
      });
    }

    const found = detectedPages.length > 0;

    return {
      id: "webmcp-imperative",
      name: "WebMCP imperative API",
      category: "agent-protocols",
      status: found ? "pass" : "fail",
      score: found ? 100 : 0,
      maxScore: 100,
      weight: 0.5,
      message: found
        ? `WebMCP imperative API detected on ${detectedPages.length} page(s)`
        : "No navigator.modelContext usage found",
      severity: "info",
      ...(found ? { details: detectedPages.join("\n") } : {}),
      fixSnippet: `navigator.modelContext.registerTool({
  name: "addToCart",
  description: "Add a product to the shopping cart",
  inputSchema: {
    type: "object",
    properties: {
      productId: { type: "string", description: "Product ID" },
      quantity: { type: "number", description: "Quantity to add" },
    },
    required: ["productId"],
  },
  async execute(args) { /* implementation */ },
});`,
    };
  },
};

export const protocolChecks: Check[] = [
  mcpDiscovery,
  apiEndpoints,
  formsStructured,
  wellKnownUcp,
  actionSchemas,
  webmcpDeclarative,
  webmcpImperative,
];
