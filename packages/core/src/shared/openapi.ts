import type {
  AuditOptions,
  OpenAPIEndpoint,
  OpenAPIParameter,
  OpenAPIRequestBody,
  ParsedOpenAPISpec,
} from "../audit/types.js";
import { fetchText } from "./fetcher.js";

export const OPENAPI_PROBE_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/.well-known/openapi",
  "/api-docs",
  "/api/docs",
];

const MAX_ENDPOINTS = 200;
const MAX_REF_DEPTH = 5;

export async function probeOpenAPIPaths(
  baseUrl: string,
  options: Pick<AuditOptions, "timeout" | "userAgent">,
): Promise<ParsedOpenAPISpec | null> {
  const results = await Promise.all(
    OPENAPI_PROBE_PATHS.map(async (path) => {
      const url = `${baseUrl}${path}`;
      const result = await fetchText(url, options);
      if (!result || result.status !== 200) return null;
      try {
        const json = JSON.parse(result.text);
        if (!json.openapi && !json.swagger) return null;
        return parseOpenAPISpec(json, url);
      } catch {
        return null;
      }
    }),
  );
  return results.find((r) => r !== null) ?? null;
}

export function parseOpenAPISpec(json: unknown, specUrl: string): ParsedOpenAPISpec | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const version = obj.openapi || obj.swagger;
  if (!version) return null;

  const isV2 = typeof version === "string" && version.startsWith("2");
  const paths = obj.paths;
  if (!paths || typeof paths !== "object") return null;

  const serverUrl = isV2
    ? (obj.basePath as string | undefined) || undefined
    : (obj.servers as Array<{ url: string }> | undefined)?.[0]?.url || undefined;

  const endpoints: OpenAPIEndpoint[] = [];
  const methods = ["get", "post", "put", "patch", "delete", "head", "options"];

  for (const [path, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of methods) {
      const operation = (pathItem as Record<string, unknown>)[method];
      if (!operation) continue;
      if (endpoints.length >= MAX_ENDPOINTS) break;

      endpoints.push({
        path,
        method: method.toUpperCase(),
        operationId: (operation as Record<string, unknown>).operationId as string | undefined,
        summary: (operation as Record<string, unknown>).summary as string | undefined,
        description: (operation as Record<string, unknown>).description as string | undefined,
        parameters: extractParameters(operation as Record<string, unknown>, isV2, obj),
        requestBody: extractRequestBody(operation as Record<string, unknown>, isV2, obj),
      });
    }
    if (endpoints.length >= MAX_ENDPOINTS) break;
  }

  const info = obj.info as Record<string, unknown> | undefined;

  return {
    specUrl,
    version: String(version),
    title: info?.title as string | undefined,
    description: info?.description as string | undefined,
    serverUrl,
    endpoints,
  };
}

function resolveRef(
  ref: string,
  root: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > MAX_REF_DEPTH) return {};
  if (!ref.startsWith("#/")) return {};
  const parts = ref.slice(2).split("/");
  let current: unknown = root;
  for (const part of parts) {
    current = (current as Record<string, unknown>)?.[part];
    if (current === undefined) return {};
  }
  const cur = current as Record<string, unknown> | undefined;
  if (cur?.$ref) return resolveRef(cur.$ref as string, root, depth + 1);
  return cur ?? {};
}

function maybeResolve(obj: unknown, root: Record<string, unknown>): Record<string, unknown> {
  if (obj && typeof obj === "object" && "$ref" in obj) {
    return resolveRef((obj as Record<string, unknown>).$ref as string, root);
  }
  return (obj as Record<string, unknown>) ?? {};
}

function extractParameters(
  operation: Record<string, unknown>,
  _isV2: boolean,
  root: Record<string, unknown>,
): OpenAPIParameter[] {
  const rawParams = (operation.parameters as unknown[]) || [];
  return rawParams
    .map((p) => maybeResolve(p, root))
    .filter((p) => p.in && p.in !== "body")
    .map((p) => ({
      name: p.name as string,
      in: p.in as OpenAPIParameter["in"],
      type: (p.type || (p.schema as Record<string, unknown> | undefined)?.type) as
        | string
        | undefined,
      required: !!p.required,
      description: p.description as string | undefined,
    }));
}

function extractRequestBody(
  operation: Record<string, unknown>,
  isV2: boolean,
  root: Record<string, unknown>,
): OpenAPIRequestBody | undefined {
  if (isV2) {
    const bodyParam = ((operation.parameters as unknown[]) || [])
      .map((p) => maybeResolve(p, root))
      .find((p) => p.in === "body");
    if (!bodyParam) return undefined;
    const schema = maybeResolve(bodyParam.schema || {}, root);
    return {
      contentType: "application/json",
      required: !!bodyParam.required,
      properties: extractSchemaProperties(schema, root),
    };
  }

  const reqBody = maybeResolve(operation.requestBody, root);
  if (!reqBody || Object.keys(reqBody).length === 0) return undefined;
  const content = reqBody.content as Record<string, unknown> | undefined;
  if (!content) return undefined;
  const contentType = Object.keys(content)[0];
  if (!contentType) return undefined;
  const schema = maybeResolve(
    (content[contentType] as Record<string, unknown>)?.schema || {},
    root,
  );
  return {
    contentType,
    required: !!reqBody.required,
    properties: extractSchemaProperties(schema, root),
  };
}

function extractSchemaProperties(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
): Record<string, { type?: string; description?: string }> {
  const props: Record<string, { type?: string; description?: string }> = {};
  if (!schema?.properties) return props;
  for (const [key, val] of Object.entries(schema.properties as Record<string, unknown>)) {
    const resolved = maybeResolve(val, root);
    props[key] = {
      type: resolved?.type as string | undefined,
      description: resolved?.description as string | undefined,
    };
  }
  return props;
}
