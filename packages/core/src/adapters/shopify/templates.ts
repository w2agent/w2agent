import { mdUrl } from "../../generate/markdown-text.js";
import type { GeneratedFile } from "../../generate/types.js";
import type { ProductSchemaState } from "./product-schema.js";

export function liquidSafeRobotsLine(line: string): string {
  if (/[\r\n]/.test(line)) throw new Error("robots.txt line contains a line break");
  return line.replace(/\{/g, "%7B").replace(/\}/g, "%7D");
}

export function shopifyRobotsAdditions(groups: string[][]): string {
  if (groups.length === 0) return "";
  return `${groups.map((g) => g.map(liquidSafeRobotsLine).join("\n")).join("\n\n")}\n`;
}

export function liquidInert(text: string): string {
  return text.replace(/\{(?=[{%])/g, "{{ '{' }}");
}

export function shopifyLlmsTxtSuffix(siteUrl: string): string {
  const agentsUrl = mdUrl(`${new URL(siteUrl).origin}/agents.md`);
  return liquidInert(
    `\n## Optional\n\n- [Shopify agent instructions](${agentsUrl}): Store-managed instructions for AI agents\n`,
  );
}

export function shopifyLlmsTxtLiquid(llmsTxtContent: string, siteUrl: string): string {
  return liquidInert(llmsTxtContent) + shopifyLlmsTxtSuffix(siteUrl);
}

export interface ShopifyIntegrationOptions {
  webmcp?: boolean;
  mcpWebhook?: boolean;
  productSchema?: ProductSchemaState;
}

const PRODUCT_SCHEMA_BLOCK = `{% if request.page_type == 'product' and product %}
<script type="application/ld+json">
  {{ product | structured_data }}
</script>
{% endif %}
`;

function productSchemaNote(state: ProductSchemaState): string {
  const manual = `Search your theme code for \`structured_data\` and for any \`application/ld+json\` Product script first. If neither outputs Product schema, add this to \`snippets/w2agent-head.liquid\`:

\`\`\`liquid
${PRODUCT_SCHEMA_BLOCK}\`\`\``;
  if (state === "present") {
    return "Your theme already outputs Product schema on the crawled product pages, so the head snippet does not add a second block. You have nothing to add.";
  }
  if (state === "absent") {
    return `The crawled product pages had no Product schema, so the head snippet adds it with Shopify's \`structured_data\` filter (Product, or ProductGroup when the product has variants). Search your theme code for \`structured_data\` first. If it already outputs the schema, delete the \`{% if request.page_type == 'product' and product %}\` block from \`snippets/w2agent-head.liquid\`.`;
  }
  return `w2agent had no crawled product page to check, so it could not tell whether your theme outputs Product schema and did not add one.\n\n${manual}`;
}

export function generateShopifyIntegration(
  llmsTxtContent: string,
  robotsGroups: string[][],
  siteUrl: string,
  options: ShopifyIntegrationOptions = {},
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const robotsAdditions = shopifyRobotsAdditions(robotsGroups);
  const hasRobots = robotsAdditions !== "";

  const productSchema = options.productSchema ?? "unknown";
  const headSnippet = `{% comment %}
  w2agent AI Readiness — Add to theme.liquid inside <head>
{% endcomment %}
<link rel="alternate" type="text/markdown" href="/llms.txt" title="LLMs.txt">
${productSchema === "absent" ? `\n${PRODUCT_SCHEMA_BLOCK}` : ""}`;

  const pushFiles = ["snippets/w2agent-head.liquid"];
  if (options.webmcp) pushFiles.push("snippets/w2agent-webmcp.liquid");

  const steps: string[] = [
    `### Work on a copy of your theme
Duplicate your live theme in **Online Store → Themes → ⋯ → Duplicate**. Make every edit below in the copy, either in its **Edit code** or locally followed by the push step. Do not edit the live theme.`,
    `### Add head snippet
1. In the copy, open \`layout/theme.liquid\`
2. Paste the contents of \`snippets/w2agent-head.liquid\` inside the \`<head>\` tag
   - Or keep it as a snippet and include it with \`{% render 'w2agent-head' %}\``,
    `### Optional: override /llms.txt
Shopify already serves \`/llms.txt\` for every store. Keep that default unless you want the content w2agent generated.
\`templates/llms.txt.liquid\` replaces the managed content at \`/llms.txt\` only; \`/agents.md\` is not affected. Delete the file to go back to the default.
1. In the copy, under **Templates**, add a new file named \`llms.txt.liquid\` and paste the contents of \`templates/llms.txt.liquid\`
   - Or copy the file into the theme's \`templates/\` folder and push it (see the push step)
2. Shopify renders this template with only the \`request\` and \`agents\` objects, so the file uses no other objects.`,
  ];

  if (options.webmcp) {
    steps.push(`### Render the WebMCP snippet
1. In the copy, open \`layout/theme.liquid\`
2. Add \`{% render 'w2agent-webmcp' %}\` just before \`</body>\``);
  }

  if (hasRobots) {
    steps.push(`### Allow AI agents in robots.txt (Shopify 2.0+)
Your live robots.txt blocks AI agents through \`User-agent: *\`. The groups in \`data/robots-txt-additions.txt\` allow only agents that no \`User-agent\` line names; a block you wrote for a named agent stays. That file is for pasting; it is not a theme file, so do not upload it.
1. In the copy, open the existing \`templates/robots.txt.liquid\` and paste the groups at its end, after the \`robots.default_groups\` loop and your own rules.
2. If the theme has no \`templates/robots.txt.liquid\`, the block comes from elsewhere. Do not create one from these groups alone: it would replace Shopify's default rules.`);
  }

  const pushList = [...pushFiles, "layout/theme.liquid", "templates/llms.txt.liquid"];
  if (hasRobots) pushList.push("templates/robots.txt.liquid");
  steps.push(`### Push to the copy, then publish
If you edited locally, push to the copy (not the live theme). \`layout/theme.liquid\` carries the render tags, so push it with the snippets.
\`\`\`bash
shopify theme push --theme <copy-theme-id-or-name> ${pushList.map((f) => `--only ${f}`).join(" ")}
\`\`\`
Drop \`templates/llms.txt.liquid\` if you keep Shopify's default.${hasRobots ? " Drop `templates/robots.txt.liquid` if you did not paste the robots groups." : ""} Preview the copy, then publish it from the admin.`);

  const stepsMd = steps.map((s, i) => s.replace(/^### /, `### ${i + 1}. `)).join("\n\n");

  const refs = [
    "  snippets/w2agent-head.liquid        ← Paste in theme.liquid <head>",
    ...(options.webmcp
      ? ["  snippets/w2agent-webmcp.liquid      ← Render before </body> in theme.liquid"]
      : []),
    "  templates/llms.txt.liquid           ← Optional /llms.txt override",
    ...(hasRobots
      ? [
          "  data/robots-txt-additions.txt       ← Not a theme file; allow groups to paste at the end of templates/robots.txt.liquid",
        ]
      : []),
    ...(options.mcpWebhook
      ? [
          "  W2AGENT-MCP-WEBHOOK.md              ← Not a theme file; webhook notes for the MCP server",
        ]
      : []),
  ].join("\n");

  const installMd = `# w2agent Shopify Integration — Installation

## Setup Steps

${stepsMd}

## File Reference

\`\`\`
shopify/
${refs}
\`\`\`

## Product schema

${productSchemaNote(productSchema)}

## Notes

- Shopify serves \`${new URL(siteUrl).origin}/llms.txt\` by default. The template is only an override.
- Theme folders are \`assets\`, \`blocks\`, \`config\`, \`layout\`, \`locales\`, \`sections\`, \`snippets\` and \`templates\`; other folders are not supported.

## Regenerating

Run \`w2agent generate ${siteUrl}\` again and update the snippets and the template.
`;

  files.push(makeFile("shopify/snippets/w2agent-head.liquid", headSnippet));
  files.push(
    makeFile("shopify/templates/llms.txt.liquid", shopifyLlmsTxtLiquid(llmsTxtContent, siteUrl)),
  );
  if (hasRobots) {
    files.push(makeFile("shopify/data/robots-txt-additions.txt", robotsAdditions));
  }
  files.push(makeFile("shopify/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
