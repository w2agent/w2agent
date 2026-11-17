// biome-ignore-all lint/style/useTemplate: negotiation function is kept byte-identical to the core template (drift-guarded)
import { appendResponseHeader, defineEventHandler, getRequestHeader, sendRedirect } from "h3";

type HomeVariant = "markdown" | "plain" | "html";

// Most specific matching Accept range decides q. Markdown wins equal-q ties
// when explicitly listed; text/plain must beat text/html strictly (generic
// clients list text/plain next to */*).
function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (quoted && char === "\\") {
      current += char + value.charAt(++i);
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function homeVariant(accept: string | null): HomeVariant {
  if (!accept || !accept.trim()) return "html";
  const ranges: { type: string; q: number }[] = [];
  for (const part of splitOutsideQuotes(accept, ",")) {
    const [rawType = "", ...params] = splitOutsideQuotes(part, ";");
    const type = rawType.trim().toLowerCase();
    if (!type) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*(\S+)\s*$/i.exec(param);
      if (!match) continue;
      const n = Number(match[1]);
      q = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
    }
    ranges.push({ type, q });
  }
  const quality = (type: string): number => {
    const wildcard = type.slice(0, type.indexOf("/")) + "/*";
    let best = 0;
    let bestQ = 0;
    for (const range of ranges) {
      const rank =
        range.type === type ? 3 : range.type === wildcard ? 2 : range.type === "*/*" ? 1 : 0;
      if (rank > best || (rank > 0 && rank === best && range.q > bestQ)) {
        best = rank;
        bestQ = range.q;
      }
    }
    return bestQ;
  };
  const listed = (type: string) => ranges.some((range) => range.type === type);
  const html = quality("text/html");
  const markdown = quality("text/markdown");
  const plain = quality("text/plain");
  if (listed("text/markdown") && markdown > 0 && markdown >= html) return "markdown";
  if (listed("text/plain") && plain > 0 && plain > html) return "plain";
  return "html";
}

export default defineEventHandler((event) => {
  if (event.path.split("?")[0] !== "/") return;

  const variant = homeVariant(getRequestHeader(event, "accept") ?? null);
  appendResponseHeader(event, "Vary", "Accept");
  if (variant === "markdown") return sendRedirect(event, "index.md", 302);
  if (variant === "plain") return sendRedirect(event, "llms.txt", 302);
});
