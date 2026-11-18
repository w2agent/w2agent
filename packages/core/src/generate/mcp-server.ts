import type { OpenAPIEndpoint, OpenAPIParameter } from "../audit/types.js";
import { resolveOpenapiServerUrl } from "../shared/openapi.js";
import { isOriginAllowed } from "../shared/url-policy.js";
import type { EcommerceArtifacts } from "./ecommerce.js";
import { generateCommerceToolHandlers } from "./ecommerce.js";
import { generateFaq } from "./faq.js";
import type { FormFieldSpec, FormToolSpec } from "./form-tools.js";
import { formContractKey, formRequestUrl, formToolSpec } from "./form-tools.js";
import { extractSiteInfo } from "./llms-txt.js";
import type { LocalBusinessArtifacts } from "./local-business.js";
import { generateLocalBusinessToolHandlers } from "./local-business.js";
import { mdText, mdUrl } from "./markdown-text.js";
import type { SearchActionTemplate } from "./search-action.js";
import { findCrawledSearchAction } from "./search-action.js";
import type { ExtractedFormField, GenerateContext, GeneratedFile, PageMarkdown } from "./types.js";

// --- Types ---

export interface McpTool {
  name: string;
  description: string;
  condition: string;
}

export interface McpDetectedTools {
  tools: McpTool[];
  hasFaq: boolean;
  hasSearchAction: boolean;
  searchAction?: SearchActionTemplate;
  hasProducts: boolean;
  hasLocalBusiness: boolean;
  hasOpenapi: boolean;
  openapiEndpoints: OpenAPIEndpoint[];
  openapiServerUrl?: string;
  forms: DetectedForm[];
}

export interface DetectedForm {
  action: string;
  method: string;
  fields: ExtractedFormField[];
  pageUrl: string;
  resolvedAction: string;
  toolSpec: FormToolSpec;
  id?: string;
  name?: string;
}

export type SelfHostPlatform = "vercel" | "cf";

// --- Public API ---

export function generateMcpServer(
  ctx: GenerateContext,
  selfHost?: SelfHostPlatform,
  artifacts?: EcommerceArtifacts | null,
  localBusinessArtifacts?: LocalBusinessArtifacts | null,
): GeneratedFile[] {
  const { siteName } = extractSiteInfo(ctx.pages, ctx.baseUrl);
  const detected = detectTools(ctx, artifacts, localBusinessArtifacts);
  const dataFiles = generateDataFiles(ctx, artifacts, localBusinessArtifacts);

  if (selfHost === "vercel") {
    return generateVercelTemplate(siteName, ctx.baseUrl, detected, dataFiles);
  }
  if (selfHost === "cf") {
    return generateCloudflareTemplate(siteName, ctx.baseUrl, detected, dataFiles);
  }

  // Default: standalone Express server
  const serverTs = generateServerTs(siteName, ctx.baseUrl, detected);
  const packageJson = generatePackageJson(siteName);
  const tsconfig = generateTsConfig();
  const readme = generateReadme(siteName, detected, ctx.baseUrl, "express");

  const files: GeneratedFile[] = [
    makeFile("mcp-server/server.ts", serverTs),
    makeFile("mcp-server/package.json", packageJson),
    makeFile("mcp-server/tsconfig.json", tsconfig),
    makeFile("mcp-server/README.md", readme),
    ...dataFiles,
  ];

  return files;
}

// --- Tool Detection ---

const BUILTIN_TOOL_NAMES = [
  "list-pages",
  "get-page",
  "search-site",
  "search-faq",
  "site-search",
  "search-products",
  "get-product",
  "check-inventory",
  "get-reviews",
  "get-hours",
  "get-menu",
  "get-services",
  "book-appointment",
];

// A spec path key is untrusted: concatenated onto the server URL it must not be
// able to rewrite the authority ("@host", ".evil.test", "{id}" at the start).
function isEndpointOnOrigin(serverUrl: string, path: string): boolean {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  // "#", "?", "\\" and control/whitespace chars are rewritten or dropped by the URL parser,
  // which would hide a dot segment from the runtime path check.
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (ch === "#" || ch === "?" || ch === "\\" || code <= 0x20 || code === 0x7f) return false;
  }
  try {
    return new URL(serverUrl + path).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

function isTakenName(name: string, usedNames: Set<string>): boolean {
  return usedNames.has(name) || name in Object.prototype;
}

function claimName(base: string, usedNames: Set<string>): string {
  let name = base;
  let counter = 2;
  while (isTakenName(name, usedNames)) name = `${base}-${counter++}`;
  usedNames.add(name);
  return name;
}

function inferFormToolName(form: DetectedForm, index: number, usedNames: Set<string>): string {
  let base: string | undefined;

  if (form.id) {
    base = form.id;
  } else if (form.name) {
    base = form.name;
  } else {
    const segment = form.action
      .split("/")
      .filter((s) => s && s !== "#")
      .pop()
      ?.split("?")[0];
    if (segment) base = segment;
  }

  const slugged = base
    ? base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 45)
    : "";
  const sanitized = slugged ? `submit-${slugged}` : `submit-form-${index}`;

  return claimName(sanitized, usedNames);
}

function inferOpenapiToolName(ep: OpenAPIEndpoint, usedNames: Set<string>): string {
  const fromOperationId = ep.operationId
    ? ep.operationId
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50)
    : "";
  const base =
    fromOperationId ||
    `${ep.method.toLowerCase().replace(/[^a-z0-9]+/g, "") || "call"}-${
      ep.path
        .replace(/[{}]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9/]+/g, "-")
        .replace(/\/+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 45) || "root"
    }`;
  return claimName(base, usedNames);
}

export function detectTools(
  ctx: GenerateContext,
  artifacts?: EcommerceArtifacts | null,
  localBusinessArtifacts?: LocalBusinessArtifacts | null,
): McpDetectedTools {
  const tools: McpTool[] = [];
  let hasFaq = false;
  let hasSearchAction = false;
  const forms: DetectedForm[] = [];

  // Always available
  tools.push({
    name: "list-pages",
    description: "List all pages on the site with titles and URLs",
    condition: "always",
  });
  tools.push({
    name: "get-page",
    description: "Get the full markdown content of a specific page by URL or slug",
    condition: "always",
  });
  tools.push({
    name: "search-site",
    description: "Search site content by keywords with weighted scoring",
    condition: "always",
  });

  // Check for FAQ content
  const faqData = generateFaq(ctx);
  if (faqData && faqData.mainEntity.length > 0) {
    hasFaq = true;
    tools.push({
      name: "search-faq",
      description: "Search FAQ question/answer pairs",
      condition: "hasFaqContent",
    });
  }

  const baseOrigin = (() => {
    try {
      return new URL(ctx.baseUrl).origin;
    } catch {
      return ctx.baseUrl;
    }
  })();

  // Check for SearchAction in JSON-LD (the site's own template, never fetched server-side)
  const searchAction =
    findCrawledSearchAction(ctx.rawPages, baseOrigin, ctx.allowedOffOriginHosts) ?? undefined;
  if (searchAction) {
    hasSearchAction = true;
    tools.push({
      name: "site-search",
      description: "Get the site's native search URL for a query (via SearchAction)",
      condition: "hasSearchAction",
    });
  }
  // Collect pre-extracted forms from pages. Filter out forms whose resolved
  // action would steer the generated server off-origin or to a private IP,
  // unless the operator allowlisted the target host. Without this check, a
  // crawled page with `<form action="http://169.254.169.254/…">` would let an
  // attacker turn the generated MCP server into an SSRF / proxy surface.
  // Identical forms repeated across pages (a site-wide search box) become one tool.
  const seenForms = new Set<string>();
  for (const page of ctx.pages) {
    if (page.forms) {
      for (const form of page.forms) {
        let resolved: URL | null = null;
        try {
          resolved = new URL(form.action, page.url);
        } catch {
          continue;
        }
        if (!isOriginAllowed(resolved.href, baseOrigin, ctx.allowedOffOriginHosts)) continue;
        const toolSpec = formToolSpec(form);
        if (!toolSpec) continue;
        const requestUrl = formRequestUrl(resolved, toolSpec.method);
        if (!requestUrl) continue;
        const key = formContractKey(requestUrl, toolSpec);
        if (seenForms.has(key)) continue;
        seenForms.add(key);
        forms.push({
          ...form,
          method: toolSpec.method,
          pageUrl: page.url,
          resolvedAction: requestUrl,
          toolSpec,
        });
      }
    }
  }

  // Add form tools
  const usedFormNames = new Set<string>();
  forms.forEach((form, i) => {
    const fieldNames = form.toolSpec.fields.map((f) => f.name).join(", ");
    tools.push({
      name: inferFormToolName(form, i, usedFormNames),
      description: `Submit form (${form.method} ${form.action}) with fields: ${fieldNames}`,
      condition: "hasForm",
    });
  });

  const hasProducts = !!artifacts && artifacts.products.length > 0;
  if (hasProducts) {
    tools.push({
      name: "search-products",
      description: "Search products by name, category, or description",
      condition: "hasProducts",
    });
    tools.push({
      name: "get-product",
      description: "Get full product details by product ID",
      condition: "hasProducts",
    });
    tools.push({
      name: "check-inventory",
      description: "Check product availability and price by product ID",
      condition: "hasProducts",
    });
    tools.push({
      name: "get-reviews",
      description: "Get aggregate rating and review count for a product",
      condition: "hasProducts",
    });
  }

  const hasLocalBusiness = !!localBusinessArtifacts;
  if (hasLocalBusiness) {
    const { business } = localBusinessArtifacts;
    tools.push({
      name: "get-hours",
      description: "Get business hours and opening times",
      condition: "hasLocalBusiness",
    });
    if (business.menu) {
      tools.push({
        name: "get-menu",
        description: "Get the menu URL for this business",
        condition: "hasLocalBusiness",
      });
    }
    if (business.services) {
      tools.push({
        name: "get-services",
        description: "Get the services page URL for this business",
        condition: "hasLocalBusiness",
      });
    }
    if (business.bookingUrl) {
      tools.push({
        name: "book-appointment",
        description: "Get booking URL and instructions for scheduling an appointment",
        condition: "hasLocalBusiness",
      });
    }
  }

  // OpenAPI endpoint tools (cap at 20)
  let hasOpenapi = false;
  const openapiEndpoints: OpenAPIEndpoint[] = [];
  let openapiServerUrl: string | undefined;
  const rawServerUrl = ctx.metadata.openapi?.serverUrl;
  const resolvedServerUrl = rawServerUrl
    ? resolveOpenapiServerUrl(rawServerUrl, ctx.baseUrl, ctx.allowedOffOriginHosts)
    : ctx.baseUrl;
  // An unresolvable or policy-rejected server URL drops the OpenAPI tools
  // rather than falling back to the site origin, which would silently send
  // calls to a host the spec never named.
  const safeEndpoints = resolvedServerUrl
    ? (ctx.metadata.openapi?.endpoints ?? []).filter((ep) =>
        isEndpointOnOrigin(resolvedServerUrl, ep.path),
      )
    : [];
  if (safeEndpoints.length > 0 && resolvedServerUrl) {
    hasOpenapi = true;
    openapiServerUrl = resolvedServerUrl;
    const usedOpenapiNames = new Set<string>([...BUILTIN_TOOL_NAMES, ...tools.map((t) => t.name)]);
    const capped = safeEndpoints.slice(0, 20);
    for (const ep of capped) {
      openapiEndpoints.push(ep);
      const toolName = inferOpenapiToolName(ep, usedOpenapiNames);
      const desc = ep.summary || ep.description || `${ep.method.toUpperCase()} ${ep.path}`;
      tools.push({ name: toolName, description: desc, condition: "hasOpenapi" });
    }
  }

  return {
    tools,
    hasFaq,
    hasSearchAction,
    searchAction,
    hasProducts,
    hasLocalBusiness,
    hasOpenapi,
    openapiEndpoints,
    openapiServerUrl,
    forms,
  };
}

// --- Data File Generation ---

export function generateDataFiles(
  ctx: GenerateContext,
  artifacts?: EcommerceArtifacts | null,
  localBusinessArtifacts?: LocalBusinessArtifacts | null,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // pages.json
  const pagesData: PageMarkdown[] = ctx.pages.map((p) => ({
    url: p.url,
    title: p.title,
    description: p.description,
    markdown: p.markdown,
  }));
  files.push(makeFile("mcp-server/data/pages.json", `${JSON.stringify(pagesData, null, 2)}\n`));

  // faq.json (if detected)
  const faqData = generateFaq(ctx);
  if (faqData) {
    files.push(makeFile("mcp-server/data/faq.json", `${JSON.stringify(faqData, null, 2)}\n`));
  }

  // openapi.json (if detected)
  if (ctx.metadata.openapi) {
    files.push(
      makeFile(
        "mcp-server/data/openapi.json",
        `${JSON.stringify(ctx.metadata.openapi, null, 2)}\n`,
      ),
    );
  }

  // products.json (if e-commerce)
  if (artifacts && artifacts.products.length > 0) {
    files.push(
      makeFile("mcp-server/data/products.json", `${JSON.stringify(artifacts.products, null, 2)}\n`),
    );
  }

  // business.json (if local business)
  if (localBusinessArtifacts) {
    files.push(
      makeFile(
        "mcp-server/data/business.json",
        `${JSON.stringify(localBusinessArtifacts.business, null, 2)}\n`,
      ),
    );
  }

  return files;
}

// --- OpenAPI Tool Handler Generation ---

function reservedToolNames(detected: McpDetectedTools): string[] {
  return [
    ...BUILTIN_TOOL_NAMES,
    ...detected.tools.filter((t) => t.condition !== "hasOpenapi").map((t) => t.name),
  ];
}

interface AllocatedInputs {
  path: Array<{ p: OpenAPIParameter; key: string }>;
  query: Array<{ p: OpenAPIParameter; key: string }>;
  body: Array<{ name: string; def: { type?: string; description?: string }; key: string }>;
}

// One tool-input key per wire parameter. Path, query and body share one flat input object, so
// the first claimant of a raw name (path, then query, then body) keeps it and every later
// duplicate gets "<name>_<location>" (then "_2", "_3", ...) that no raw name already uses.
function allocateInputKeys(ep: OpenAPIEndpoint): AllocatedInputs {
  const path = ep.parameters.filter((p) => p.in === "path").map((p) => ({ p, key: "" }));
  const query = ep.parameters.filter((p) => p.in === "query").map((p) => ({ p, key: "" }));
  const body = (ep.requestBody ? Object.entries(ep.requestBody.properties) : []).map(
    ([name, def]) => ({ name, def, key: "" }),
  );
  const entries: Array<{ loc: string; name: string; item: { key: string } }> = [
    ...path.map((item) => ({ loc: "path", name: item.p.name, item })),
    ...query.map((item) => ({ loc: "query", name: item.p.name, item })),
    ...body.map((item) => ({ loc: "body", name: item.name, item })),
  ];
  const claimed = new Set<string>();
  for (const e of entries) {
    if (!claimed.has(e.name) && !(e.name in Object.prototype)) {
      claimed.add(e.name);
      e.item.key = e.name;
    }
  }
  for (const e of entries) {
    if (e.item.key !== "") continue;
    const base = `${e.name}_${e.loc}`;
    let candidate = base;
    for (let n = 2; claimed.has(candidate); n++) candidate = `${base}_${n}`;
    claimed.add(candidate);
    e.item.key = candidate;
  }
  return { path, query, body };
}

// Only an object-typed query parameter is exploded into its properties, so only it never sends its own name.
const OBJECT_ZOD = "z.record(z.string(), z.unknown())";

// OpenAPI types the parser keeps are JSON values: OAS 3.1 allows an array such as ["boolean","null"].
function openapiZodType(type: unknown): string {
  let t = type;
  if (Array.isArray(t)) {
    const rest = t.filter((x) => x !== "null");
    t = rest.length === 1 ? rest[0] : undefined;
  }
  if (t === "integer" || t === "number") return "z.number()";
  if (t === "boolean") return "z.boolean()";
  if (t === "array") return "z.array(z.unknown())";
  if (t === "object") return OBJECT_ZOD;
  return "z.string()";
}

function collectionArg(p: OpenAPIParameter): string {
  return p.collection ? `, ${JSON.stringify(p.collection)}` : "";
}

function generateOpenapiToolHandlers(
  endpoints: OpenAPIEndpoint[],
  serverUrl: string,
  reservedNames: string[],
): string[] {
  const lines: string[] = [];
  const usedNames = new Set<string>(reservedNames);

  for (const ep of endpoints) {
    const toolName = inferOpenapiToolName(ep, usedNames);
    const desc = ep.summary || ep.description || `${ep.method.toUpperCase()} ${ep.path}`;
    const inputs = allocateInputKeys(ep);
    const pathParams = inputs.path;
    const queryParams = inputs.query;
    const bodyProps = inputs.body;

    const schemaLines: string[] = [];
    for (const { p, key } of [...pathParams, ...queryParams]) {
      const zodType = openapiZodType(p.type);
      schemaLines.push(
        `  [${JSON.stringify(key)}]: ${zodType}${p.required ? "" : ".optional()"}.describe(${JSON.stringify(p.description || p.name)})`,
      );
    }
    for (const { name, def, key } of bodyProps) {
      const zodType = openapiZodType(def.type);
      schemaLines.push(
        `  [${JSON.stringify(key)}]: ${zodType}.optional().describe(${JSON.stringify(def.description || name)})`,
      );
    }

    const isReadOnly = ep.method.toLowerCase() === "get";
    const hints = isReadOnly
      ? "{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }"
      : "{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }";

    lines.push(`// Tool: ${toolName}`);
    lines.push(`server.tool(${JSON.stringify(toolName)}, ${JSON.stringify(desc)}, {`);
    if (schemaLines.length > 0) lines.push(schemaLines.join(",\n"));
    lines.push(`}, ${hints}, async (params) => {`);

    let pathExpr = JSON.stringify(ep.path);
    for (const { p, key } of pathParams) {
      pathExpr = `(${pathExpr}).replace(${JSON.stringify(`{${p.name}}`)}, () => encodePathParam(params[${JSON.stringify(key)}]${collectionArg(p)}))`;
    }
    lines.push(`  try {`);
    lines.push(`  const _path = ${pathExpr};`);
    lines.push(`  assertSafePath(_path);`);
    lines.push(`  let _url = ${JSON.stringify(serverUrl)} + _path;`);

    if (queryParams.length > 0) {
      lines.push(`  const _query: string[] = [];`);
      lines.push(
        `  const _declared: string[] = ${JSON.stringify(queryParams.filter(({ p }) => openapiZodType(p.type) !== OBJECT_ZOD).map(({ p }) => p.name))};`,
      );
      lines.push(`  const _objectKeys = new Set<string>();`);
      for (const { p, key } of queryParams) {
        const access = `params[${JSON.stringify(key)}]`;
        const call = `appendQueryParam(_query, ${JSON.stringify(p.name)}, ${access}, ${p.collection ? JSON.stringify(p.collection) : "undefined"}, _declared, _objectKeys)`;
        lines.push(p.required ? `  ${call};` : `  if (${access} !== undefined) ${call};`);
      }
      lines.push(`  const _qs = _query.join("&"); if (_qs) _url += "?" + _qs;`);
    }

    let initExpr: string;
    if (bodyProps.length > 0) {
      lines.push(`    const _body: Record<string, unknown> = Object.create(null);`);
      for (const { name, key } of bodyProps) {
        const access = `params[${JSON.stringify(key)}]`;
        lines.push(`    if (${access} !== undefined) _body[${JSON.stringify(name)}] = ${access};`);
      }
      initExpr = `{ method: ${JSON.stringify(ep.method.toUpperCase())}, headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(_body) }`;
    } else {
      initExpr = `{ method: ${JSON.stringify(ep.method.toUpperCase())}, headers: { "Accept": "application/json" } }`;
    }
    lines.push(
      `    return { content: [{ type: "text", text: await outboundFetch(_url, ${initExpr}, 3000) }] };`,
    );
    lines.push(`  } catch (err) {`);
    lines.push(
      `    return { content: [{ type: "text", text: \`Error: \${err instanceof Error ? err.message : String(err)}\` }], isError: true };`,
    );
    lines.push(`  }`);
    lines.push(`});`);
    lines.push(``);
  }
  return lines;
}

// --- Server Template ---

// Runtime-neutral (Node and Workers): no Buffer, no node: imports. Emitted verbatim into every variant.
export const OUTBOUND_HELPER_SOURCE = String.raw`const OUTBOUND_TIMEOUT_MS = 10000;
const OUTBOUND_MAX_BYTES = 1048576;

function assertSafePath(path: string): void {
  const segments = path
    .replace(/[\t\r\n]/g, "")
    .replace(/\\/g, "/")
    .split(/[?#]/)[0]
    .split("/");
  if (segments.some((s) => /^(?:\.|%2e){1,2}$/i.test(s))) {
    throw new Error("Refusing to fetch: a path segment resolved to . or ..");
  }
}

function scalarText(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

const COLLECTION_DELIMITERS: Record<string, string> = { csv: ",", ssv: " ", tsv: "\t", pipes: "|" };

function pairText(name: string, value: string): string {
  return new URLSearchParams([[name, value]]).toString();
}

function wellFormedKey(key: string): string {
  return decodeURIComponent(pairText(key, "").slice(0, -1).replace(/\+/g, " "));
}

function keyBase(full: string): string {
  const open = full.indexOf("[");
  return open > 0 ? full.slice(0, open) : full;
}

function keysCollide(a: string, b: string): boolean {
  const baseA = keyBase(a);
  const baseB = keyBase(b);
  return a === b || (baseA === a && a === baseB) || (baseB === b && b === baseA);
}

function appendQueryParam(query: string[], name: string, value: unknown, collection: string | undefined, declared: string[], objectKeys: Set<string>): void {
  if (Array.isArray(value)) {
    const delimiter = collection ? COLLECTION_DELIMITERS[collection] : undefined;
    if (delimiter === undefined) {
      for (const v of value) query.push(pairText(name, scalarText(v)));
    } else {
      const literal = delimiter === "," || delimiter === "|" ? delimiter : encodeURIComponent(delimiter);
      const parts = value.map((v) => pairText("", scalarText(v)).slice(1).replace(/\+/g, "%20"));
      query.push(pairText(name, "") + parts.join(literal));
    }
  } else if (typeof value === "object" && value !== null) {
    const declaredKeys = declared.map((d) => wellFormedKey(d).toLowerCase());
    const earlier = [...objectKeys];
    const seen = new Map<string, string>();
    for (const [k, v] of Object.entries(value)) {
      const wk = wellFormedKey(k).toLowerCase();
      const di = declaredKeys.findIndex((d) => keysCollide(d, wk));
      if (di >= 0) throw new Error("Query parameter " + JSON.stringify(name) + " has a property " + JSON.stringify(k) + " that collides with the query parameter " + JSON.stringify(declared[di]));
      for (const [other, raw] of seen) {
        if (keysCollide(other, wk)) throw new Error("Query parameter " + JSON.stringify(name) + " has the properties " + JSON.stringify(raw) + " and " + JSON.stringify(k) + " that collide as one query key (letter case, encoding or a bracket form of the same name)");
      }
      if (earlier.some((e) => keysCollide(e, wk))) throw new Error("Query parameter " + JSON.stringify(name) + " has a property " + JSON.stringify(k) + " that another object query parameter also sets");
      seen.set(wk, k);
      objectKeys.add(wk);
      query.push(pairText(k, scalarText(v)));
    }
  } else {
    query.push(pairText(name, scalarText(value)));
  }
}

function encodePathParam(value: unknown, collection?: string): string {
  const enc = (v: unknown) => encodeURIComponent(scalarText(v));
  if (Array.isArray(value)) {
    const delimiter = collection ? COLLECTION_DELIMITERS[collection] : undefined;
    return value.map(enc).join(delimiter === undefined || delimiter === "," ? "," : encodeURIComponent(delimiter));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [enc(k), enc(v)]).join(",");
  }
  return enc(value);
}

async function outboundFetch(url: string, init: RequestInit, maxChars: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  const drop = (target: { cancel(): Promise<unknown> } | null | undefined) => {
    try {
      Promise.resolve(target?.cancel()).catch(() => {});
    } catch {}
  };
  let res: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  try {
    res = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      return "Status: " + res.status + "\n\nRedirect not followed. " + (location ? "Location: " + location : "Location header missing.");
    }
    let text = "";
    let truncated = false;
    if (res.body) {
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = OUTBOUND_MAX_BYTES - total;
        if (value.byteLength >= room) {
          text += decoder.decode(value.subarray(0, room));
          truncated = true;
          break;
        }
        total += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
      if (!truncated) text += decoder.decode();
    }
    finished = !truncated;
    const out = text.length > maxChars ? text.slice(0, maxChars) + "..." : text;
    return "Status: " + res.status + "\n\n" + out + (truncated ? "\n\n[response truncated at " + OUTBOUND_MAX_BYTES + " bytes]" : "");
  } finally {
    clearTimeout(timer);
    if (!finished) {
      drop(reader ?? res?.body);
      controller.abort();
    }
  }
}
`;

// Serialises only the successful controls of a form (HTML form submission semantics) and
// builds the request. The method arrives as a fixed "GET"/"POST" literal from the generator.
export const FORM_HELPER_SOURCE = String.raw`type FormFieldSpec = { name: string; kind: string; required: boolean; value?: string; options?: string[] };

function serializeForm(fields: FormFieldSpec[], params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const f of fields) {
    const raw = Object.prototype.hasOwnProperty.call(params, f.name) ? params[f.name] : undefined;
    if (raw !== undefined && raw !== null) {
      const options = f.options ?? [];
      if (f.kind === "checkbox") {
        if (typeof raw !== "boolean") throw new Error("Field " + f.name + " must be true or false");
        if (raw) out.append(f.name, f.value ?? "on");
      } else if (f.kind === "checkbox-group") {
        if (!Array.isArray(raw)) throw new Error("Field " + f.name + " must be a list");
        for (const v of raw) {
          if (typeof v !== "string" || !options.includes(v)) throw new Error("Field " + f.name + " has a value that is not an option");
          out.append(f.name, v);
        }
      } else if (f.kind === "radio" || f.kind === "select") {
        if (typeof raw !== "string" || !options.includes(raw)) throw new Error("Field " + f.name + " must be one of its options");
        out.append(f.name, raw);
      } else if (f.kind === "number") {
        if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error("Field " + f.name + " must be a number");
        out.append(f.name, String(raw));
      } else {
        if (typeof raw !== "string") throw new Error("Field " + f.name + " must be a string");
        out.append(f.name, raw);
      }
    }
    if (f.required && !out.has(f.name)) throw new Error("Missing required field: " + f.name);
  }
  return out;
}

function buildFormRequest(action: string, method: "GET" | "POST", fields: FormFieldSpec[], params: Record<string, unknown>): { url: string; init: RequestInit } {
  const data = serializeForm(fields, params);
  if (method === "GET") {
    const u = new URL(action);
    u.search = data.toString();
    return { url: u.href, init: { method: "GET" } };
  }
  return { url: action, init: { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: data.toString() } };
}
`;

interface FormToolEmit {
  name: string;
  description: string;
  action: string;
  spec: FormToolSpec;
}

function formToolEmits(detected: McpDetectedTools): FormToolEmit[] {
  const names = detected.tools.filter((t) => t.condition === "hasForm").map((t) => t.name);
  return detected.forms.map((form, i) => ({
    name: names[i] ?? `submit-form-${i}`,
    description: `Submit form: ${form.toolSpec.method} ${form.action}`,
    action: form.resolvedAction,
    spec: form.toolSpec,
  }));
}

function formAnnotations(method: string): string {
  return method === "GET"
    ? "{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }"
    : "{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }";
}

function formZodType(f: FormFieldSpec): string {
  const optionList = `${JSON.stringify(f.options ?? [])} as [string, ...string[]]`;
  let zodType = "z.string()";
  if (f.kind === "checkbox") zodType = "z.boolean()";
  else if (f.kind === "checkbox-group") zodType = `z.array(z.enum(${optionList}))`;
  else if (f.kind === "radio" || f.kind === "select") zodType = `z.enum(${optionList})`;
  else if (f.kind === "number") zodType = "z.number()";
  return `${zodType}${f.required ? "" : ".optional()"}.describe(${JSON.stringify(f.label)})`;
}

function formZodShape(spec: FormToolSpec, indent: string): string {
  return spec.fields
    .map((f) => `${indent}[${JSON.stringify(f.name)}]: ${formZodType(f)}`)
    .join(",\n");
}

function formRequestExpr(tool: FormToolEmit, paramsVar: string): string {
  const method = tool.spec.method === "GET" ? '"GET"' : '"POST"';
  return `buildFormRequest(${JSON.stringify(tool.action)}, ${method}, ${jsonObjectLiteral(tool.spec.fields)} as FormFieldSpec[], ${paramsVar})`;
}

function siteSearchUrlExpr(sa: SearchActionTemplate, queryExpr: string): string {
  return `${JSON.stringify(sa.template)}.split(${JSON.stringify(`{${sa.placeholder}}`)}).join(encodeURIComponent(${queryExpr}))`;
}

const SITE_SEARCH_DESCRIPTION = "Get the site's native search URL for a query (via SearchAction)";

function generateServerTs(siteName: string, baseUrl: string, detected: McpDetectedTools): string {
  const lines: string[] = [];
  const toolLines: string[] = [];

  lines.push(`import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`);
  lines.push(
    `import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";`,
  );
  lines.push(`import express from "express";`);
  lines.push(`import { z } from "zod";`);
  lines.push(`import { readFileSync } from "node:fs";`);
  lines.push(`import { resolve, dirname } from "node:path";`);
  lines.push(`import { fileURLToPath } from "node:url";`);
  lines.push(``);
  lines.push(`const __dirname = dirname(fileURLToPath(import.meta.url));`);
  lines.push(``);
  lines.push(OUTBOUND_HELPER_SOURCE);
  if (detected.forms.length > 0) lines.push(FORM_HELPER_SOURCE);
  lines.push(`// Load data`);
  lines.push(
    `const pages = JSON.parse(readFileSync(resolve(__dirname, "data/pages.json"), "utf-8"));`,
  );

  if (detected.hasFaq) {
    lines.push(
      `const faq = JSON.parse(readFileSync(resolve(__dirname, "data/faq.json"), "utf-8"));`,
    );
  }

  if (detected.hasProducts) {
    lines.push(
      `const products = JSON.parse(readFileSync(resolve(__dirname, "data/products.json"), "utf-8"));`,
    );
  }

  if (detected.hasLocalBusiness) {
    lines.push(
      `const business = JSON.parse(readFileSync(resolve(__dirname, "data/business.json"), "utf-8"));`,
    );
  }

  lines.push(``);
  lines.push(`// Build a fresh MCP server per request (stateless transport)`);
  lines.push(`function createServer() {`);
  lines.push(`const server = new McpServer({`);
  lines.push(`  name: ${JSON.stringify(siteName)},`);
  lines.push(`  version: "1.0.0",`);
  lines.push(`});`);
  lines.push(``);
  // list-pages tool
  toolLines.push(`// Tool: list-pages`);
  toolLines.push(
    `server.tool("list-pages", "List all pages on the site with titles and URLs", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {`,
  );
  toolLines.push(
    `  const listing = pages.map((p: any) => \`\${p.title} — \${p.url}\`).join("\\n");`,
  );
  toolLines.push(`  return { content: [{ type: "text", text: listing }] };`);
  toolLines.push(`});`);
  toolLines.push(``);

  // get-page tool
  toolLines.push(`// Tool: get-page`);
  toolLines.push(
    `server.tool("get-page", "Get the full markdown content of a page", { url: z.string().describe("Page URL or slug to retrieve") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ url }) => {`,
  );
  toolLines.push(
    `  const page = pages.find((p: any) => p.url === url || p.url.endsWith("/" + url) || p.url.includes(url));`,
  );
  toolLines.push(`  if (!page) return { content: [{ type: "text", text: "Page not found" }] };`);
  toolLines.push(
    `  return { content: [{ type: "text", text: \`# \${page.title}\\n\\n\${page.markdown}\` }] };`,
  );
  toolLines.push(`});`);
  toolLines.push(``);

  // search-site tool
  toolLines.push(`// Tool: search-site`);
  toolLines.push(
    `server.tool("search-site", "Search site content by keywords", { query: z.string().describe("Search query") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {`,
  );
  toolLines.push(`  const terms = query.toLowerCase().split(/\\s+/);`);
  toolLines.push(`  const scored = pages.map((p: any) => {`);
  toolLines.push(`    let score = 0;`);
  toolLines.push(`    for (const term of terms) {`);
  toolLines.push(`      if (p.title?.toLowerCase().includes(term)) score += 3;`);
  toolLines.push(`      if (p.description?.toLowerCase().includes(term)) score += 2;`);
  toolLines.push(`      if (p.markdown?.toLowerCase().includes(term)) score += 1;`);
  toolLines.push(`    }`);
  toolLines.push(`    return { ...p, score };`);
  toolLines.push(
    `  }).filter((p: any) => p.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, 10);`,
  );
  toolLines.push(``);
  toolLines.push(
    `  if (scored.length === 0) return { content: [{ type: "text", text: "No results found" }] };`,
  );
  toolLines.push(`  const results = scored.map((p: any) => {`);
  toolLines.push(`    const snippet = p.markdown?.slice(0, 3000) || "";`);
  toolLines.push(`    return \`**\${p.title}** (\${p.url})\\n\${snippet}...\`;`);
  toolLines.push(`  }).join("\\n\\n");`);
  toolLines.push(`  return { content: [{ type: "text", text: results }] };`);
  toolLines.push(`});`);
  toolLines.push(``);

  // search-faq tool
  if (detected.hasFaq) {
    toolLines.push(`// Tool: search-faq`);
    toolLines.push(
      `server.tool("search-faq", "Search FAQ question/answer pairs", { query: z.string().describe("Search query") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {`,
    );
    toolLines.push(`  const terms = query.toLowerCase().split(/\\s+/);`);
    toolLines.push(`  const entries = faq.mainEntity || [];`);
    toolLines.push(`  const matches = entries.filter((e: any) => {`);
    toolLines.push(`    const text = (e.name + " " + e.acceptedAnswer?.text).toLowerCase();`);
    toolLines.push(`    return terms.some((t: string) => text.includes(t));`);
    toolLines.push(`  });`);
    toolLines.push(
      `  if (matches.length === 0) return { content: [{ type: "text", text: "No FAQ matches found" }] };`,
    );
    toolLines.push(
      `  const result = matches.map((e: any) => \`**Q:** \${e.name}\\n**A:** \${e.acceptedAnswer?.text}\`).join("\\n\\n");`,
    );
    toolLines.push(`  return { content: [{ type: "text", text: result }] };`);
    toolLines.push(`});`);
    toolLines.push(``);
  }

  // site-search tool (SearchAction): returns the site's own search URL, never fetched here
  if (detected.searchAction) {
    toolLines.push(`// Tool: site-search (via SearchAction)`);
    toolLines.push(
      `server.tool("site-search", ${JSON.stringify(SITE_SEARCH_DESCRIPTION)}, { query: z.string().describe("Search query") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {`,
    );
    toolLines.push(`  const searchUrl = ${siteSearchUrlExpr(detected.searchAction, "query")};`);
    toolLines.push(`  return { content: [{ type: "text", text: searchUrl }] };`);
    toolLines.push(`});`);
    toolLines.push(``);
  }

  // Form submission tools
  for (const tool of formToolEmits(detected)) {
    toolLines.push(`// Tool: ${tool.name}`);
    toolLines.push(
      `server.tool(${JSON.stringify(tool.name)}, ${JSON.stringify(tool.description)}, {`,
    );
    toolLines.push(formZodShape(tool.spec, "    "));
    toolLines.push(`}, ${formAnnotations(tool.spec.method)}, async (params) => {`);
    toolLines.push(`  try {`);
    toolLines.push(`    const _req = ${formRequestExpr(tool, "params")};`);
    toolLines.push(
      `    return { content: [{ type: "text", text: await outboundFetch(_req.url, _req.init, 2000) }] };`,
    );
    toolLines.push(`  } catch (err) {`);
    toolLines.push(
      `    return { content: [{ type: "text", text: \`Error: \${err instanceof Error ? err.message : String(err)}\` }], isError: true };`,
    );
    toolLines.push(`  }`);
    toolLines.push(`});`);
    toolLines.push(``);
  }

  // Commerce tools
  if (detected.hasProducts) {
    lines.push(`// E-commerce tool handlers`);
    lines.push(generateCommerceToolHandlers("ts"));
    lines.push(``);

    toolLines.push(`// Tool: search-products`);
    toolLines.push(
      `server.tool("search-products", "Search products by name, category, or description", { query: z.string().describe("Search query") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {`,
    );
    toolLines.push(`  const results = searchProducts(query, products);`);
    toolLines.push(
      `  if (results.length === 0) return { content: [{ type: "text", text: "No products found" }] };`,
    );
    toolLines.push(
      `  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };`,
    );
    toolLines.push(`});`);
    toolLines.push(``);

    toolLines.push(`// Tool: get-product`);
    toolLines.push(
      `server.tool("get-product", "Get full product details by product ID", { productId: z.string().describe("Product ID or name") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {`,
    );
    toolLines.push(`  const product = getProduct(productId, products);`);
    toolLines.push(
      `  if (!product) return { content: [{ type: "text", text: "Product not found" }] };`,
    );
    toolLines.push(
      `  return { content: [{ type: "text", text: JSON.stringify(product, null, 2) }] };`,
    );
    toolLines.push(`});`);
    toolLines.push(``);

    toolLines.push(`// Tool: check-inventory`);
    toolLines.push(
      `server.tool("check-inventory", "Check product availability and price", { productId: z.string().describe("Product ID or name") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {`,
    );
    toolLines.push(`  const result = checkInventory(productId, products);`);
    toolLines.push(
      `  if (!result) return { content: [{ type: "text", text: "Product not found" }] };`,
    );
    toolLines.push(
      `  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };`,
    );
    toolLines.push(`});`);
    toolLines.push(``);

    toolLines.push(`// Tool: get-reviews`);
    toolLines.push(
      `server.tool("get-reviews", "Get aggregate rating for a product", { productId: z.string().describe("Product ID or name") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {`,
    );
    toolLines.push(`  const result = getReviews(productId, products);`);
    toolLines.push(
      `  if (!result) return { content: [{ type: "text", text: "Product not found" }] };`,
    );
    toolLines.push(
      `  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };`,
    );
    toolLines.push(`});`);
    toolLines.push(``);
  }

  // Local business tool handlers
  if (detected.hasLocalBusiness) {
    lines.push(`// Local business tool handlers`);
    lines.push(generateLocalBusinessToolHandlers("ts"));
    lines.push(``);

    toolLines.push(`// Tool: get-hours`);
    toolLines.push(
      `server.tool("get-hours", "Get business hours and opening times", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {`,
    );
    toolLines.push(`  const result = getHours(business);`);
    toolLines.push(
      `  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };`,
    );
    toolLines.push(`});`);
    toolLines.push(``);

    const menuTool = detected.tools.find(
      (t) => t.name === "get-menu" && t.condition === "hasLocalBusiness",
    );
    if (menuTool) {
      toolLines.push(`// Tool: get-menu`);
      toolLines.push(
        `server.tool("get-menu", "Get the menu URL for this business", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {`,
      );
      toolLines.push(`  const result = getMenu(business);`);
      toolLines.push(
        `  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };`,
      );
      toolLines.push(`});`);
      toolLines.push(``);
    }

    const servicesTool = detected.tools.find(
      (t) => t.name === "get-services" && t.condition === "hasLocalBusiness",
    );
    if (servicesTool) {
      toolLines.push(`// Tool: get-services`);
      toolLines.push(
        `server.tool("get-services", "Get the services page URL for this business", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {`,
      );
      toolLines.push(`  const result = getServices(business);`);
      toolLines.push(
        `  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };`,
      );
      toolLines.push(`});`);
      toolLines.push(``);
    }

    const bookingTool = detected.tools.find(
      (t) => t.name === "book-appointment" && t.condition === "hasLocalBusiness",
    );
    if (bookingTool) {
      toolLines.push(`// Tool: book-appointment`);
      toolLines.push(
        `server.tool("book-appointment", "Get booking URL and instructions for scheduling", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {`,
      );
      toolLines.push(`  const result = bookAppointment(business);`);
      toolLines.push(
        `  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };`,
      );
      toolLines.push(`});`);
      toolLines.push(``);
    }
  }

  // OpenAPI endpoint tools
  if (detected.hasOpenapi && detected.openapiEndpoints.length > 0) {
    const apiBase = detected.openapiServerUrl || baseUrl;
    toolLines.push(`// OpenAPI endpoint tools`);
    toolLines.push(
      ...generateOpenapiToolHandlers(
        detected.openapiEndpoints,
        apiBase,
        reservedToolNames(detected),
      ),
    );
  }

  // Page resources
  toolLines.push(`// Resources: expose pages as MCP resources`);
  toolLines.push(`for (const page of pages) {`);
  toolLines.push(`  server.resource(page.url, page.url, async (uri) => ({`);
  toolLines.push(
    `    contents: [{ uri: uri.href, mimeType: "text/markdown", text: page.markdown }],`,
  );
  toolLines.push(`  }));`);
  toolLines.push(`}`);
  toolLines.push(``);

  // HTTP server
  lines.push(...toolLines);
  lines.push(`return server;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`// Start HTTP server with Streamable HTTP transport`);
  lines.push(`const app = express();`);
  lines.push(`app.use(express.json());`);
  lines.push(``);
  lines.push(`const jsonRpcError = (code: number, message: string, id: unknown = null) => ({`);
  lines.push(`  jsonrpc: "2.0" as const,`);
  lines.push(`  error: { code, message },`);
  lines.push(`  id,`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`app.post("/mcp", async (req, res) => {`);
  lines.push(`  try {`);
  lines.push(`    const server = createServer();`);
  lines.push(
    `    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });`,
  );
  lines.push(`    res.on("close", () => {`);
  lines.push(`      transport.close().catch(() => {});`);
  lines.push(`      server.close().catch(() => {});`);
  lines.push(`    });`);
  lines.push(`    await server.connect(transport);`);
  lines.push(`    await transport.handleRequest(req, res, req.body);`);
  lines.push(`  } catch (error) {`);
  lines.push(`    console.error("Error handling MCP request:", error);`);
  lines.push(`    if (!res.headersSent) {`);
  lines.push(
    `      res.status(500).json(jsonRpcError(-32603, "Internal server error", req.body?.id ?? null));`,
  );
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`const methodNotAllowed = (_req: express.Request, res: express.Response) => {`);
  lines.push(
    `  res.status(405).set("Allow", "POST").json(jsonRpcError(-32000, "Method not allowed."));`,
  );
  lines.push(`};`);
  lines.push(`app.get("/mcp", methodNotAllowed);`);
  lines.push(`app.delete("/mcp", methodNotAllowed);`);
  lines.push(``);
  lines.push(`// .well-known/mcp discovery endpoint`);
  lines.push(`app.get("/.well-known/mcp", (_req, res) => {`);
  lines.push(`  res.redirect(307, "/mcp");`);
  lines.push(`});`);
  lines.push(``);
  lines.push(
    `app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {`,
  );
  lines.push(`  if (res.headersSent) return next(err);`);
  lines.push(`  const status = err?.status ?? err?.statusCode;`);
  lines.push(`  if (typeof status === "number" && status >= 400 && status < 500) {`);
  lines.push(
    `    const parseFailure = err?.type === "entity.parse.failed" || err instanceof SyntaxError;`,
  );
  lines.push(
    `    return res.status(status).json(parseFailure ? jsonRpcError(-32700, "Parse error") : jsonRpcError(-32600, "Invalid request"));`,
  );
  lines.push(`  }`);
  lines.push(`  console.error(err);`);
  lines.push(`  res.status(500).json(jsonRpcError(-32603, "Internal server error"));`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`// Fail at startup (not per request) if the data set cannot be registered`);
  lines.push(`createServer().close().catch(() => {});`);
  lines.push(``);
  lines.push(`const PORT = process.env.PORT || 3100;`);
  lines.push(`app.listen(PORT, () => {`);
  lines.push(
    `  console.log(${JSON.stringify(`Agent server for ${siteName} running at http://localhost:`)} + PORT + "/mcp");`,
  );
  lines.push(`});`);

  return `${lines.join("\n")}\n`;
}

// --- Package.json ---

function generatePackageJson(siteName: string): string {
  const slug = siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const pkg = {
    name: `${slug}-agent-server`,
    version: "1.0.0",
    type: "module",
    scripts: {
      start: "tsx server.ts",
      dev: "tsx watch server.ts",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.12.0",
      express: "^4.21.0",
      zod: "^3.24.0",
      tsx: "^4.19.0",
    },
    devDependencies: {
      "@types/express": "^5.0.0",
      "@types/node": "^22.0.0",
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

// --- tsconfig.json ---

function generateTsConfig(): string {
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

// --- README ---

function generateReadme(
  siteName: string,
  detected: McpDetectedTools,
  baseUrl: string,
  variant: "express" | "vercel" | "cf",
): string {
  const lines: string[] = [];
  const title = mdText(siteName);
  lines.push(`# ${title} Agent Server`);
  lines.push(``);
  lines.push(`Auto-generated agent server for [${title}](${mdUrl(baseUrl)}).`);
  lines.push(``);
  lines.push(`## Tools`);
  lines.push(``);
  for (const tool of detected.tools) {
    lines.push(`- **${mdText(tool.name)}**: ${mdText(tool.description)}`);
  }
  lines.push(``);
  lines.push(`## Setup`);
  lines.push(``);
  let configUrl = "http://localhost:3100/mcp";
  if (variant === "express") {
    lines.push("```bash", `npm install`, `npm start`, "```", ``);
    lines.push(`Server runs at \`http://localhost:3100/mcp\``);
  } else if (variant === "vercel") {
    configUrl = "https://YOUR-DEPLOYMENT.vercel.app/mcp";
    lines.push(
      "```bash",
      `npm install`,
      `npx vercel dev   # local test`,
      `npx vercel --prod  # deploy`,
      "```",
      ``,
    );
    lines.push(`The endpoint is \`/mcp\`. Locally, use the URL \`vercel dev\` prints.`);
  } else {
    configUrl = "http://localhost:8787/mcp";
    lines.push(
      "```bash",
      `npm install`,
      `bash setup.sh --local   # seed local data`,
      `npx wrangler dev        # serves http://localhost:8787/mcp`,
      "```",
      ``,
      `To deploy, create the KV namespace:`,
      ``,
      "```bash",
      `npx wrangler kv namespace create MCP_DATA`,
      "```",
      ``,
      `Set the printed id as \`id = "<id>"\` under the MCP_DATA binding in \`wrangler.toml\`, then upload the data and deploy:`,
      ``,
      "```bash",
      `bash setup.sh`,
      `npx wrangler deploy`,
      "```",
      ``,
      `After re-crawling, regenerating rewrites \`wrangler.toml\`: set the same namespace id again (\`npx wrangler kv namespace list\` shows it), then rerun \`bash setup.sh\`.`,
    );
  }
  lines.push(``);
  lines.push(`## Claude Desktop Config`);
  lines.push(``);
  lines.push("```json");
  lines.push(`{`);
  lines.push(`  "mcpServers": {`);
  lines.push(`    "${siteName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}": {`);
  lines.push(`      "url": "${configUrl}"`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("```");
  lines.push(``);

  return lines.join("\n");
}

const LOCAL_BUSINESS_TOOLS = [
  ["get-hours", "Get business hours and opening times", "getHours"],
  ["get-menu", "Get the menu URL for this business", "getMenu"],
  ["get-services", "Get the services page URL for this business", "getServices"],
  ["book-appointment", "Get booking URL and instructions for scheduling", "bookAppointment"],
] as const;

function localBusinessToolRegistrations(detected: McpDetectedTools): string {
  return LOCAL_BUSINESS_TOOLS.filter(([name]) =>
    detected.tools.some((t) => t.name === name && t.condition === "hasLocalBusiness"),
  )
    .map(
      ([name, description, handler]) => `
  server.tool(${JSON.stringify(name)}, ${JSON.stringify(description)}, {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {
    const result = ${handler}(business);
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
  });
`,
    )
    .join("");
}

function generateSharedToolRegistrations(detected: McpDetectedTools, baseUrl: string): string {
  return `
  server.tool("list-pages", "List all pages", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {
    const listing = pages.map((p: any) => \`\${p.title} — \${p.url}\`).join("\\n");
    return { content: [{ type: "text", text: listing }] };
  });

  server.tool("get-page", "Get page content", { url: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ url }) => {
    const page = pages.find((p: any) => p.url === url || p.url.endsWith("/" + url) || p.url.includes(url));
    if (!page) return { content: [{ type: "text", text: "Page not found" }] };
    return { content: [{ type: "text", text: \`# \${page.title}\\n\\n\${page.markdown}\` }] };
  });

  server.tool("search-site", "Search site content", { query: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {
    const terms = query.toLowerCase().split(/\\s+/);
    const scored = pages.map((p: any) => {
      let score = 0;
      for (const term of terms) {
        if (p.title?.toLowerCase().includes(term)) score += 3;
        if (p.description?.toLowerCase().includes(term)) score += 2;
        if (p.markdown?.toLowerCase().includes(term)) score += 1;
      }
      return { ...p, score };
    }).filter((p: any) => p.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, 10);
    if (scored.length === 0) return { content: [{ type: "text", text: "No results" }] };
    const results = scored.map((p: any) => \`**\${p.title}** (\${p.url})\\n\${p.markdown?.slice(0, 3000)}...\`).join("\\n\\n");
    return { content: [{ type: "text", text: results }] };
  });
${
  detected.searchAction
    ? `
  server.tool("site-search", ${JSON.stringify(SITE_SEARCH_DESCRIPTION)}, { query: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {
    return { content: [{ type: "text", text: ${siteSearchUrlExpr(detected.searchAction, "query")} }] };
  });
`
    : ""
}${
  detected.hasFaq
    ? `
  server.tool("search-faq", "Search FAQ", { query: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {
    const terms = query.toLowerCase().split(/\\s+/);
    const entries = (faq as any).mainEntity || [];
    const matches = entries.filter((e: any) => {
      const text = (e.name + " " + e.acceptedAnswer?.text).toLowerCase();
      return terms.some((t: string) => text.includes(t));
    });
    if (matches.length === 0) return { content: [{ type: "text", text: "No FAQ matches" }] };
    const result = matches.map((e: any) => \`**Q:** \${e.name}\\n**A:** \${e.acceptedAnswer?.text}\`).join("\\n\\n");
    return { content: [{ type: "text", text: result }] };
  });
`
    : ""
}${
  detected.hasProducts
    ? `
${generateCommerceToolHandlers("ts")}

  server.tool("search-products", "Search products by name, category, or description", { query: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {
    const results = searchProducts(query, products as any);
    if (results.length === 0) return { content: [{ type: "text", text: "No products found" }] };
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.tool("get-product", "Get full product details by product ID", { productId: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {
    const product = getProduct(productId, products as any);
    if (!product) return { content: [{ type: "text", text: "Product not found" }] };
    return { content: [{ type: "text", text: JSON.stringify(product, null, 2) }] };
  });

  server.tool("check-inventory", "Check product availability and price", { productId: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {
    const result = checkInventory(productId, products as any);
    if (!result) return { content: [{ type: "text", text: "Product not found" }] };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get-reviews", "Get aggregate rating for a product", { productId: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {
    const result = getReviews(productId, products as any);
    if (!result) return { content: [{ type: "text", text: "Product not found" }] };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
`
    : ""
}
${
  detected.hasLocalBusiness
    ? `
${generateLocalBusinessToolHandlers("ts")}
${localBusinessToolRegistrations(detected)}`
    : ""
}
${
  formToolEmits(detected).length > 0
    ? formToolEmits(detected)
        .map((tool) => {
          return `
  server.tool(${JSON.stringify(tool.name)}, ${JSON.stringify(tool.description)}, {
${formZodShape(tool.spec, "    ")}
  }, ${formAnnotations(tool.spec.method)}, async (params) => {
    try {
      const _req = ${formRequestExpr(tool, "params")};
      return { content: [{ type: "text", text: await outboundFetch(_req.url, _req.init, 2000) }] };
    } catch (err) {
      return { content: [{ type: "text", text: \`Error: \${err instanceof Error ? err.message : String(err)}\` }], isError: true };
    }
  });`;
        })
        .join("\n")
    : ""
}${
  detected.hasOpenapi && detected.openapiEndpoints.length > 0
    ? "\n" +
      generateOpenapiToolHandlers(
        detected.openapiEndpoints,
        detected.openapiServerUrl || baseUrl,
        reservedToolNames(detected),
      )
        .map((l) => (l ? `  ${l}` : l))
        .join("\n")
    : ""
}
`;
}

// --- Vercel Self-Host Template ---

function generateVercelTemplate(
  siteName: string,
  baseUrl: string,
  detected: McpDetectedTools,
  dataFiles: GeneratedFile[],
): GeneratedFile[] {
  const slug = siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const vercelJson = `${JSON.stringify(
    {
      rewrites: [
        { source: "/.well-known/mcp", destination: "/api/mcp" },
        { source: "/mcp", destination: "/api/mcp" },
      ],
    },
    null,
    2,
  )}\n`;

  const apiMcpTs = `import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pages from "../data/pages.json" with { type: "json" };
${detected.hasFaq ? 'import faq from "../data/faq.json" with { type: "json" };\n' : ""}${detected.hasProducts ? 'import products from "../data/products.json" with { type: "json" };\n' : ""}${detected.hasLocalBusiness ? 'import business from "../data/business.json" with { type: "json" };\n' : ""}
${OUTBOUND_HELPER_SOURCE}
${detected.forms.length > 0 ? FORM_HELPER_SOURCE : ""}
function createServer() {
  const server = new McpServer({ name: ${JSON.stringify(siteName)}, version: "1.0.0" });

${generateSharedToolRegistrations(detected, baseUrl)}
  return server;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
`;

  const pkgJson = `${JSON.stringify(
    {
      name: `${slug}-agent-vercel`,
      version: "1.0.0",
      type: "module",
      scripts: {
        dev: "vercel dev",
        deploy: "vercel --prod",
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.12.0",
        "@vercel/node": "^5.0.0",
        zod: "^3.24.0",
      },
    },
    null,
    2,
  )}\n`;

  const readme = generateReadme(siteName, detected, baseUrl, "vercel");

  return [
    makeFile("mcp-server/vercel.json", vercelJson),
    makeFile("mcp-server/api/mcp.ts", apiMcpTs),
    makeFile("mcp-server/package.json", pkgJson),
    makeFile("mcp-server/tsconfig.json", generateTsConfig()),
    makeFile("mcp-server/README.md", readme),
    ...dataFiles,
  ];
}

// --- Cloudflare Workers Self-Host Template ---

const SETUP_SH_HAS_ID = String.raw`has_id() {
  awk '
    function close_table() { if (intable && bound && hasid) ok = 1 }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*\[/ {
      close_table()
      intable = ($0 ~ /^[[:space:]]*\[\[[[:space:]]*kv_namespaces[[:space:]]*\]\]/)
      bound = 0; hasid = 0; next
    }
    intable && $0 ~ "^[[:space:]]*binding[[:space:]]*=[[:space:]]*(\"MCP_DATA\"|\047MCP_DATA\047)" { bound = 1 }
    intable && $0 ~ "^[[:space:]]*id[[:space:]]*=[[:space:]]*(\"[^\"]+\"|\047[^\047]+\047)" && $0 !~ "^[[:space:]]*id[[:space:]]*=[[:space:]]*(\"[.][.][.]\"|\047[.][.][.]\047)" { hasid = 1 }
    END { close_table(); exit (ok ? 0 : 1) }
  ' wrangler.toml
}
`;

function generateCloudflareTemplate(
  siteName: string,
  baseUrl: string,
  detected: McpDetectedTools,
  dataFiles: GeneratedFile[],
): GeneratedFile[] {
  const slug = siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const wranglerToml = `name = "${slug}-agent"
main = "worker.ts"
compatibility_date = "2024-12-01"

[[kv_namespaces]]
binding = "MCP_DATA"
# Deploy only: run "npx wrangler kv namespace create MCP_DATA", then uncomment and set the id it prints.
# id = "..."
`;

  const kvKeys = [
    "pages",
    ...(detected.hasFaq ? ["faq"] : []),
    ...(detected.hasProducts ? ["products"] : []),
    ...(detected.hasLocalBusiness ? ["business"] : []),
  ];
  const createServerParams = kvKeys.map((k) => `${k}: any`).join(", ");

  const workerTs = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

${OUTBOUND_HELPER_SOURCE}
${detected.forms.length > 0 ? FORM_HELPER_SOURCE : ""}
interface Env {
  MCP_DATA: { get(key: string): Promise<string | null> };
}

const KV_KEYS = ${JSON.stringify(kvKeys)};

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createServer(${createServerParams}) {
  const server = new McpServer({ name: ${JSON.stringify(siteName)}, version: "1.0.0" });

${generateSharedToolRegistrations(detected, baseUrl)}
  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/mcp") {
      return Response.redirect(new URL("/mcp", request.url).href, 307);
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return jsonRpcError(405, -32000, "Method not allowed.", { Allow: "POST" });
    }

    try {
      const raw = await Promise.all(KV_KEYS.map((k) => env.MCP_DATA.get(k)));
      const values = raw.map((s) => {
        if (s === null) return null;
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      });
      const missing = KV_KEYS.filter((_, i) => values[i] === null);
      if (missing.length > 0) {
        return jsonRpcError(503, -32000, "Server data is missing or unreadable in KV (" + missing.join(", ") + "). Run setup.sh to upload it, then retry.");
      }
      const [${kvKeys.join(", ")}] = values;

      const server = createServer(${kvKeys.join(", ")});
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      return jsonRpcError(500, -32603, "Internal server error");
    }
  },
};
`;

  const setupSh = `#!/bin/bash
# Upload data to Cloudflare KV. Default: the deployed namespace (--remote).
# Usage: bash setup.sh [--local]   (--local seeds the storage used by "wrangler dev")
set -euo pipefail
cd "$(dirname "$0")"

case "$*" in
  "") scope=--remote ;;
  --local) scope=--local ;;
  *) echo "Usage: bash setup.sh [--local]" >&2; exit 2 ;;
esac

${SETUP_SH_HAS_ID}
if [ "$scope" = "--remote" ] && ! has_id; then
  echo "wrangler.toml has no KV namespace id under the MCP_DATA binding." >&2
  echo "First time: run npx wrangler kv namespace create MCP_DATA and use the id it prints." >&2
  echo "Namespace already exists (e.g. after a re-crawl): reuse its id, see npx wrangler kv namespace list." >&2
  echo "Set id = \\"<id>\\" under the MCP_DATA binding in wrangler.toml and rerun." >&2
  exit 1
fi

for key in ${kvKeys.join(" ")}; do
  [ -f "data/$key.json" ] || { echo "Missing data/$key.json" >&2; exit 1; }
done

${kvKeys.map((k) => `npx wrangler kv key put --binding MCP_DATA "${k}" --path data/${k}.json "$scope"\n`).join("")}
if [ "$scope" = "--local" ]; then
  echo "Local data uploaded. Start the server with: npx wrangler dev"
else
  echo "Data uploaded. Deploy with: npx wrangler deploy"
fi
`;

  const pkgJson = `${JSON.stringify(
    {
      name: `${slug}-agent-cf`,
      version: "1.0.0",
      type: "module",
      scripts: {
        dev: "wrangler dev",
        deploy: "wrangler deploy",
        "setup-data": "bash setup.sh",
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.25.0",
        zod: "^3.24.0",
      },
      devDependencies: {
        wrangler: "^4.0.0",
      },
    },
    null,
    2,
  )}\n`;

  const readme = generateReadme(siteName, detected, baseUrl, "cf");

  return [
    makeFile("mcp-server/wrangler.toml", wranglerToml),
    makeFile("mcp-server/worker.ts", workerTs),
    makeFile("mcp-server/setup.sh", setupSh),
    makeFile("mcp-server/package.json", pkgJson),
    makeFile("mcp-server/tsconfig.json", generateTsConfig()),
    makeFile("mcp-server/README.md", readme),
    ...dataFiles,
  ];
}

// --- Helpers ---

// An object literal with a "__proto__" key sets the prototype instead of an own
// property, so emit crawled-key objects through JSON.parse.
function jsonObjectLiteral(value: unknown): string {
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return {
    filename,
    content,
    size: new TextEncoder().encode(content).length,
  };
}
