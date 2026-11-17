import { parseHTML } from "../shared/html-parser.js";
import type { GenerateContext } from "./types.js";

export interface FaqEntry {
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
    allEntries.push(...extractFaqEntries(parsed));
  }

  const deduped = deduplicateByQuestion(filterLowQualityEntries(allEntries));

  if (deduped.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqMainEntity(deduped),
  };
}

export function faqMainEntity(entries: FaqEntry[]): FaqPageSchema["mainEntity"] {
  return entries.map((e) => ({
    "@type": "Question",
    name: e.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: e.answer,
    },
  }));
}

// One page's question/answer entries, filtered and deduped like the site-wide FAQ.
export function extractPageFaqEntries(parsed: ReturnType<typeof parseHTML>): FaqEntry[] {
  return deduplicateByQuestion(filterLowQualityEntries(extractFaqEntries(parsed)));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractFaqEntries(parsed: ReturnType<typeof parseHTML>): FaqEntry[] {
  // Strategy 1: Existing FAQPage JSON-LD (needs no FAQ wording on the page)
  const fromJsonLd = extractFromJsonLd(parsed.jsonLd);
  if (fromJsonLd.length > 0) return fromJsonLd;

  if (!parsed.hasFaqContent) return [];

  const $ = parsed.$;

  // Strategy 2: <details>/<summary> elements
  const fromDetails: FaqEntry[] = [];
  $("details").each((_, el) => {
    const details = $(el).clone();
    const summary = details.find("summary").first();
    const question = collapse(summary.text());
    summary.remove();
    const answer = collapse(details.text());
    if (question && answer) {
      fromDetails.push({ question, answer });
    }
  });
  if (fromDetails.length > 0) return fromDetails;

  // Strategy 3: <dt>/<dd> elements whose term is a question
  const fromDl: FaqEntry[] = [];
  $("dt").each((_, el) => {
    const question = collapse($(el).text());
    if (!question.endsWith("?")) return;
    const answer = collapse($(el).next("dd").text());
    if (question && answer) {
      fromDl.push({ question, answer });
    }
  });
  if (fromDl.length > 0) return fromDl;

  // Strategy 4: Headings ending with "?" (one is an article title, not an FAQ)
  const fromHeadings: FaqEntry[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const text = collapse($(el).text());
    if (!text.endsWith("?")) return;

    const paragraphs: string[] = [];
    let next = $(el).next();
    while (next.length > 0 && !next.is("h1, h2, h3, h4, h5, h6")) {
      if (next.is("p")) {
        const pText = collapse(next.text());
        if (pText) paragraphs.push(pText);
      }
      next = next.next();
    }

    if (paragraphs.length > 0) {
      fromHeadings.push({ question: text, answer: paragraphs.join(" ") });
    }
  });
  if (fromHeadings.length >= 2) return fromHeadings;

  return [];
}

function hasType(node: Record<string, unknown>, type: string): boolean {
  const t = node["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectFaqPages(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectFaqPages(child, out);
    return;
  }
  if (!isRecord(node)) return;
  if (hasType(node, "FAQPage")) out.push(node);
  if (node["@graph"] !== undefined) collectFaqPages(node["@graph"], out);
}

function firstAnswerText(accepted: unknown): string {
  for (const a of asList(accepted)) {
    if (isRecord(a) && typeof a.text === "string" && a.text.trim()) return a.text;
  }
  return "";
}

function extractFromJsonLd(jsonLdItems: unknown[]): FaqEntry[] {
  const entries: FaqEntry[] = [];
  const pages: Record<string, unknown>[] = [];
  collectFaqPages(jsonLdItems, pages);

  for (const page of pages) {
    if (page.mainEntity === undefined) continue;
    for (const entity of asList(page.mainEntity)) {
      if (!isRecord(entity) || !hasType(entity, "Question")) continue;
      if (typeof entity.name !== "string") continue;
      const question = entity.name;
      const answer = firstAnswerText(entity.acceptedAnswer);
      if (question && answer) {
        entries.push({ question, answer });
      }
    }
  }

  return entries;
}

function filterLowQualityEntries(entries: FaqEntry[]): FaqEntry[] {
  return entries.filter((e) => e.question.length > 10 && e.answer.length > 20);
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
