import { parseHTML } from "../shared/html-parser.js";
import type { GenerateContext } from "./types.js";

interface FaqEntry {
  question: string;
  answer: string;
}

interface FaqPageSchema {
  "@context": "https://schema.org";
  "@type": "FAQPage";
  mainEntity: {
    "@type": "Question";
    name: string;
    acceptedAnswer: { "@type": "Answer"; text: string };
  }[];
}

export function generateFaq(ctx: GenerateContext): FaqPageSchema | null {
  const allEntries: FaqEntry[] = [];

  for (const page of ctx.rawPages) {
    if (page.status !== 200 || !page.html) continue;

    const parsed = parseHTML(page.html);
    if (!parsed.hasFaqContent) continue;

    const entries = extractFaqEntries(parsed);
    allEntries.push(...entries);
  }

  const deduped = deduplicateByQuestion(allEntries);

  if (deduped.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: deduped.map((e) => ({
      "@type": "Question",
      name: e.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: e.answer,
      },
    })),
  };
}

function extractFaqEntries(parsed: ReturnType<typeof parseHTML>): FaqEntry[] {
  // Strategy 1: Existing FAQPage JSON-LD
  const fromJsonLd = extractFromJsonLd(parsed.jsonLd);
  if (fromJsonLd.length > 0) return fromJsonLd;

  const $ = parsed.$;

  // Strategy 2: <details>/<summary> elements
  const fromDetails: FaqEntry[] = [];
  $("details").each((_, el) => {
    const question = $(el).find("summary").first().text().trim();
    const summaryHtml = $(el).find("summary").first().html() || "";
    const fullHtml = $(el).html() || "";
    const answer = fullHtml
      .replace(summaryHtml, "")
      .replace(/<summary>.*?<\/summary>/gi, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (question && answer) {
      fromDetails.push({ question, answer });
    }
  });
  if (fromDetails.length > 0) return fromDetails;

  // Strategy 3: <dt>/<dd> elements
  const fromDl: FaqEntry[] = [];
  $("dt").each((_, el) => {
    const question = $(el).text().trim();
    const dd = $(el).next("dd");
    const answer = dd.text().trim();
    if (question && answer) {
      fromDl.push({ question, answer });
    }
  });
  if (fromDl.length > 0) return fromDl;

  // Strategy 4: Headings ending with "?"
  const fromHeadings: FaqEntry[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const text = $(el).text().trim();
    if (!text.endsWith("?")) return;

    const paragraphs: string[] = [];
    let next = $(el).next();
    while (next.length > 0 && !next.is("h1, h2, h3, h4, h5, h6")) {
      if (next.is("p")) {
        const pText = next.text().trim();
        if (pText) paragraphs.push(pText);
      }
      next = next.next();
    }

    if (paragraphs.length > 0) {
      fromHeadings.push({ question: text, answer: paragraphs.join(" ") });
    }
  });
  if (fromHeadings.length > 0) return fromHeadings;

  return [];
}

function extractFromJsonLd(jsonLdItems: unknown[]): FaqEntry[] {
  const entries: FaqEntry[] = [];

  for (const item of jsonLdItems) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj["@type"] !== "FAQPage") continue;

    const mainEntity = obj.mainEntity;
    if (!Array.isArray(mainEntity)) continue;

    for (const entity of mainEntity) {
      if (!entity || typeof entity !== "object") continue;
      const q = entity as Record<string, unknown>;
      if (q["@type"] !== "Question") continue;

      const question = String(q.name || "");
      const accepted = q.acceptedAnswer as Record<string, unknown> | undefined;
      const answer = String(accepted?.text || "");

      if (question && answer) {
        entries.push({ question, answer });
      }
    }
  }

  return entries;
}

function deduplicateByQuestion(entries: FaqEntry[]): FaqEntry[] {
  const seen = new Set<string>();
  const result: FaqEntry[] = [];

  for (const entry of entries) {
    const key = entry.question.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }

  return result;
}
