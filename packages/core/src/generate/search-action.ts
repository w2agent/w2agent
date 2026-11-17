import { isOriginAllowed } from "../shared/url-policy.js";

export interface SearchActionTemplate {
  template: string;
  placeholder: string;
}

const DEFAULT_PLACEHOLDER = "search_term_string";
const MAX_TEMPLATE_LENGTH = 2048;
const MAX_DEPTH = 8;
const MAX_NODES = 5000;
const PROBE = "w2aprobe0queryvalue0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasType(node: Record<string, unknown>, type: string): boolean {
  const t = node["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
}

function placeholderName(queryInput: unknown): string {
  if (isRecord(queryInput)) {
    const valueName = queryInput.valueName;
    return typeof valueName === "string" && /^[A-Za-z0-9_-]+$/.test(valueName)
      ? valueName
      : DEFAULT_PLACEHOLDER;
  }
  const text = queryInput;
  if (typeof text !== "string") return DEFAULT_PLACEHOLDER;
  const match = /(?:^|\s)name=([A-Za-z0-9_-]+)(?:\s|$)/.exec(text);
  return match ? match[1] : DEFAULT_PLACEHOLDER;
}

// Bounded like the walk itself: a hostile target nested thousands of arrays deep must not
// overflow the stack.
function templatesOf(target: unknown): string[] {
  const out: string[] = [];
  const stack: Array<{ node: unknown; depth: number }> = [{ node: target, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    visited++;
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) {
      if (depth < MAX_DEPTH)
        for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], depth: depth + 1 });
    } else if (isRecord(node) && typeof node.urlTemplate === "string") out.push(node.urlTemplate);
  }
  return out;
}

// Backslash, whitespace and control characters are parsed differently by URL parsers.
function hasUnsafeChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === "\\" || code <= 0x20 || code === 0x7f || /\s/.test(ch)) return true;
  }
  return false;
}

// A template is usable only when the placeholder sits purely in the query string, the
// template holds no other variable and no userinfo, and the resolved URL passes the same
// origin policy as form actions. Returns the absolute template, or null.
function acceptTemplate(
  raw: string,
  placeholder: string,
  baseOrigin: string,
  allowedHosts: string[] | undefined,
): string | null {
  if (raw.length > MAX_TEMPLATE_LENGTH || hasUnsafeChar(raw)) return null;
  let template = raw;
  if (template.startsWith("/") && !template.startsWith("//")) template = baseOrigin + template;
  const token = `{${placeholder}}`;
  const q = template.indexOf("?");
  const hash = template.indexOf("#");
  if (q === -1 || (hash !== -1 && hash < q)) return null;
  const head = template.slice(0, q);
  const rest = template.slice(q);
  const queryEnd = rest.indexOf("#");
  const query = queryEnd === -1 ? rest : rest.slice(0, queryEnd);
  const tail = queryEnd === -1 ? "" : rest.slice(queryEnd);
  if (head.includes("{") || head.includes("}") || tail.includes("{") || tail.includes("}")) {
    return null;
  }
  if (!query.includes(token)) return null;
  if (/[{}]/.test(query.split(token).join(""))) return null;
  if (template.includes(PROBE)) return null;
  let probe: URL;
  try {
    probe = new URL(template.split(token).join(PROBE));
  } catch {
    return null;
  }
  if (probe.username || probe.password) return null;
  if (!isOriginAllowed(probe.href, baseOrigin, allowedHosts)) return null;
  // Return the URL as a WHATWG parser normalises it, so what the agent receives is what
  // was checked. The placeholder must survive in the query part.
  const normalised = probe.href.split(PROBE).join(token);
  const normalisedQuery = normalised.slice(normalised.indexOf("?"));
  if (!normalisedQuery.includes(token) || normalised.indexOf(token) < normalised.indexOf("?")) {
    return null;
  }
  return normalised;
}

export function findSearchAction(
  jsonLd: unknown[],
  baseOrigin: string,
  allowedHosts: string[] | undefined,
): SearchActionTemplate | null {
  const stack: Array<{ node: unknown; depth: number }> = [];
  for (let i = jsonLd.length - 1; i >= 0; i--) stack.push({ node: jsonLd[i], depth: 0 });
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (typeof node !== "object" || node === null) continue;
    visited++;
    if (Array.isArray(node)) {
      if (depth < MAX_DEPTH)
        for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], depth: depth + 1 });
      continue;
    }
    if (!isRecord(node)) continue;
    if (hasType(node, "SearchAction")) {
      const placeholder = placeholderName(node["query-input"]);
      for (const raw of templatesOf(node.target)) {
        const template = acceptTemplate(raw, placeholder, baseOrigin, allowedHosts);
        if (template) return { template, placeholder };
      }
    }
    if (depth < MAX_DEPTH) {
      const children = Object.values(node);
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i], depth: depth + 1 });
      }
    }
  }
  return null;
}
