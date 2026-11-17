import type { GeneratedFile } from "../../generate/types.js";

const SHOPIFY_DEFAULT_GROUPS_LOOP = `{% for group in robots.default_groups %}
  {{- group.user_agent }}

  {%- for rule in group.rules -%}
    {{ rule }}
  {%- endfor -%}

  {%- if group.sitemap != blank %}
    {{ group.sitemap }}
  {%- endif %}
{% endfor %}`;

export function liquidSafeRobotsLine(line: string): string {
  if (/[\r\n]/.test(line)) throw new Error("robots.txt line contains a line break");
  return line.replace(/\{/g, "%7B").replace(/\}/g, "%7D");
}

export function shopifyRobotsAdditions(groups: string[][]): string {
  if (groups.length === 0) return "";
  return `${groups.map((g) => g.map(liquidSafeRobotsLine).join("\n")).join("\n\n")}\n`;
}

export function generateShopifyIntegration(
  llmsTxtContent: string,
  robotsGroups: string[][],
  siteUrl: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const robotsAdditions = shopifyRobotsAdditions(robotsGroups);
  const hasRobots = robotsAdditions !== "";

  const headSnippet = `{% comment %}
  w2agent AI Readiness — Add to theme.liquid inside <head>
{% endcomment %}
<link rel="alternate" type="text/markdown" href="/pages/llms-txt" title="LLMs.txt">

{% if template contains 'product' %}
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": {{ product.title | json }},
  "description": {{ product.description | strip_html | json }},
  "url": "{{ shop.url }}{{ product.url }}",
  "image": "{{ product.featured_image | image_url: width: 1200 }}",
  "brand": {
    "@type": "Brand",
    "name": {{ product.vendor | json }}
  },
  "offers": {
    "@type": "Offer",
    "price": {{ product.price | money_without_currency | json }},
    "priceCurrency": {{ shop.currency | json }},
    "availability": "{% if product.available %}https://schema.org/InStock{% else %}https://schema.org/OutOfStock{% endif %}",
    "url": "{{ shop.url }}{{ product.url }}"
  }
}
</script>
{% endif %}
`;

  const robotsTxtLiquid = `${SHOPIFY_DEFAULT_GROUPS_LOOP}

${robotsAdditions}`;

  const robotsStep = hasRobots
    ? `
### 3. Allow AI agents in robots.txt (Shopify 2.0+)
Your robots.txt blocks AI agents through the \`*\` group. The groups below allow only the agents that no \`User-agent\` line names; a block you wrote for a named agent stays.
1. Go to **Online Store → Themes → Edit Code**
2. If \`templates/robots.txt.liquid\` does not exist, create it with the contents of \`templates/robots.txt.liquid\` from this package. It keeps Shopify's default rules through \`robots.default_groups\` and adds the groups after them.
3. If it already exists, paste the groups from \`data/robots-txt-additions.txt\` after the \`{% endfor %}\` of its \`robots.default_groups\` loop. If it has no such loop, add Shopify's loop first.
`
    : "";

  const robotsRef = hasRobots
    ? `  templates/robots.txt.liquid    ← Shopify defaults + AI agent Allow groups
  data/robots-txt-additions.txt  ← The Allow groups alone (paste after the default_groups loop)
`
    : "";

  const installMd = `# w2agent Shopify Integration — Installation

## Setup Steps

### 1. Add head snippet
1. Go to **Online Store → Themes → Edit Code**
2. Open \`layout/theme.liquid\`
3. Paste the contents of \`snippets/w2agent-head.liquid\` inside the \`<head>\` tag
   - Or save as a snippet and include with \`{% render 'w2agent-head' %}\`

### 2. Create llms.txt page
1. Go to **Online Store → Pages → Add page**
2. Title: "llms-txt" (URL handle will be \`/pages/llms-txt\`)
3. Paste the contents of \`data/llms.txt\` as the page content

${robotsStep}
## File Reference

\`\`\`
shopify/
  snippets/w2agent-head.liquid   ← Paste in theme.liquid <head>
${robotsRef}  data/llms.txt                  ← Content for pages/llms-txt
\`\`\`

## Notes

- Shopify doesn't support serving arbitrary files at custom paths. The llms.txt content is served via a Shopify Page.
- For a custom domain, the URL will be \`${siteUrl}/pages/llms-txt\`

## Regenerating

Run \`w2agent generate ${siteUrl}\` again and update the page content and snippets.
`;

  files.push(makeFile("shopify/snippets/w2agent-head.liquid", headSnippet));
  files.push(makeFile("shopify/data/llms.txt", llmsTxtContent));
  if (hasRobots) {
    files.push(makeFile("shopify/templates/robots.txt.liquid", robotsTxtLiquid));
    files.push(makeFile("shopify/data/robots-txt-additions.txt", robotsAdditions));
  }
  files.push(makeFile("shopify/INSTALL.md", installMd));

  return files;
}

function makeFile(filename: string, content: string): GeneratedFile {
  return { filename, content, size: new TextEncoder().encode(content).length };
}
