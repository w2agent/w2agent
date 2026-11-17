import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import { normalizeFormMethod } from "./form-tools.js";
import { oneLine } from "./markdown-text.js";
import type { ExtractedForm, ExtractedFormField, PageMarkdown } from "./types.js";

// Use cheerio's return types directly — Cheerio<any> works for all node operations
type CheerioNode = ReturnType<CheerioAPI>;

export function htmlToMarkdown(html: string, url: string): PageMarkdown {
  const $ = cheerio.load(html);

  const title = oneLine($("title").first().text()) || oneLine($("h1").first().text());

  const description = oneLine($('meta[name="description"]').attr("content") ?? "");

  const forms = extractForms($);

  $("script, style, noscript, iframe, svg, template").remove();

  const mainContent = extractMainContent($);
  const markdown = convertToMarkdown($, mainContent);

  return { url, title, description, markdown, forms };
}

function extractForms($: CheerioAPI): ExtractedForm[] | undefined {
  const forms: ExtractedForm[] = [];

  $("form").each((_, el) => {
    const $form = $(el);
    const action = $form.attr("action");
    if (!action) return;
    const method = normalizeFormMethod($form.attr("method"));
    if (!method) return;

    const fields: ExtractedFormField[] = [];
    const byName = new Map<string, ExtractedFormField>();
    let hasPassword = false;
    const controls = "input, select, textarea";
    const formId = $form.attr("id");
    // Controls outside the <form> that point at it with form="id" belong to it too.
    const associated = formId
      ? $(controls).filter((_, c) => $(c).attr("form") === formId && $form.find(c).length === 0)
      : $();
    $form
      .find(controls)
      .add(associated)
      .each((_, input) => {
        const $input = $(input);
        const name = $input.attr("name");
        const type = (
          $input.attr("type") ||
          ($input.is("textarea") ? "textarea" : $input.is("select") ? "select" : "text")
        ).toLowerCase();
        if (type === "password") hasPassword = true;
        if (!name || type === "hidden" || type === "submit") return;

        const required = $input.attr("required") !== undefined;
        const existing = byName.get(name);
        if (existing) {
          const value = $input.attr("value") ?? "on";
          if (existing.type === type && type === "radio") {
            if (existing.options && !existing.options.includes(value)) existing.options.push(value);
            if (required) existing.required = true;
          } else if (existing.type === type && type === "checkbox") {
            if (!existing.options) {
              existing.options = existing.value !== undefined ? [existing.value] : [];
              delete existing.value;
              delete existing.label;
            }
            if (!existing.options.includes(value)) existing.options.push(value);
            if (required) existing.required = true;
          }
          return;
        }

        const field: ExtractedFormField = { name, type, required };

        if (type === "radio") {
          field.options = [$input.attr("value") ?? "on"];
          byName.set(name, field);
          fields.push(field);
          return;
        }
        if (type === "checkbox") field.value = $input.attr("value") ?? "on";

        const id = $input.attr("id");
        if (id) {
          const label = $(`label[for="${id}"]`).text().trim();
          if (label) field.label = label;
        }
        if (!field.label) {
          const ariaLabel = $input.attr("aria-label");
          if (ariaLabel) field.label = ariaLabel;
        }

        if ($input.is("select")) {
          const options: string[] = [];
          $input.find("option").each((_, opt) => {
            const val = $(opt).attr("value");
            if (val) options.push(val);
          });
          if (options.length > 0) field.options = options;
        }

        const pattern = $input.attr("pattern");
        if (pattern) field.pattern = pattern;
        const min = $input.attr("min");
        if (min) field.min = min;
        const max = $input.attr("max");
        if (max) field.max = max;
        const maxlength = $input.attr("maxlength");
        if (maxlength) field.maxlength = parseInt(maxlength, 10);

        byName.set(name, field);
        fields.push(field);
      });

    if (fields.length > 0 && !hasPassword) {
      const formName = $form.attr("name");
      forms.push({
        action,
        method,
        fields,
        ...(formId ? { id: formId } : {}),
        ...(formName ? { name: formName } : {}),
      });
    }
  });

  return forms.length > 0 ? forms : undefined;
}

function extractMainContent($: CheerioAPI): CheerioNode {
  const main = $("main");
  if (main.length > 0 && main.text().trim().length > 100) return main;

  const article = $("article");
  if (article.length > 0 && article.text().trim().length > 100) return article;

  const roleMain = $('[role="main"]');
  if (roleMain.length > 0 && roleMain.text().trim().length > 100) return roleMain;

  const body = $("body");
  if (body.length === 0) return $.root();

  let bestNode: CheerioNode = body;
  let bestScore = 0;

  body.children().each((_, el: any) => {
    const $el = $(el);
    const tag = el.tagName?.toLowerCase() || "";

    if (["nav", "header", "footer", "aside"].includes(tag)) return;
    const id = ($el.attr("id") || "").toLowerCase();
    const cls = ($el.attr("class") || "").toLowerCase();
    if (/(nav|menu|sidebar|footer|header|cookie|banner|ad[s]?)\b/.test(`${id} ${cls}`)) return;

    const text = $el.text().trim();
    const textLen = text.length;
    if (textLen < 50) return;

    const htmlLen = ($el.html() || "").length || 1;
    const density = textLen / htmlLen;
    const score = textLen * density;

    if (score > bestScore) {
      bestScore = score;
      bestNode = $el;
    }
  });

  return bestNode;
}

function convertToMarkdown($: CheerioAPI, root: CheerioNode): string {
  const lines: string[] = [];
  processNode($, root, lines, 0);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function processNode($: CheerioAPI, node: CheerioNode, lines: string[], listDepth: number): void {
  node.contents().each((_, child: any) => {
    if (child.type === "text") {
      const text = child.data || "";
      const trimmed = text.replace(/\s+/g, " ");
      if (trimmed.trim()) {
        lines.push(trimmed);
      }
      return;
    }

    if (child.type !== "tag") return;

    const tag = child.tagName?.toLowerCase() || "";
    const $el = $(child);

    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = parseInt(tag[1], 10);
        const text = $el.text().trim();
        if (text) {
          lines.push("");
          lines.push(`${"#".repeat(level)} ${text}`);
          lines.push("");
        }
        break;
      }

      case "p": {
        const text = inlineContent($, $el);
        if (text.trim()) {
          lines.push("");
          lines.push(text.trim());
          lines.push("");
        }
        break;
      }

      case "br":
        lines.push("");
        break;

      case "hr":
        lines.push("");
        lines.push("---");
        lines.push("");
        break;

      case "blockquote": {
        const text = inlineContent($, $el);
        if (text.trim()) {
          lines.push("");
          for (const line of text.trim().split("\n")) {
            lines.push(`> ${line}`);
          }
          lines.push("");
        }
        break;
      }

      case "pre": {
        const code = $el.find("code");
        const lang = code.attr("class")?.match(/language-(\w+)/)?.[1] || "";
        const text = code.length > 0 ? code.text() : $el.text();
        lines.push("");
        lines.push(`\`\`\`${lang}`);
        lines.push(text);
        lines.push("```");
        lines.push("");
        break;
      }

      case "code": {
        if (!$el.parent("pre").length) {
          lines.push(`\`${$el.text()}\``);
        }
        break;
      }

      case "ul":
      case "ol": {
        lines.push("");
        let idx = 1;
        $el.children("li").each((_, li: any) => {
          const indent = "  ".repeat(listDepth);
          const prefix = tag === "ol" ? `${idx}. ` : "- ";
          const text = inlineContent($, $(li));
          if (text.trim()) {
            lines.push(indent + prefix + text.trim());
          }
          $(li)
            .children("ul, ol")
            .each((_, nested: any) => {
              processNode($, $(nested), lines, listDepth + 1);
            });
          idx++;
        });
        lines.push("");
        break;
      }

      case "table": {
        const rows: string[][] = [];
        $el.find("tr").each((_, tr: any) => {
          const cells: string[] = [];
          $(tr)
            .find("th, td")
            .each((_, cell: any) => {
              cells.push($(cell).text().trim());
            });
          if (cells.length > 0) rows.push(cells);
        });

        if (rows.length > 0) {
          lines.push("");
          const maxCols = Math.max(...rows.map((r) => r.length));
          const normalized = rows.map((r) => {
            while (r.length < maxCols) r.push("");
            return r;
          });

          lines.push(`| ${normalized[0].join(" | ")} |`);
          lines.push(`| ${normalized[0].map(() => "---").join(" | ")} |`);
          for (let i = 1; i < normalized.length; i++) {
            lines.push(`| ${normalized[i].join(" | ")} |`);
          }
          lines.push("");
        }
        break;
      }

      case "img": {
        const alt = $el.attr("alt") || "";
        const src = $el.attr("src") || "";
        if (src) {
          lines.push(`![${alt}](${src})`);
        }
        break;
      }

      case "a":
        break;

      default:
        processNode($, $el, lines, listDepth);
        break;
    }
  });
}

function inlineContent($: CheerioAPI, el: CheerioNode): string {
  let result = "";

  el.contents().each((_, child: any) => {
    if (child.type === "text") {
      result += (child.data || "").replace(/\s+/g, " ");
      return;
    }

    if (child.type !== "tag") return;

    const tag = child.tagName?.toLowerCase() || "";
    const $child = $(child);

    switch (tag) {
      case "a": {
        const href = $child.attr("href") || "";
        const text = $child.text().trim();
        if (href && text) {
          result += `[${text}](${href})`;
        } else if (text) {
          result += text;
        }
        break;
      }
      case "strong":
      case "b":
        result += `**${$child.text().trim()}**`;
        break;
      case "em":
      case "i":
        result += `*${$child.text().trim()}*`;
        break;
      case "code":
        result += `\`${$child.text()}\``;
        break;
      case "br":
        result += "\n";
        break;
      case "img": {
        const alt = $child.attr("alt") || "";
        const src = $child.attr("src") || "";
        if (src) result += `![${alt}](${src})`;
        break;
      }
      default:
        result += inlineContent($, $child);
        break;
    }
  });

  return result;
}
