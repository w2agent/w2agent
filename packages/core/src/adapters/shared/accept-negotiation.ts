export type SourceLang = "ts" | "js";

// Source of the homepage Accept negotiation, emitted verbatim into generated
// middleware. Self-contained and strict-TS valid: no imports, no backticks.
// One source renders both languages: type annotations appear only for "ts".
export function homeVariantSource(lang: SourceLang): string {
  const t = (annotation: string) => (lang === "ts" ? annotation : "");
  return `${t(`type HomeVariant = "markdown" | "plain" | "html";\n\n`)}// Most specific matching Accept range decides q. Markdown wins equal-q ties
// when explicitly listed; text/plain must beat text/html strictly (generic
// clients list text/plain next to */*).
function splitOutsideQuotes(value${t(": string")}, separator${t(": string")})${t(": string[]")} {
  const parts${t(": string[]")} = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (quoted && char === "\\\\") {
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

function homeVariant(accept${t(": string | null")})${t(": HomeVariant")} {
  if (!accept || !accept.trim()) return "html";
  const ranges${t(": { type: string; q: number }[]")} = [];
  for (const part of splitOutsideQuotes(accept, ",")) {
    const [rawType = "", ...params] = splitOutsideQuotes(part, ";");
    const type = rawType.trim().toLowerCase();
    if (!type) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\\s*q\\s*=\\s*(\\S+)\\s*$/i.exec(param);
      if (!match) continue;
      const n = Number(match[1]);
      q = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
    }
    ranges.push({ type, q });
  }
  const quality = (type${t(": string")})${t(": number")} => {
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
  const listed = (type${t(": string")}) => ranges.some((range) => range.type === type);
  const html = quality("text/html");
  const markdown = quality("text/markdown");
  const plain = quality("text/plain");
  if (listed("text/markdown") && markdown > 0 && markdown >= html) return "markdown";
  if (listed("text/plain") && plain > 0 && plain > html) return "plain";
  return "html";
}`;
}

export const HOME_VARIANT_SOURCE = homeVariantSource("ts");
