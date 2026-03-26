import { parseHTML } from "../shared/html-parser.js";
import type { EcommerceArtifacts } from "./ecommerce.js";
import { generateCommerceToolHandlers } from "./ecommerce.js";
import type { LocalBusinessArtifacts } from "./local-business.js";
import { generateLocalBusinessToolHandlers } from "./local-business.js";
import { generateFaq } from "./faq.js";
import { extractSiteInfo } from "./llms-txt.js";
import type { ExtractedFormField, GenerateContext, GeneratedFile, PageMarkdown } from "./types.js";

// --- Types ---

export interface McpTool {
  name: string;
  description: string;
  condition: string;
}

export interface McpDetectedTools {
  tools: McpTool[];
  hasFaq: boolean;
  hasSearchAction: boolean;
  hasProducts: boolean;
  hasLocalBusiness: boolean;
  forms: DetectedForm[];
}

export interface DetectedForm {
  action: string;
  method: string;
  fields: ExtractedFormField[];
  pageUrl: string;
  id?: string;
  name?: string;
}

export type SelfHostPlatform = "vercel" | "cf";

// --- Public API ---

export function generateMcpServer(
  ctx: GenerateContext,
  selfHost?: SelfHostPlatform,
  artifacts?: EcommerceArtifacts | null,
  localBusinessArtifacts?: LocalBusinessArtifacts | null,
): GeneratedFile[] {
  const { siteName } = extractSiteInfo(ctx.pages, ctx.baseUrl);
  const detected = detectTools(ctx, artifacts, localBusinessArtifacts);
  const dataFiles = generateDataFiles(ctx, artifacts, localBusinessArtifacts);

  if (selfHost === "vercel") {
    return generateVercelTemplate(siteName, ctx.baseUrl, detected, dataFiles);
  }
  if (selfHost === "cf") {
    return generateCloudflareTemplate(siteName, ctx.baseUrl, detected, dataFiles);
  }

  // Default: standalone Express server
  const serverTs = generateServerTs(siteName, ctx.baseUrl, detected);
  const packageJson = generatePackageJson(siteName);
  const tsconfig = generateTsConfig();
  const readme = generateReadme(siteName, detected, ctx.baseUrl);

  const files: GeneratedFile[] = [
    makeFile("mcp-server/server.ts", serverTs),
    makeFile("mcp-server/package.json", packageJson),
    makeFile("mcp-server/tsconfig.json", tsconfig),
    makeFile("mcp-server/README.md", readme),
    ...dataFiles,
  ];

  return files;
}

// --- Tool Detection ---

function inferFormToolName(form: DetectedForm, index: number, usedNames: Set<string>): string {
  let base: string | undefined;

  if (form.id) {
    base = form.id;
  } else if (form.name) {
    base = form.name;
  } else {
    const segment = form.action
      .split("/")
      .filter((s) => s && s !== "#")
      .pop()
      ?.split("?")[0];
    if (segment) base = segment;
  }

  if (!base) {
    const name = `submit-form-${index}`;
    usedNames.add(name);
    return name;
  }

  const sanitized = `submit-${base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 45)}`;

  if (!usedNames.has(sanitized)) {
    usedNames.add(sanitized);
    return sanitized;
  }
  let counter = 2;
  while (usedNames.has(`${sanitized}-${counter}`)) counter++;
  const deduped = `${sanitized}-${counter}`;
  usedNames.add(deduped);
  return deduped;
}

export function detectTools(
  ctx: GenerateContext,
  artifacts?: EcommerceArtifacts | null,
  localBusinessArtifacts?: LocalBusinessArtifacts | null,
): McpDetectedTools {
  const tools: McpTool[] = [];
  let hasFaq = false;
  let hasSearchAction = false;
  const forms: DetectedForm[] = [];

  // Always available
  tools.push({
    name: "list-pages",
    description: "List all pages on the site with titles and URLs",
    condition: "always",
  });
  tools.push({
    name: "get-page",
    description: "Get the full markdown content of a specific page by URL or slug",
    condition: "always",
  });
  tools.push({
    name: "search-site",
    description: "Search site content by keywords with weighted scoring",
    condition: "always",
  });

  // Check for FAQ content
  const faqData = generateFaq(ctx);
  if (faqData && faqData.mainEntity.length > 0) {
    hasFaq = true;
    tools.push({
      name: "search-faq",
      description: "Search FAQ question/answer pairs",
      condition: "hasFaqContent",
    });
  }

  // Check for SearchAction in JSON-LD
  for (const page of ctx.rawPages) {
    if (page.status !== 200 || !page.html) continue;
    const parsed = parseHTML(page.html);
    for (const ld of parsed.jsonLd) {
      const obj = ld as Record<string, unknown>;
      if (obj?.potentialAction) {
        const action = obj.potentialAction as Record<string, unknown>;
        if (action?.["@type"] === "SearchAction" && action?.target) {
          hasSearchAction = true;
          tools.push({
            name: "site-search",
            description: "Search using the site's native search (via SearchAction)",
            condition: "hasSearchAction",
          });
          break;
        }
      }
    }
    if (hasSearchAction) break;
  }

  // Collect pre-extracted forms from pages
  for (const page of ctx.pages) {
    if (page.forms) {
      for (const form of page.forms) {
        forms.push({
          ...form,
          pageUrl: page.url,
        });
      }
    }
  }

  // Add form tools
  const usedFormNames = new Set<string>();
  forms.forEach((form, i) => {
    const fieldNames = form.fields.map((f) => f.name).join(", ");
    tools.push({
      name: inferFormToolName(form, i, usedFormNames),
      description: `Submit form (${form.method} ${form.action}) with fields: ${fieldNames}`,
      condition: "hasForm",
    });
  });

  const hasProducts = !!artifacts && artifacts.products.length > 0;
  if (hasProducts) {
    tools.push({
      name: "search-products",
      description: "Search products by name, category, or description",
      condition: "hasProducts",
    });
    tools.push({
      name: "get-product",
      description: "Get full product details by product ID",
      condition: "hasProducts",
    });
    tools.push({
      name: "check-inventory",
      description: "Check product availability and price by product ID",
      condition: "hasProducts",
    });
    tools.push({
      name: "get-reviews",
      description: "Get aggregate rating and review count for a product",
      condition: "hasProducts",
    });
  }

  const hasLocalBusiness = !!localBusinessArtifacts;
  if (hasLocalBusiness) {
    const { business } = localBusinessArtifacts;
    tools.push({
      name: "get-hours",
      description: "Get business hours and opening times",
      condition: "hasLocalBusiness",
    });
    if (business.menu) {
      tools.push({
        name: "get-menu",
        description: "Get the menu URL for this business",
        condition: "hasLocalBusiness",
      });
    }
    if (business.services) {
      tools.push({
        name: "get-services",
        description: "Get the services page URL for this business",
        condition: "hasLocalBusiness",
      });
    }
    if (business.bookingUrl) {
      tools.push({
        name: "book-appointment",
        description: "Get booking URL and instructions for scheduling an appointment",
        condition: "hasLocalBusiness",
      });
    }
  }

  return { tools, hasFaq, hasSearchAction, hasProducts, hasLocalBusiness, forms };
}

// --- Data File Generation ---

export function generateDataFiles(
  ctx: GenerateContext,
  artifacts?: EcommerceArtifacts | null,
  localBusinessArtifacts?: LocalBusinessArtifacts | null,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // pages.json
  const pagesData: PageMarkdown[] = ctx.pages.map((p) => ({
    url: p.url,
    title: p.title,
    description: p.description,
    markdown: p.markdown,
  }));
  files.push(makeFile("mcp-server/data/pages.json", `${JSON.stringify(pagesData, null, 2)}\n`));

  // faq.json (if detected)
  const faqData = generateFaq(ctx);
  if (faqData) {
    files.push(makeFile("mcp-server/data/faq.json", `${JSON.stringify(faqData, null, 2)}\n`));
  }

  // openapi.json (if detected)
  if (ctx.metadata.openapi) {
    files.push(
      makeFile(
        "mcp-server/data/openapi.json",
        `${JSON.stringify(ctx.metadata.openapi, null, 2)}\n`,
      ),
    );
  }

  // products.json (if e-commerce)
  if (artifacts && artifacts.products.length > 0) {
    files.push(
      makeFile("mcp-server/data/products.json", `${JSON.stringify(artifacts.products, null, 2)}\n`),
    );
  }

  // business.json (if local business)
  if (localBusinessArtifacts) {
    files.push(
      makeFile(
        "mcp-server/data/business.json",
        `${JSON.stringify(localBusinessArtifacts.business, null, 2)}\n`,
      ),
    );
  }

  return files;
}

// --- Server Template ---

function generateServerTs(siteName: string, baseUrl: string, detected: McpDetectedTools): string {
  const lines: string[] = [];

  lines.push(`import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`);
  lines.push(
    `import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";`,
  );
  lines.push(`import express from "express";`);
  lines.push(`import { z } from "zod";`);
  lines.push(`import { readFileSync } from "node:fs";`);
  lines.push(`import { resolve, dirname } from "node:path";`);
  lines.push(`import { fileURLToPath } from "node:url";`);
  lines.push(``);
  lines.push(`const __dirname = dirname(fileURLToPath(import.meta.url));`);
  lines.push(``);
  lines.push(`// Load data`);
  lines.push(
    `const pages = JSON.parse(readFileSync(resolve(__dirname, "data/pages.json"), "utf-8"));`,
  );

  if (detected.hasFaq) {
    lines.push(
      `const faq = JSON.parse(readFileSync(resolve(__dirname, "data/faq.json"), "utf-8"));`,
    );
  }

  if (detected.hasProducts) {
    lines.push(
      `const products = JSON.parse(readFileSync(resolve(__dirname, "data/products.json"), "utf-8"));`,
    );
  }

  if (detected.hasLocalBusiness) {
    lines.push(
      `const business = JSON.parse(readFileSync(resolve(__dirname, "data/business.json"), "utf-8"));`,
    );
  }

  lines.push(``);
  lines.push(`// Create MCP server`);
  lines.push(`const server = new McpServer({`);
  lines.push(`  name: ${JSON.stringify(siteName)},`);
  lines.push(`  version: "1.0.0",`);
  lines.push(`});`);
  lines.push(``);

  // list-pages tool
  lines.push(`// Tool: list-pages`);
  lines.push(
    `server.tool("list-pages", "List all pages on the site with titles and URLs", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {`,
  );
  lines.push(`  const listing = pages.map((p: any) => \`\${p.title} — \${p.url}\`).join("\\n");`);
  lines.push(`  return { content: [{ type: "text", text: listing }] };`);
  lines.push(`});`);
  lines.push(``);

  // get-page tool
  lines.push(`// Tool: get-page`);
  lines.push(
    `server.tool("get-page", "Get the full markdown content of a page", { url: z.string().describe("Page URL or slug to retrieve") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ url }) => {`,
  );
  lines.push(
    `  const page = pages.find((p: any) => p.url === url || p.url.endsWith("/" + url) || p.url.includes(url));`,
  );
  lines.push(`  if (!page) return { content: [{ type: "text", text: "Page not found" }] };`);
  lines.push(
    `  return { content: [{ type: "text", text: \`# \${page.title}\\n\\n\${page.markdown}\` }] };`,
  );
  lines.push(`});`);
  lines.push(``);

  // search-site tool
  lines.push(`// Tool: search-site`);
  lines.push(
    `server.tool("search-site", "Search site content by keywords", { query: z.string().describe("Search query") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {`,
  );
  lines.push(`  const terms = query.toLowerCase().split(/\\s+/);`);
  lines.push(`  const scored = pages.map((p: any) => {`);
  lines.push(`    let score = 0;`);
  lines.push(`    for (const term of terms) {`);
  lines.push(`      if (p.title?.toLowerCase().includes(term)) score += 3;`);
  lines.push(`      if (p.description?.toLowerCase().includes(term)) score += 2;`);
  lines.push(`      if (p.markdown?.toLowerCase().includes(term)) score += 1;`);
  lines.push(`    }`);
  lines.push(`    return { ...p, score };`);
  lines.push(
    `  }).filter((p: any) => p.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, 10);`,
  );
  lines.push(``);
  lines.push(
    `  if (scored.length === 0) return { content: [{ type: "text", text: "No results found" }] };`,
  );
  lines.push(`  const results = scored.map((p: any) => {`);
  lines.push(`    const snippet = p.markdown?.slice(0, 3000) || "";`);
  lines.push(`    return \`**\${p.title}** (\${p.url})\\n\${snippet}...\`;`);
  lines.push(`  }).join("\\n\\n");`);
  lines.push(`  return { content: [{ type: "text", text: results }] };`);
  lines.push(`});`);
  lines.push(``);

  // search-faq tool
  if (detected.hasFaq) {
    lines.push(`// Tool: search-faq`);
    lines.push(
      `server.tool("search-faq", "Search FAQ question/answer pairs", { query: z.string().describe("Search query") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {`,
    );
    lines.push(`  const terms = query.toLowerCase().split(/\\s+/);`);
    lines.push(`  const entries = faq.mainEntity || [];`);
    lines.push(`  const matches = entries.filter((e: any) => {`);
    lines.push(`    const text = (e.name + " " + e.acceptedAnswer?.text).toLowerCase();`);
    lines.push(`    return terms.some((t: string) => text.includes(t));`);
    lines.push(`  });`);
    lines.push(
      `  if (matches.length === 0) return { content: [{ type: "text", text: "No FAQ matches found" }] };`,
    );
    lines.push(
      `  const result = matches.map((e: any) => \`**Q:** \${e.name}\\n**A:** \${e.acceptedAnswer?.text}\`).join("\\n\\n");`,
    );
    lines.push(`  return { content: [{ type: "text", text: result }] };`);
    lines.push(`});`);
    lines.push(``);
  }

  // site-search tool (SearchAction stub)
  if (detected.hasSearchAction) {
    lines.push(`// Tool: site-search (via SearchAction)`);
    lines.push(
      `server.tool("site-search", "Search using the site's native search", { query: z.string().describe("Search query") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {`,
    );
    lines.push(
      `  const searchUrl = ${JSON.stringify(`${baseUrl}/search?q=`)} + encodeURIComponent(query);`,
    );
    lines.push(
      `  return { content: [{ type: "text", text: \`Search URL: \${searchUrl}\\n\\nNote: This returns the search URL. For full results, use search-site instead.\` }] };`,
    );
    lines.push(`});`);
    lines.push(``);
  }

  // Form submission tools
  const formTools = detected.tools.filter((t) => t.condition === "hasForm");
  detected.forms.forEach((form, i) => {
    const toolName = formTools[i]?.name ?? `submit-form-${i}`;
    const fieldSchemas = form.fields.map((f) => {
      const zodType = f.type === "number" ? "z.number()" : "z.string()";
      const desc = f.label || f.name;
      return `    ${f.name}: ${zodType}${f.required ? "" : ".optional()"}.describe(${JSON.stringify(desc)})`;
    });

    lines.push(`// Tool: ${toolName}`);
    lines.push(
      `server.tool(${JSON.stringify(toolName)}, ${JSON.stringify(`Submit form: ${form.method} ${form.action}`)}, {`,
    );
    lines.push(fieldSchemas.join(",\n"));
    lines.push(
      `}, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, async (params) => {`,
    );
    const actionUrl = JSON.stringify(new URL(form.action, form.pageUrl).href);
    lines.push(`  const _controller = new AbortController();`);
    lines.push(`  const _timer = setTimeout(() => _controller.abort(), 10000);`);
    lines.push(`  try {`);
    lines.push(`    const _res = await fetch(${actionUrl}, {`);
    lines.push(`      method: "POST",`);
    lines.push(`      headers: { "Content-Type": "application/x-www-form-urlencoded" },`);
    lines.push(`      body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),`);
    lines.push(`      signal: _controller.signal,`);
    lines.push(`    });`);
    lines.push(`    clearTimeout(_timer);`);
    lines.push(`    const _text = await _res.text();`);
    lines.push(`    const _body = _text.length > 2000 ? _text.slice(0, 2000) + "..." : _text;`);
    lines.push(`    return { content: [{ type: "text", text: \`Status: \${_res.status}\\n\\n\${_body}\` }] };`);
    lines.push(`  } catch (err) {`);
    lines.push(`    clearTimeout(_timer);`);
    lines.push(`    return { content: [{ type: "text", text: \`Error: \${err instanceof Error ? err.message : String(err)}\` }], isError: true };`);
    lines.push(`  }`);
    lines.push(`});`);
    lines.push(``);
  });

  // Commerce tools
  if (detected.hasProducts) {
    lines.push(`// E-commerce tool handlers`);
    lines.push(generateCommerceToolHandlers());
    lines.push(``);

    lines.push(`// Tool: search-products`);
    lines.push(
      `server.tool("search-products", "Search products by name, category, or description", { query: z.string().describe("Search query") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {`,
    );
    lines.push(`  const results = searchProducts(query, products);`);
    lines.push(
      `  if (results.length === 0) return { content: [{ type: "text", text: "No products found" }] };`,
    );
    lines.push(`  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };`);
    lines.push(`});`);
    lines.push(``);

    lines.push(`// Tool: get-product`);
    lines.push(
      `server.tool("get-product", "Get full product details by product ID", { productId: z.string().describe("Product ID or name") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {`,
    );
    lines.push(`  const product = getProduct(productId, products);`);
    lines.push(
      `  if (!product) return { content: [{ type: "text", text: "Product not found" }] };`,
    );
    lines.push(`  return { content: [{ type: "text", text: JSON.stringify(product, null, 2) }] };`);
    lines.push(`});`);
    lines.push(``);

    lines.push(`// Tool: check-inventory`);
    lines.push(
      `server.tool("check-inventory", "Check product availability and price", { productId: z.string().describe("Product ID or name") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {`,
    );
    lines.push(`  const result = checkInventory(productId, products);`);
    lines.push(`  if (!result) return { content: [{ type: "text", text: "Product not found" }] };`);
    lines.push(`  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };`);
    lines.push(`});`);
    lines.push(``);

    lines.push(`// Tool: get-reviews`);
    lines.push(
      `server.tool("get-reviews", "Get aggregate rating for a product", { productId: z.string().describe("Product ID or name") }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {`,
    );
    lines.push(`  const result = getReviews(productId, products);`);
    lines.push(`  if (!result) return { content: [{ type: "text", text: "Product not found" }] };`);
    lines.push(`  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };`);
    lines.push(`});`);
    lines.push(``);
  }

  // Local business tool handlers
  if (detected.hasLocalBusiness) {
    lines.push(`// Local business tool handlers`);
    lines.push(generateLocalBusinessToolHandlers());
    lines.push(``);

    lines.push(`// Tool: get-hours`);
    lines.push(
      `server.tool("get-hours", "Get business hours and opening times", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {`,
    );
    lines.push(`  const result = getHours(business);`);
    lines.push(`  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };`);
    lines.push(`});`);
    lines.push(``);

    const menuTool = detected.tools.find((t) => t.name === "get-menu");
    if (menuTool) {
      lines.push(`// Tool: get-menu`);
      lines.push(
        `server.tool("get-menu", "Get the menu URL for this business", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {`,
      );
      lines.push(`  const result = getMenu(business);`);
      lines.push(`  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };`);
      lines.push(`});`);
      lines.push(``);
    }

    const servicesTool = detected.tools.find((t) => t.name === "get-services");
    if (servicesTool) {
      lines.push(`// Tool: get-services`);
      lines.push(
        `server.tool("get-services", "Get the services page URL for this business", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {`,
      );
      lines.push(`  const result = getServices(business);`);
      lines.push(`  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };`);
      lines.push(`});`);
      lines.push(``);
    }

    const bookingTool = detected.tools.find((t) => t.name === "book-appointment");
    if (bookingTool) {
      lines.push(`// Tool: book-appointment`);
      lines.push(
        `server.tool("book-appointment", "Get booking URL and instructions for scheduling", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {`,
      );
      lines.push(`  const result = bookAppointment(business);`);
      lines.push(`  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };`);
      lines.push(`});`);
      lines.push(``);
    }
  }

  // Page resources
  lines.push(`// Resources: expose pages as MCP resources`);
  lines.push(`for (const page of pages) {`);
  lines.push(`  server.resource(page.url, page.url, async (uri) => ({`);
  lines.push(`    contents: [{ uri: uri.href, mimeType: "text/markdown", text: page.markdown }],`);
  lines.push(`  }));`);
  lines.push(`}`);
  lines.push(``);

  // HTTP server
  lines.push(`// Start HTTP server with Streamable HTTP transport`);
  lines.push(`const app = express();`);
  lines.push(`app.use(express.json());`);
  lines.push(``);
  lines.push(`app.all("/mcp", async (req, res) => {`);
  lines.push(
    `  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });`,
  );
  lines.push(`  res.on("close", () => transport.close());`);
  lines.push(`  await server.connect(transport);`);
  lines.push(`  await transport.handleRequest(req, res);`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`// .well-known/mcp discovery endpoint`);
  lines.push(`app.get("/.well-known/mcp", (_req, res) => {`);
  lines.push(`  res.redirect(307, "/mcp");`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`const PORT = process.env.PORT || 3100;`);
  lines.push(`app.listen(PORT, () => {`);
  lines.push(
    `  console.log(\`Agent server for ${siteName} running at http://localhost:\${PORT}/mcp\`);`,
  );
  lines.push(`});`);

  return `${lines.join("\n")}\n`;
}

// --- Package.json ---

function generatePackageJson(siteName: string): string {
  const slug = siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const pkg = {
    name: `${slug}-agent-server`,
    version: "1.0.0",
    type: "module",
    scripts: {
      start: "tsx server.ts",
      dev: "tsx watch server.ts",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.12.0",
      express: "^4.21.0",
      zod: "^3.24.0",
      tsx: "^4.19.0",
    },
    devDependencies: {
      "@types/express": "^5.0.0",
      "@types/node": "^22.0.0",
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

// --- tsconfig.json ---

function generateTsConfig(): string {
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

// --- README ---

function generateReadme(siteName: string, detected: McpDetectedTools, baseUrl: string): string {
  const lines: string[] = [];
  lines.push(`# ${siteName} Agent Server`);
  lines.push(``);
  lines.push(`Auto-generated agent server for [${siteName}](${baseUrl}).`);
  lines.push(``);
  lines.push(`## Tools`);
  lines.push(``);
  for (const tool of detected.tools) {
    lines.push(`- **${tool.name}**: ${tool.description}`);
  }
  lines.push(``);
  lines.push(`## Setup`);
  lines.push(``);
  lines.push("```bash");
  lines.push(`npm install`);
  lines.push(`npm start`);
  lines.push("```");
  lines.push(``);
  lines.push(`Server runs at \`http://localhost:3100/mcp\``);
  lines.push(``);
  lines.push(`## Claude Desktop Config`);
  lines.push(``);
  lines.push("```json");
  lines.push(`{`);
  lines.push(`  "mcpServers": {`);
  lines.push(`    "${siteName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}": {`);
  lines.push(`      "url": "http://localhost:3100/mcp"`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("```");
  lines.push(``);

  return lines.join("\n");
}

// --- Vercel Self-Host Template ---

function generateVercelTemplate(
  siteName: string,
  baseUrl: string,
  detected: McpDetectedTools,
  dataFiles: GeneratedFile[],
): GeneratedFile[] {
  const slug = siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const vercelJson = `${JSON.stringify(
    {
      rewrites: [
        { source: "/.well-known/mcp", destination: "/api/mcp" },
        { source: "/mcp", destination: "/api/mcp" },
      ],
    },
    null,
    2,
  )}\n`;

  const apiMcpTs = `import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pages from "../data/pages.json" with { type: "json" };
${detected.hasFaq ? 'import faq from "../data/faq.json" with { type: "json" };\n' : ""}${detected.hasProducts ? 'import products from "../data/products.json" with { type: "json" };\n' : ""}
function createServer() {
  const server = new McpServer({ name: ${JSON.stringify(siteName)}, version: "1.0.0" });

  server.tool("list-pages", "List all pages", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {
    const listing = pages.map((p: any) => \`\${p.title} — \${p.url}\`).join("\\n");
    return { content: [{ type: "text", text: listing }] };
  });

  server.tool("get-page", "Get page content", { url: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ url }) => {
    const page = pages.find((p: any) => p.url === url || p.url.endsWith("/" + url) || p.url.includes(url));
    if (!page) return { content: [{ type: "text", text: "Page not found" }] };
    return { content: [{ type: "text", text: \`# \${page.title}\\n\\n\${page.markdown}\` }] };
  });

  server.tool("search-site", "Search site content", { query: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {
    const terms = query.toLowerCase().split(/\\s+/);
    const scored = pages.map((p: any) => {
      let score = 0;
      for (const term of terms) {
        if (p.title?.toLowerCase().includes(term)) score += 3;
        if (p.description?.toLowerCase().includes(term)) score += 2;
        if (p.markdown?.toLowerCase().includes(term)) score += 1;
      }
      return { ...p, score };
    }).filter((p: any) => p.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, 10);
    if (scored.length === 0) return { content: [{ type: "text", text: "No results" }] };
    const results = scored.map((p: any) => \`**\${p.title}** (\${p.url})\\n\${p.markdown?.slice(0, 3000)}...\`).join("\\n\\n");
    return { content: [{ type: "text", text: results }] };
  });
${
  detected.hasFaq
    ? `
  server.tool("search-faq", "Search FAQ", { query: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {
    const terms = query.toLowerCase().split(/\\s+/);
    const entries = (faq as any).mainEntity || [];
    const matches = entries.filter((e: any) => {
      const text = (e.name + " " + e.acceptedAnswer?.text).toLowerCase();
      return terms.some((t: string) => text.includes(t));
    });
    if (matches.length === 0) return { content: [{ type: "text", text: "No FAQ matches" }] };
    const result = matches.map((e: any) => \`**Q:** \${e.name}\\n**A:** \${e.acceptedAnswer?.text}\`).join("\\n\\n");
    return { content: [{ type: "text", text: result }] };
  });
`
    : ""
}${
  detected.hasProducts
    ? `
${generateCommerceToolHandlers()}

  server.tool("search-products", "Search products by name, category, or description", { query: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {
    const results = searchProducts(query, products as any);
    if (results.length === 0) return { content: [{ type: "text", text: "No products found" }] };
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.tool("get-product", "Get full product details by product ID", { productId: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {
    const product = getProduct(productId, products as any);
    if (!product) return { content: [{ type: "text", text: "Product not found" }] };
    return { content: [{ type: "text", text: JSON.stringify(product, null, 2) }] };
  });

  server.tool("check-inventory", "Check product availability and price", { productId: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {
    const result = checkInventory(productId, products as any);
    if (!result) return { content: [{ type: "text", text: "Product not found" }] };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.tool("get-reviews", "Get aggregate rating for a product", { productId: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {
    const result = getReviews(productId, products as any);
    if (!result) return { content: [{ type: "text", text: "Product not found" }] };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
`
    : ""
}
${
  detected.forms.length > 0
    ? detected.forms
        .map((form, i) => {
          const formTools = detected.tools.filter((t) => t.condition === "hasForm");
          const toolName = formTools[i]?.name ?? `submit-form-${i}`;
          const fieldSchemas = form.fields.map((f) => {
            const zodType = f.type === "number" ? "z.number()" : "z.string()";
            const desc = f.label || f.name;
            return `    ${f.name}: ${zodType}${f.required ? "" : ".optional()"}.describe(${JSON.stringify(desc)})`;
          });
          const actionUrl = JSON.stringify(new URL(form.action, form.pageUrl).href);
          return `
  server.tool(${JSON.stringify(toolName)}, ${JSON.stringify(`Submit form: ${form.method} ${form.action}`)}, {
${fieldSchemas.join(",\n")}
  }, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, async (params) => {
    const _controller = new AbortController();
    const _timer = setTimeout(() => _controller.abort(), 10000);
    try {
      const _res = await fetch(${actionUrl}, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
        signal: _controller.signal,
      });
      clearTimeout(_timer);
      const _text = await _res.text();
      const _body = _text.length > 2000 ? _text.slice(0, 2000) + "..." : _text;
      return { content: [{ type: "text", text: \`Status: \${_res.status}\\n\\n\${_body}\` }] };
    } catch (err) {
      clearTimeout(_timer);
      return { content: [{ type: "text", text: \`Error: \${err instanceof Error ? err.message : String(err)}\` }], isError: true };
    }
  });`;
        })
        .join("\n")
    : ""
}
  return server;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
`;

  const pkgJson = `${JSON.stringify(
    {
      name: `${slug}-agent-vercel`,
      version: "1.0.0",
      type: "module",
      scripts: {
        dev: "vercel dev",
        deploy: "vercel --prod",
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.12.0",
        "@vercel/node": "^5.0.0",
        zod: "^3.24.0",
      },
    },
    null,
    2,
  )}\n`;

  const readme = generateReadme(siteName, detected, baseUrl);

  return [
    makeFile("mcp-server/vercel.json", vercelJson),
    makeFile("mcp-server/api/mcp.ts", apiMcpTs),
    makeFile("mcp-server/package.json", pkgJson),
    makeFile("mcp-server/tsconfig.json", generateTsConfig()),
    makeFile("mcp-server/README.md", readme),
    ...dataFiles,
  ];
}

// --- Cloudflare Workers Self-Host Template ---

function generateCloudflareTemplate(
  siteName: string,
  baseUrl: string,
  detected: McpDetectedTools,
  dataFiles: GeneratedFile[],
): GeneratedFile[] {
  const slug = siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const wranglerToml = `name = "${slug}-agent"
main = "worker.ts"
compatibility_date = "2024-12-01"

[[kv_namespaces]]
binding = "MCP_DATA"
id = "" # Run: npx wrangler kv namespace create MCP_DATA
`;

  const workerTs = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  MCP_DATA: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle .well-known/mcp discovery
    if (url.pathname === "/.well-known/mcp") {
      return Response.redirect(new URL("/mcp", request.url).href, 307);
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({
        name: ${JSON.stringify(siteName)},
        version: "1.0.0",
        tools: ${JSON.stringify(detected.tools.map((t) => t.name))},
      }), { headers: { "content-type": "application/json" } });
    }

    // Load data from KV
    const pagesStr = await env.MCP_DATA.get("pages");
    const pages = pagesStr ? JSON.parse(pagesStr) : [];
${detected.hasFaq ? '    const faqStr = await env.MCP_DATA.get("faq");\n    const faq = faqStr ? JSON.parse(faqStr) : null;\n' : ""}${detected.hasProducts ? '    const productsStr = await env.MCP_DATA.get("products");\n    const products = productsStr ? JSON.parse(productsStr) : [];\n' : ""}
    // Create stateless MCP server
    const server = new McpServer({ name: ${JSON.stringify(siteName)}, version: "1.0.0" });

    server.tool("list-pages", "List all pages", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => {
      const listing = pages.map((p: any) => \`\${p.title} — \${p.url}\`).join("\\n");
      return { content: [{ type: "text", text: listing }] };
    });

    server.tool("get-page", "Get page content", { url: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ url: pageUrl }) => {
      const page = pages.find((p: any) => p.url === pageUrl || p.url.endsWith("/" + pageUrl) || p.url.includes(pageUrl));
      if (!page) return { content: [{ type: "text", text: "Page not found" }] };
      return { content: [{ type: "text", text: \`# \${page.title}\\n\\n\${page.markdown}\` }] };
    });

    server.tool("search-site", "Search site content", { query: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {
      const terms = query.toLowerCase().split(/\\s+/);
      const scored = pages.map((p: any) => {
        let score = 0;
        for (const term of terms) {
          if (p.title?.toLowerCase().includes(term)) score += 3;
          if (p.description?.toLowerCase().includes(term)) score += 2;
          if (p.markdown?.toLowerCase().includes(term)) score += 1;
        }
        return { ...p, score };
      }).filter((p: any) => p.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, 10);
      if (scored.length === 0) return { content: [{ type: "text", text: "No results" }] };
      const results = scored.map((p: any) => \`**\${p.title}** (\${p.url})\\n\${p.markdown?.slice(0, 3000)}...\`).join("\\n\\n");
      return { content: [{ type: "text", text: results }] };
    });

${
  detected.hasProducts
    ? `
${generateCommerceToolHandlers()}

    server.tool("search-products", "Search products by name, category, or description", { query: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ query }) => {
      const results = searchProducts(query, products);
      if (results.length === 0) return { content: [{ type: "text", text: "No products found" }] };
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    });

    server.tool("get-product", "Get full product details by product ID", { productId: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {
      const product = getProduct(productId, products);
      if (!product) return { content: [{ type: "text", text: "Product not found" }] };
      return { content: [{ type: "text", text: JSON.stringify(product, null, 2) }] };
    });

    server.tool("check-inventory", "Check product availability and price", { productId: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {
      const result = checkInventory(productId, products);
      if (!result) return { content: [{ type: "text", text: "Product not found" }] };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

    server.tool("get-reviews", "Get aggregate rating for a product", { productId: z.string() }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ productId }) => {
      const result = getReviews(productId, products);
      if (!result) return { content: [{ type: "text", text: "Product not found" }] };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });
`
    : ""
}
${
  detected.forms.length > 0
    ? detected.forms
        .map((form, i) => {
          const formTools = detected.tools.filter((t) => t.condition === "hasForm");
          const toolName = formTools[i]?.name ?? `submit-form-${i}`;
          const fieldSchemas = form.fields.map((f) => {
            const zodType = f.type === "number" ? "z.number()" : "z.string()";
            const desc = f.label || f.name;
            return `      ${f.name}: ${zodType}${f.required ? "" : ".optional()"}.describe(${JSON.stringify(desc)})`;
          });
          const actionUrl = JSON.stringify(new URL(form.action, form.pageUrl).href);
          return `
    server.tool(${JSON.stringify(toolName)}, ${JSON.stringify(`Submit form: ${form.method} ${form.action}`)}, {
${fieldSchemas.join(",\n")}
    }, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, async (params) => {
      const _controller = new AbortController();
      const _timer = setTimeout(() => _controller.abort(), 10000);
      try {
        const _res = await fetch(${actionUrl}, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
          signal: _controller.signal,
        });
        clearTimeout(_timer);
        const _text = await _res.text();
        const _body = _text.length > 2000 ? _text.slice(0, 2000) + "..." : _text;
        return { content: [{ type: "text", text: \`Status: \${_res.status}\\n\\n\${_body}\` }] };
      } catch (err) {
        clearTimeout(_timer);
        return { content: [{ type: "text", text: \`Error: \${err instanceof Error ? err.message : String(err)}\` }], isError: true };
      }
    });`;
        })
        .join("\n")
    : ""
}
    // Simple JSON-RPC handler since CF Workers doesn't support StreamableHTTP easily
    const body = await request.json() as any;
    if (body.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: { name: ${JSON.stringify(siteName)}, version: "1.0.0" },
          capabilities: { tools: {} },
        },
      }), { headers: { "content-type": "application/json" } });
    }

    if (body.method === "tools/list") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            { name: "list-pages", description: "List all pages", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
            { name: "get-page", description: "Get page content", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
            { name: "search-site", description: "Search site content", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
            ${
              detected.hasProducts
                ? `{ name: "search-products", description: "Search products by name, category, or description", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
            { name: "get-product", description: "Get full product details by product ID", inputSchema: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
            { name: "check-inventory", description: "Check product availability and price", inputSchema: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
            { name: "get-reviews", description: "Get aggregate rating for a product", inputSchema: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },`
                : ""
            }
${
  detected.forms.length > 0
    ? detected.forms
        .map((form, i) => {
          const formTools = detected.tools.filter((t) => t.condition === "hasForm");
          const toolName = formTools[i]?.name ?? `submit-form-${i}`;
          const properties = Object.fromEntries(
            form.fields.map((f) => [f.name, { type: f.type === "number" ? "number" : "string" }])
          );
          const required = form.fields.filter((f) => f.required).map((f) => f.name);
          return `            { name: ${JSON.stringify(toolName)}, description: ${JSON.stringify(`Submit form: ${form.method} ${form.action}`)}, inputSchema: { type: "object", properties: ${JSON.stringify(properties)}, required: ${JSON.stringify(required)} }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },`;
        })
        .join("\n")
    : ""
}
          ],
        },
      }), { headers: { "content-type": "application/json" } });
    }

    if (body.method === "tools/call") {
      const toolName = body.params?.name;
      const args = body.params?.arguments || {};
      let result: any;

      if (toolName === "list-pages") {
        const listing = pages.map((p: any) => \`\${p.title} — \${p.url}\`).join("\\n");
        result = { content: [{ type: "text", text: listing }] };
      } else if (toolName === "get-page") {
        const page = pages.find((p: any) => p.url === args.url || p.url.endsWith("/" + args.url) || p.url.includes(args.url));
        result = page
          ? { content: [{ type: "text", text: \`# \${page.title}\\n\\n\${page.markdown}\` }] }
          : { content: [{ type: "text", text: "Page not found" }] };
      } else if (toolName === "search-site") {
        const terms = (args.query || "").toLowerCase().split(/\\s+/);
        const scored = pages.map((p: any) => {
          let score = 0;
          for (const term of terms) {
            if (p.title?.toLowerCase().includes(term)) score += 3;
            if (p.description?.toLowerCase().includes(term)) score += 2;
            if (p.markdown?.toLowerCase().includes(term)) score += 1;
          }
          return { ...p, score };
        }).filter((p: any) => p.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, 10);
        const text = scored.length === 0
          ? "No results"
          : scored.map((p: any) => \`**\${p.title}** (\${p.url})\\n\${p.markdown?.slice(0, 3000)}...\`).join("\\n\\n");
        result = { content: [{ type: "text", text }] };
      }${
        detected.hasProducts
          ? ` else if (toolName === "search-products") {
        const results = searchProducts(args.query || "", products);
        result = results.length === 0
          ? { content: [{ type: "text", text: "No products found" }] }
          : { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } else if (toolName === "get-product") {
        const product = getProduct(args.productId || "", products);
        result = product
          ? { content: [{ type: "text", text: JSON.stringify(product, null, 2) }] }
          : { content: [{ type: "text", text: "Product not found" }] };
      } else if (toolName === "check-inventory") {
        const inv = checkInventory(args.productId || "", products);
        result = inv
          ? { content: [{ type: "text", text: JSON.stringify(inv, null, 2) }] }
          : { content: [{ type: "text", text: "Product not found" }] };
      } else if (toolName === "get-reviews") {
        const rev = getReviews(args.productId || "", products);
        result = rev
          ? { content: [{ type: "text", text: JSON.stringify(rev, null, 2) }] }
          : { content: [{ type: "text", text: "Product not found" }] };
      }`
          : ""
      }${
  detected.forms.length > 0
    ? detected.forms
        .map((form, i) => {
          const formTools = detected.tools.filter((t) => t.condition === "hasForm");
          const toolName = formTools[i]?.name ?? `submit-form-${i}`;
          const actionUrl = JSON.stringify(new URL(form.action, form.pageUrl).href);
          return ` else if (toolName === ${JSON.stringify(toolName)}) {
        const _controller = new AbortController();
        const _timer = setTimeout(() => _controller.abort(), 10000);
        try {
          const _res = await fetch(${actionUrl}, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString(),
            signal: _controller.signal,
          });
          clearTimeout(_timer);
          const _text = await _res.text();
          const _body = _text.length > 2000 ? _text.slice(0, 2000) + "..." : _text;
          result = { content: [{ type: "text", text: \`Status: \${_res.status}\\n\\n\${_body}\` }] };
        } catch (err) {
          clearTimeout(_timer);
          result = { content: [{ type: "text", text: \`Error: \${err instanceof Error ? err.message : String(err)}\` }], isError: true };
        }
      }`;
        })
        .join("")
    : ""
} else {
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: body.id,
          error: { code: -32601, message: "Unknown tool: " + toolName },
        }), { headers: { "content-type": "application/json" } });
      }

      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: body.id, result,
      }), { headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: body.id,
      error: { code: -32601, message: "Method not found" },
    }), { headers: { "content-type": "application/json" } });
  },
};
`;

  const setupSh = `#!/bin/bash
# Upload data to Cloudflare KV
# First, update wrangler.toml with your KV namespace ID
npx wrangler kv key put --binding MCP_DATA "pages" --path data/pages.json
${detected.hasFaq ? 'npx wrangler kv key put --binding MCP_DATA "faq" --path data/faq.json\n' : ""}${detected.hasProducts ? 'npx wrangler kv key put --binding MCP_DATA "products" --path data/products.json\n' : ""}echo "Data uploaded. Deploy with: npx wrangler deploy"
`;

  const pkgJson = `${JSON.stringify(
    {
      name: `${slug}-agent-cf`,
      version: "1.0.0",
      type: "module",
      scripts: {
        dev: "wrangler dev",
        deploy: "wrangler deploy",
        "setup-data": "bash setup.sh",
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.12.0",
        zod: "^3.24.0",
      },
      devDependencies: {
        wrangler: "^4.0.0",
        "@cloudflare/workers-types": "^4.0.0",
      },
    },
    null,
    2,
  )}\n`;

  const readme = generateReadme(siteName, detected, baseUrl);

  return [
    makeFile("mcp-server/wrangler.toml", wranglerToml),
    makeFile("mcp-server/worker.ts", workerTs),
    makeFile("mcp-server/setup.sh", setupSh),
    makeFile("mcp-server/package.json", pkgJson),
    makeFile("mcp-server/tsconfig.json", generateTsConfig()),
    makeFile("mcp-server/README.md", readme),
    ...dataFiles,
  ];
}

// --- Helpers ---

function makeFile(filename: string, content: string): GeneratedFile {
  return {
    filename,
    content,
    size: new TextEncoder().encode(content).length,
  };
}
