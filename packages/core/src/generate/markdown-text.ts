/** Collapse every whitespace run (newlines, U+2028/2029, NBSP, BOM) to one space and trim. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** CommonMark-safe link text: one line, every inline-significant ASCII punctuation escaped. */
export function mdText(value: string): string {
  return oneLine(value).replace(/[\\`*_[\]<>|&]/g, "\\$&");
}

/** One-line description text: only the characters that start links, images, autolinks or HTML. */
export function mdDescription(value: string): string {
  return oneLine(value).replace(/[\\[\]<>]/g, "\\$&");
}

/**
 * One-line text that starts a Markdown line: `mdDescription` plus a backslash before a leading
 * block marker (heading, quote, list, rule, fence, table, setext underline), so it stays text.
 */
export function mdLine(value: string): string {
  return mdDescription(value)
    .replace(/^[#>+*=_`~|-]/, "\\$&")
    .replace(/^(\d{1,9})([.)])/, "$1\\$2");
}

/** Link destination that survives whitespace, parentheses and angle brackets. */
export function mdUrl(value: string): string {
  return value.replace(/[\s()<>]/g, (c) =>
    encodeURIComponent(c).replace("(", "%28").replace(")", "%29"),
  );
}

// DEL and the C1 range (incl. NEL 0x85), LS, PS, BOM and the two non-characters: YAML does not
// allow them raw inside a double-quoted scalar, JSON.stringify leaves them unescaped.
const YAML_UNSAFE_CODES = new Set([0x2028, 0x2029, 0xfeff, 0xfffe, 0xffff]);

function yamlUnsafe(code: number): boolean {
  return (code >= 0x7f && code <= 0x9f) || YAML_UNSAFE_CODES.has(code);
}

/** One-line YAML double-quoted scalar. */
export function yamlScalar(value: string): string {
  return JSON.stringify(oneLine(value)).replace(/[\s\S]/g, (c) => {
    const code = c.charCodeAt(0);
    return yamlUnsafe(code) ? `\\u${code.toString(16).padStart(4, "0")}` : c;
  });
}

export function yamlFrontmatter(page: { url: string; title: string }): string {
  return `---\nurl: ${yamlScalar(page.url)}\ntitle: ${yamlScalar(page.title)}\n---`;
}

/** First URL path segment, lowercase; empty for the homepage, null for an unparseable URL. */
function firstSegment(url: string): string | null {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  } catch {
    return null;
  }
}

/** True when the page is the homepage or its first path segment is one of `sections`. */
export function matchesSections(url: string, sections?: string[]): boolean {
  if (!sections || sections.length === 0) return true;
  const first = firstSegment(url);
  if (first === null) return false;
  if (first === "") return true;
  return sections.some(
    (s) =>
      s
        .trim()
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase() === first,
  );
}
