import { guardedFetch } from "../../shared/fetcher.js";
import type { AuditOptions, McpInitResult } from "../types.js";
import { parseMcpResourceLink } from "./oauth-parser.js";

export const MCP_CANDIDATE_CAP = 5;
const MCP_HREF_CANDIDATE_CAP = 2;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const MODERN_ERROR_CODES = new Set([-32020, -32021, -32022]);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SSE_ENDPOINT_BYTES = 4 * 1024;
const CLIENT_INFO = { name: "w2agent-audit", version: "0.1.0" };

const DISCOVER_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
});

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
});

const BASE_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function isIpOrLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

function looksLikeMcpEndpoint(url: URL): boolean {
  const path = url.pathname.replace(/\/+$/, "");
  return path.endsWith("/mcp") || path.endsWith("/sse") || url.hostname.startsWith("mcp.");
}

function siteApex(baseUrl: string): string {
  return new URL(baseUrl).hostname.replace(/^www\./, "");
}

function isSameSite(apex: string, hostname: string): boolean {
  return hostname === apex || hostname.endsWith(`.${apex}`);
}

export function buildMcpCandidates(baseUrl: string, homepageHtml: string): string[] {
  const base = new URL(baseUrl);
  const apex = siteApex(baseUrl);

  const hrefs: string[] = [];
  for (const [, raw] of homepageHtml.matchAll(/href=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(raw, base);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!isSameSite(apex, url.hostname) || !looksLikeMcpEndpoint(url)) continue;
      url.hash = "";
      if (!hrefs.includes(url.href)) hrefs.push(url.href);
    } catch {
      // skip malformed hrefs
    }
  }

  // P3-3: ai-catalog / ARD manifest entries go here, ahead of homepage hrefs.
  const candidates = hrefs.slice(0, MCP_HREF_CANDIDATE_CAP);
  const fixed = [`${base.origin}/mcp`];
  if (apex.startsWith("mcp.")) {
    fixed.push(`${base.origin}/`);
  } else if (!isIpOrLocalhost(apex)) {
    fixed.push(`${base.protocol}//mcp.${apex}/mcp`, `${base.protocol}//mcp.${apex}/`);
  }
  for (const raw of fixed) {
    const href = new URL(raw).href;
    if (!candidates.includes(href)) candidates.push(href);
  }
  return candidates.slice(0, MCP_CANDIDATE_CAP);
}

function essence(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

function isMcpAuthChallenge(response: Response): boolean {
  const challenge = response.headers.get("www-authenticate") ?? "";
  return (
    response.status === 401 &&
    /(^|,)\s*bearer(\s|,|$)/i.test(challenge) &&
    /(^|[\s,])resource_metadata\s*=/i.test(challenge)
  );
}

async function readCapped(
  response: Response,
  cap: number,
  stopWhen: (text: string) => boolean,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < cap && !stopWhen(text)) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      bytes += value.length;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

interface SseEvent {
  event: string;
  data: string;
}

function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/).slice(0, -1)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line === "" || line.startsWith(":")) continue;
      const idx = line.indexOf(":");
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return events;
}

type JsonRpcMessage = { result?: Record<string, unknown>; error?: { code?: unknown } };

function asJsonRpcResponse(raw: string): JsonRpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.jsonrpc !== "2.0" || !("result" in obj || "error" in obj)) return null;
    return obj as JsonRpcMessage;
  } catch {
    return null;
  }
}

function firstSseJsonRpc(text: string): JsonRpcMessage | null {
  for (const { data } of parseSseEvents(text)) {
    const msg = asJsonRpcResponse(data);
    if (msg) return msg;
  }
  return null;
}

async function readJsonRpc(response: Response): Promise<JsonRpcMessage | null> {
  if (essence(response.headers.get("content-type")) === "text/event-stream") {
    const text = await readCapped(response, MAX_JSON_BYTES, (t) => firstSseJsonRpc(t) !== null);
    return firstSseJsonRpc(text);
  }
  return asJsonRpcResponse(await readCapped(response, MAX_JSON_BYTES, () => false));
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function serverInfoFrom(value: unknown): { name: string; version?: string } | undefined {
  const info = objectOrUndefined(value);
  if (typeof info?.name !== "string" || info.name.trim() === "") return undefined;
  return {
    name: info.name,
    version: typeof info.version === "string" ? info.version : undefined,
  };
}

function resultFrom(
  url: string,
  response: Response,
  transport: McpInitResult["transport"],
): McpInitResult {
  response.body?.cancel().catch(() => {});
  const rawHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    rawHeaders[k.toLowerCase()] = v;
  });
  const result: McpInitResult = {
    mcpEndpointUrl: url,
    success: false,
    status: response.status,
    transport,
    rawHeaders,
    linkHeader: rawHeaders.link,
  };
  if (rawHeaders.link) {
    result.oauthResourceMetadataUrl = parseMcpResourceLink(rawHeaders.link).resourceMetadataUrl;
  }
  return result;
}

type Deadline = { end: number; perRequest: number };
type ProbeContext = {
  apex: string;
  deadline: Deadline;
  options: Pick<AuditOptions, "isAllowedTarget">;
};

const MAX_MCP_REDIRECTS = 3;

async function send(
  url: string,
  init: RequestInit,
  ctx: ProbeContext,
): Promise<{ response: Response; url: string } | null> {
  let current = url;
  for (let hops = 0; ; hops++) {
    const remaining = ctx.deadline.end - Date.now();
    if (remaining <= 0) return null;
    let response: Response;
    try {
      response = await guardedFetch(
        current,
        {
          ...init,
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(ctx.deadline.perRequest, remaining)),
        },
        ctx.options.isAllowedTarget,
      );
    } catch {
      return null;
    }
    if (response.status < 300 || response.status >= 400) return { response, url: current };

    await response.body?.cancel().catch(() => {});
    if ((response.status !== 307 && response.status !== 308) || hops >= MAX_MCP_REDIRECTS) {
      return null;
    }
    let next: URL;
    try {
      next = new URL(response.headers.get("location") ?? "", current);
    } catch {
      return null;
    }
    const isHttp = next.protocol === "http:" || next.protocol === "https:";
    if (!response.headers.has("location") || !isHttp || !isSameSite(ctx.apex, next.hostname)) {
      return null;
    }
    next.hash = "";
    current = next.href;
  }
}

async function probeCandidate(url: string, ctx: ProbeContext): Promise<McpInitResult | null> {
  try {
    const discoverSent = await send(
      url,
      {
        method: "POST",
        headers: {
          ...BASE_HEADERS,
          "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
          "Mcp-Method": "server/discover",
        },
        body: DISCOVER_BODY,
      },
      ctx,
    );
    if (!discoverSent) return null;
    const discover = discoverSent.response;
    if (isMcpAuthChallenge(discover)) {
      return resultFrom(discoverSent.url, discover, "streamable-http");
    }

    const discoverMsg = await readJsonRpc(discover);
    const ok = discover.status >= 200 && discover.status < 300;
    if (ok && Array.isArray(discoverMsg?.result?.supportedVersions)) {
      const confirmed = resultFrom(discoverSent.url, discover, "streamable-http");
      confirmed.success = true;
      const meta = objectOrUndefined(discoverMsg.result._meta);
      confirmed.serverInfo = serverInfoFrom(meta?.["io.modelcontextprotocol/serverInfo"]);
      return confirmed;
    }
    if (MODERN_ERROR_CODES.has(discoverMsg?.error?.code as number)) {
      return resultFrom(discoverSent.url, discover, "streamable-http");
    }
    if (!ok && (discover.status < 400 || discover.status >= 500)) return null;

    const initSent = await send(
      url,
      { method: "POST", headers: BASE_HEADERS, body: INITIALIZE_BODY },
      ctx,
    );
    if (!initSent) return null;
    const init = initSent.response;
    if (isMcpAuthChallenge(init)) return resultFrom(initSent.url, init, "streamable-http");
    const initMsg = await readJsonRpc(init);
    const serverInfo = serverInfoFrom(initMsg?.result?.serverInfo);
    if (init.status >= 200 && init.status < 300 && initMsg?.result && serverInfo) {
      const confirmed = resultFrom(initSent.url, init, "streamable-http");
      confirmed.success = true;
      const result = initMsg.result as {
        capabilities?: { auth?: { type?: string } };
        _meta?: { auth?: { type?: string } };
      };
      confirmed.serverInfo = {
        ...serverInfo,
        authMechanism: result.capabilities?.auth?.type ?? result._meta?.auth?.type,
      };
      return confirmed;
    }
    if (init.status !== 400 && init.status !== 404 && init.status !== 405) return null;

    const sseSent = await send(
      url,
      { method: "GET", headers: { Accept: "text/event-stream" } },
      ctx,
    );
    if (!sseSent) return null;
    const sse = sseSent.response;
    if (isMcpAuthChallenge(sse)) return resultFrom(sseSent.url, sse, "http+sse");
    if (sse.status !== 200 || essence(sse.headers.get("content-type")) !== "text/event-stream") {
      await sse.body?.cancel().catch(() => {});
      return null;
    }
    const firstEvent = (t: string) => parseSseEvents(t)[0];
    const text = await readCapped(sse, MAX_SSE_ENDPOINT_BYTES, (t) => firstEvent(t) !== undefined);
    const event = firstEvent(text);
    return event?.event === "endpoint" && event.data.trim() !== ""
      ? resultFrom(sseSent.url, sse, "http+sse")
      : null;
  } catch {
    return null;
  }
}

export async function probeMcpEndpoint(
  baseUrl: string,
  homepageHtml: string,
  options: Pick<AuditOptions, "timeout" | "isAllowedTarget">,
): Promise<McpInitResult | undefined> {
  const timeout = options.timeout ?? 5000;
  const ctx: ProbeContext = {
    apex: siteApex(baseUrl),
    deadline: {
      end: Date.now() + Math.min(timeout * 3, 15000),
      perRequest: Math.min(timeout, 5000),
    },
    options,
  };
  for (const url of buildMcpCandidates(baseUrl, homepageHtml)) {
    if (Date.now() >= ctx.deadline.end) break;
    const result = await probeCandidate(url, ctx);
    if (result) return result;
  }
  return undefined;
}
