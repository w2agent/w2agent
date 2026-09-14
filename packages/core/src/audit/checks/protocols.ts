import { Buffer } from "node:buffer";
import type { CheerioAPI } from "cheerio";
import { guardedFetch, type IsAllowedTarget, readBodyCapped } from "../../shared/fetcher.js";
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

type CheerioNode = ReturnType<CheerioAPI>;

const NON_FIELD_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
const SEARCH_FIELD_NAMES = new Set(["q", "query", "s"]);

type FormKind = "task" | "search" | "login" | "newsletter";

function lowerAttr($el: CheerioNode, name: string, fallback = ""): string {
  return ($el.attr(name) ?? fallback).trim().toLowerCase();
}

function classifyForm($: CheerioAPI, $form: CheerioNode): FormKind {
  const inputs = $form
    .find("input")
    .toArray()
    .map((el) => $(el));
  const inputType = ($input: CheerioNode) => lowerAttr($input, "type", "text") || "text";

  if (
    lowerAttr($form, "role") === "search" ||
    $form.closest("search").length > 0 ||
    inputs.some(($input) => inputType($input) === "search")
  ) {
    return "search";
  }
  if (inputs.some(($input) => inputType($input) === "password")) return "login";

  const fieldInputs = inputs.filter(($input) => !NON_FIELD_INPUT_TYPES.has(inputType($input)));
  const textInputs = fieldInputs.filter(($input) => inputType($input) === "text");
  if (textInputs.length === 1 && SEARCH_FIELD_NAMES.has(lowerAttr(textInputs[0], "name"))) {
    return "search";
  }
  const fieldCount = fieldInputs.length + $form.find("select, textarea").length;
  if (fieldCount === 1 && fieldInputs.length === 1 && inputType(fieldInputs[0]) === "email") {
    return "newsletter";
  }
  return "task";
}

export const webmcpDeclarative: Check = {
  id: "webmcp-declarative",
  name: "WebMCP declarative API",
  category: "agent-protocols",
  weight: 0,
  severity: "info",
  tracked: true,
  run: (pages) => {
    let taskForms = 0;
    let taskToolForms = 0;
    let excludedToolForms = 0;
    const webmcpDetails: string[] = [];

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      parsed.$("form").each((_, form) => {
        const $form = parsed.$(form);
        const kind = classifyForm(parsed.$, $form);
        if (kind === "task") taskForms++;
        const toolname = $form.attr("toolname");
        if (!toolname) return;
        if (kind === "task") taskToolForms++;
        else excludedToolForms++;
        const note = kind === "task" ? "" : ` (${kind} form, not counted as a task form)`;
        webmcpDetails.push(`${page.url}: <form toolname="${toolname}">${note}`);
      });
    }

    const base = {
      id: "webmcp-declarative" as const,
      name: "WebMCP declarative API",
      category: "agent-protocols" as const,
      maxScore: 100,
      weight: 0,
      severity: "info" as const,
      tracked: true,
      fixSnippet: `<form toolname="searchFlights" tooldescription="Search available flights" toolautosubmit>
  <input type="text" name="origin" toolparamdescription="IATA airport code for departure" />
  <input type="text" name="destination" toolparamdescription="IATA airport code for arrival" />
</form>`,
    };

    if (webmcpDetails.length === 0) {
      return {
        ...base,
        status: "skip",
        score: 0,
        message: "No WebMCP form tool declarations found",
      };
    }

    const excludedNote =
      excludedToolForms > 0 ? ` (+${excludedToolForms} search/login/newsletter form(s))` : "";
    return {
      ...base,
      status: "pass",
      score: 100,
      message: `${taskToolForms}/${taskForms} task forms declare WebMCP tools${excludedNote}`,
      details: webmcpDetails.join("\n"),
    };
  },
};

const WEBMCP_SCRIPT_PATTERN =
  /\b(?:document|navigator)\s*\??\.\s*modelContext\b|\[\s*["'`]modelContext["'`]\s*\]|\bmodelContext\s*\??\.\s*registerTool\b/;
const MAX_EXTERNAL_SCRIPTS = 5;
const MAX_SCRIPT_BYTES = 256 * 1024;
const SCRIPT_TIMEOUT_MS = 5000;
const OT_HEADER_BYTES = 1 + 64 + 4;
const WEBMCP_OT_FEATURE = /webmcp|modelcontext/i;

function originTrialFeature(token: string): string | undefined {
  const buf = Buffer.from(token.trim(), "base64");
  if (buf.length < OT_HEADER_BYTES) return undefined;
  const length = buf.readUInt32BE(OT_HEADER_BYTES - 4);
  if (OT_HEADER_BYTES + length > buf.length) return undefined;
  try {
    const payload: unknown = JSON.parse(
      buf.subarray(OT_HEADER_BYTES, OT_HEADER_BYTES + length).toString("utf8"),
    );
    const feature = (payload as Record<string, unknown> | null)?.feature;
    return typeof feature === "string" && WEBMCP_OT_FEATURE.test(feature) ? feature : undefined;
  } catch {
    return undefined;
  }
}

async function scriptHasWebmcp(url: string, isAllowedTarget?: IsAllowedTarget): Promise<boolean> {
  try {
    const res = await guardedFetch(
      url,
      { signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS) },
      isAllowedTarget,
    );
    const declared = Number(res.headers.get("content-length"));
    if (res.status < 200 || res.status >= 300 || declared > MAX_SCRIPT_BYTES) {
      await res.body?.cancel().catch(() => {});
      return false;
    }
    return WEBMCP_SCRIPT_PATTERN.test(await readBodyCapped(res, MAX_SCRIPT_BYTES));
  } catch {
    return false;
  }
}

export const webmcpImperative: Check = {
  id: "webmcp-imperative",
  name: "WebMCP imperative API",
  category: "agent-protocols",
  weight: 0,
  severity: "info",
  tracked: true,
  run: async (pages, metadata, ctx) => {
    const found: string[] = [];
    const trialFeatures: string[] = [];
    const externalScripts: string[] = [];
    let origin: string | undefined;
    try {
      origin = new URL(metadata.baseUrl).origin;
    } catch {}

    for (const page of pages) {
      const parsed = parseHTML(page.html);
      const inline = parsed
        .$("script:not([src])")
        .toArray()
        .some((script) => WEBMCP_SCRIPT_PATTERN.test(parsed.$(script).html() ?? ""));
      if (inline) found.push(`inline script on ${page.url}`);

      parsed.$("meta[http-equiv][content]").each((_, meta) => {
        const $meta = parsed.$(meta);
        if (lowerAttr($meta, "http-equiv") !== "origin-trial") return;
        const feature = originTrialFeature($meta.attr("content") ?? "");
        if (feature) trialFeatures.push(`origin-trial token for ${feature} on ${page.url}`);
      });

      parsed.$("script[src]").each((_, script) => {
        try {
          const src = new URL(parsed.$(script).attr("src") ?? "", page.url);
          if (src.protocol !== "http:" && src.protocol !== "https:") return;
          if (src.origin !== origin || externalScripts.includes(src.href)) return;
          externalScripts.push(src.href);
        } catch {}
      });
    }

    if (found.length === 0) {
      const scripts = externalScripts.slice(0, MAX_EXTERNAL_SCRIPTS);
      const hits = await Promise.all(
        scripts.map((url) => scriptHasWebmcp(url, ctx?.isAllowedTarget)),
      );
      scripts.forEach((url, i) => {
        if (hits[i]) found.push(`script ${url}`);
      });
    }

    const base = {
      id: "webmcp-imperative" as const,
      name: "WebMCP imperative API",
      category: "agent-protocols" as const,
      maxScore: 100,
      weight: 0,
      severity: "info" as const,
      tracked: true,
      fixSnippet: `const mc = document.modelContext ?? navigator.modelContext;
mc?.registerTool({
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

    if (found.length === 0 && trialFeatures.length === 0) {
      return {
        ...base,
        status: "skip",
        score: 0,
        message: "No WebMCP tool registration (document.modelContext) found",
      };
    }

    const details = [...found, ...trialFeatures];
    if (found.length === 0) details.push("origin-trial token only, no registration code found");
    return {
      ...base,
      status: "pass",
      score: 100,
      message:
        found.length > 0
          ? `WebMCP tool registration code found in ${found.length} place(s)`
          : "WebMCP origin-trial token found (no registration code found)",
      details: details.join("\n"),
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
