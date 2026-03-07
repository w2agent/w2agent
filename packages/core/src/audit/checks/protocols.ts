import { parseHTML } from "../../shared/html-parser.js";
import type { Check } from "../types.js";

export const mcpDiscovery: Check = {
  id: "mcp-discovery",
  name: "MCP endpoint",
  category: "agent-protocols",
  weight: 1.5,
  severity: "info",
  run: async (_pages, metadata) => {
    const wellKnownContent = metadata.wellKnown.mcp;
    const base = {
      id: "mcp-discovery" as const,
      name: "MCP endpoint",
      category: "agent-protocols" as const,
      maxScore: 100,
      weight: 1.5,
      severity: "info" as const,
    };

    if (!wellKnownContent) {
      return {
        ...base,
        status: "fail",
        score: 0,
        message: "No /.well-known/mcp endpoint found",
      };
    }

    // Endpoint exists — try to send an MCP initialize request
    try {
      const mcpUrl = `${metadata.baseUrl}/.well-known/mcp`;
      const initRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "w2agent-audit", version: "0.1.0" },
        },
      };

      const response = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(initRequest),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          ...base,
          status: "partial",
          score: 50,
          message: `MCP endpoint found but returned ${response.status} on initialize`,
          details: `POST /.well-known/mcp → ${response.status} ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      const body = await response.text();

      // Try to parse as JSON-RPC response
      const parsed = tryParseJsonRpc(body, contentType);

      if (parsed?.serverInfo) {
        const tools = parsed.tools || [];
        const resources = parsed.resources || [];
        const details = [
          `Server: ${parsed.serverInfo.name} v${parsed.serverInfo.version || "?"}`,
          tools.length > 0 ? `Tools: ${tools.join(", ")}` : "No tools listed",
          resources.length > 0 ? `Resources: ${resources.length}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        return {
          ...base,
          status: "pass",
          score: 100,
          message: `MCP server found: ${parsed.serverInfo.name} with ${tools.length} tool(s)`,
          details,
        };
      }

      // Got a response but couldn't parse it as valid MCP
      return {
        ...base,
        status: "partial",
        score: 50,
        message: "MCP endpoint found but returned invalid MCP response",
        details: `Content-Type: ${contentType}, body length: ${body.length}`,
      };
    } catch {
      // Endpoint exists but initialize request failed (timeout, network, etc.)
      return {
        ...base,
        status: "partial",
        score: 50,
        message: "MCP endpoint found but could not complete initialize handshake",
      };
    }
  },
};

interface McpParsedResponse {
  serverInfo: { name: string; version?: string };
  tools: string[];
  resources: string[];
}

function tryParseJsonRpc(body: string, contentType: string): McpParsedResponse | null {
  try {
    // Handle SSE format (text/event-stream)
    let jsonStr = body;
    if (contentType.includes("text/event-stream")) {
      const lines = body.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          jsonStr = line.slice(6);
          break;
        }
      }
    }

    const json = JSON.parse(jsonStr);
    const result = json.result;
    if (!result?.serverInfo?.name) return null;

    const tools: string[] = [];
    if (result.capabilities?.tools) {
      // Tools are listed in capabilities; names come from a tools/list call
      // For now just note that tools capability exists
    }

    return {
      serverInfo: result.serverInfo,
      tools,
      resources: [],
    };
  } catch {
    return null;
  }
}

export const apiEndpoints: Check = {
  id: "api-endpoints",
  name: "Discoverable API endpoints",
  category: "agent-protocols",
  weight: 1,
  severity: "info",
  run: (pages, _metadata) => {
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

export const wellKnownUcp: Check = {
  id: "well-known-ucp",
  name: "/.well-known/ucp",
  category: "agent-protocols",
  weight: 0.5,
  severity: "info",
  run: (_pages, metadata) => {
    const exists = !!metadata.wellKnown.ucp;

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
      message:
        pagesWithActions > 0
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
  run: (pages, _metadata) => {
    const indicators: string[] = [];

    // Check headers for auth-related info
    for (const page of pages) {
      if (page.headers["www-authenticate"]) indicators.push("WWW-Authenticate header");
      if (page.headers.link?.includes("oauth")) indicators.push("OAuth link header");
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
      message:
        score > 0
          ? "Authentication discovery mechanism found"
          : "No discoverable authentication mechanism",
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
          webmcpDetails.push(
            `${page.url}: <form toolname="${$form.attr("toolname")}">`
          );
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
      message: webmcpForms > 0
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
  authDiscovery,
  webmcpDeclarative,
  webmcpImperative,
];
