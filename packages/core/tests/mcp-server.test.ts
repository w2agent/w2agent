import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchedPage } from "../src/audit/types.js";
import { detectTools, generateMcpServer } from "../src/generate/mcp-server.js";
import type { GenerateContext, PageMarkdown } from "../src/generate/types.js";

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, "fixtures", name), "utf-8");
}

function makeCtx(overrides: Partial<GenerateContext> = {}): GenerateContext {
  return {
    pages: overrides.pages ?? [],
    rawPages: overrides.rawPages ?? [],
    metadata: overrides.metadata ?? { baseUrl: "https://example.com", wellKnown: {} },
    baseUrl: overrides.baseUrl ?? "https://example.com",
  };
}

function makePage(url: string, html: string): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}

// --- detectTools ---

describe("detectTools", () => {
  it("always includes list-pages, get-page, search-site", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Home", description: "", markdown: "Welcome" }],
    });
    const result = detectTools(ctx);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("list-pages");
    expect(names).toContain("get-page");
    expect(names).toContain("search-site");
  });

  it("detects FAQ content and adds search-faq tool", () => {
    const html = loadFixture("faq-page.html");
    const ctx = makeCtx({
      rawPages: [makePage("https://example.com/faq", html)],
    });
    const result = detectTools(ctx);
    expect(result.hasFaq).toBe(true);
    expect(result.tools.some((t) => t.name === "search-faq")).toBe(true);
  });

  it("detects SearchAction and adds site-search tool", () => {
    const html = `<html><head>
      <script type="application/ld+json">{
        "@type": "WebSite",
        "potentialAction": { "@type": "SearchAction", "target": "https://example.com/search?q={query}" }
      }</script>
    </head><body></body></html>`;
    const ctx = makeCtx({
      rawPages: [makePage("https://example.com", html)],
    });
    const result = detectTools(ctx);
    expect(result.hasSearchAction).toBe(true);
    expect(result.tools.some((t) => t.name === "site-search")).toBe(true);
  });

  it("detects forms with action and named inputs", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "Contact us",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [
                { name: "email", type: "email", required: true },
                { name: "message", type: "text", required: false },
              ],
            },
          ],
        },
      ],
    });
    const result = detectTools(ctx);
    expect(result.forms).toHaveLength(1);
    expect(result.forms[0].action).toBe("/contact");
    expect(result.forms[0].method).toBe("POST");
    expect(result.forms[0].pageUrl).toBe("https://example.com/contact");
    expect(result.forms[0].fields).toHaveLength(2);
    expect(result.tools.some((t) => t.name === "submit-form-0")).toBe(true);
  });

  it("returns empty forms when pages have no forms", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Home", description: "", markdown: "Hello" }],
    });
    const result = detectTools(ctx);
    expect(result.forms).toHaveLength(0);
  });

  it("flattens forms from multiple pages with pageUrl", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "Contact",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
        {
          url: "https://example.com/search",
          title: "Search",
          description: "",
          markdown: "Search",
          forms: [
            {
              action: "/search",
              method: "GET",
              fields: [{ name: "q", type: "text", required: false }],
            },
          ],
        },
      ],
    });
    const result = detectTools(ctx);
    expect(result.forms).toHaveLength(2);
    expect(result.forms[0].pageUrl).toBe("https://example.com/contact");
    expect(result.forms[1].pageUrl).toBe("https://example.com/search");
  });

  it("returns no FAQ or SearchAction for basic pages", () => {
    const html = "<html><head><title>Home</title></head><body><p>Hello</p></body></html>";
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Home", description: "", markdown: "Hello" }],
      rawPages: [makePage("https://example.com", html)],
    });
    const result = detectTools(ctx);
    expect(result.hasFaq).toBe(false);
    expect(result.hasSearchAction).toBe(false);
    expect(result.forms).toHaveLength(0);
  });
});

// --- generateDataFiles (via generateMcpServer) ---

describe("generateMcpServer", () => {
  it("produces all expected files for a basic site", () => {
    const pages: PageMarkdown[] = [
      {
        url: "https://example.com/",
        title: "Example",
        description: "An example site",
        markdown: "Welcome to Example.",
      },
      {
        url: "https://example.com/about",
        title: "About",
        description: "About us",
        markdown: "We are Example.",
      },
    ];
    const ctx = makeCtx({ pages });

    const files = generateMcpServer(ctx);
    const filenames = files.map((f) => f.filename);

    expect(filenames).toContain("mcp-server/server.ts");
    expect(filenames).toContain("mcp-server/package.json");
    expect(filenames).toContain("mcp-server/tsconfig.json");
    expect(filenames).toContain("mcp-server/README.md");
    expect(filenames).toContain("mcp-server/data/pages.json");
  });

  it("generates pages.json with correct page data", () => {
    const pages: PageMarkdown[] = [
      {
        url: "https://example.com/",
        title: "Home",
        description: "Welcome",
        markdown: "Hello world",
      },
    ];
    const ctx = makeCtx({ pages });

    const files = generateMcpServer(ctx);
    const pagesFile = files.find((f) => f.filename === "mcp-server/data/pages.json");
    expect(pagesFile).toBeDefined();

    const data = JSON.parse(pagesFile?.content);
    expect(data).toHaveLength(1);
    expect(data[0].url).toBe("https://example.com/");
    expect(data[0].title).toBe("Home");
    expect(data[0].markdown).toBe("Hello world");
  });

  it("includes faq.json when FAQ content exists", () => {
    const faqHtml = loadFixture("faq-page.html");
    const ctx = makeCtx({
      pages: [
        { url: "https://example.com/faq", title: "FAQ", description: "", markdown: "FAQ content" },
      ],
      rawPages: [makePage("https://example.com/faq", faqHtml)],
    });

    const files = generateMcpServer(ctx);
    const faqFile = files.find((f) => f.filename === "mcp-server/data/faq.json");
    expect(faqFile).toBeDefined();

    const data = JSON.parse(faqFile?.content);
    expect(data["@type"]).toBe("FAQPage");
    expect(data.mainEntity.length).toBeGreaterThan(0);
  });

  it("does not include faq.json when no FAQ content", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Home", description: "", markdown: "Hello" }],
      rawPages: [makePage("https://example.com", "<html><body><p>Hello</p></body></html>")],
    });

    const files = generateMcpServer(ctx);
    const faqFile = files.find((f) => f.filename === "mcp-server/data/faq.json");
    expect(faqFile).toBeUndefined();
  });

  it("server.ts includes correct tool registrations", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/",
          title: "Test Site",
          description: "A test",
          markdown: "Content",
        },
      ],
    });

    const files = generateMcpServer(ctx);
    const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;

    expect(serverFile.content).toContain('server.tool("list-pages"');
    expect(serverFile.content).toContain('server.tool("get-page"');
    expect(serverFile.content).toContain('server.tool("search-site"');
    expect(serverFile.content).toContain('"Test Site"');
  });

  it("server.ts includes search-faq when FAQ detected", () => {
    const faqHtml = loadFixture("faq-page.html");
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/faq", title: "FAQ", description: "", markdown: "FAQ" }],
      rawPages: [makePage("https://example.com/faq", faqHtml)],
    });

    const files = generateMcpServer(ctx);
    const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
    expect(serverFile.content).toContain('server.tool("search-faq"');
  });

  it("server.ts includes .well-known/mcp discovery route", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Test", description: "", markdown: "Hello" }],
    });
    const files = generateMcpServer(ctx);
    const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
    expect(serverFile.content).toContain(".well-known/mcp");
  });

  it("package.json has correct dependencies", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Test", description: "", markdown: "Content" }],
    });

    const files = generateMcpServer(ctx);
    const pkgFile = files.find((f) => f.filename === "mcp-server/package.json")!;
    const pkg = JSON.parse(pkgFile.content);

    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBeDefined();
    expect(pkg.dependencies.express).toBeDefined();
    expect(pkg.dependencies.zod).toBeDefined();
    expect(pkg.dependencies.tsx).toBeDefined();
    expect(pkg.type).toBe("module");
  });

  it("README lists all detected tools", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/",
          title: "My Site",
          description: "Great",
          markdown: "Content",
        },
      ],
    });

    const files = generateMcpServer(ctx);
    const readme = files.find((f) => f.filename === "mcp-server/README.md")!;

    expect(readme.content).toContain("# My Site MCP Server");
    expect(readme.content).toContain("list-pages");
    expect(readme.content).toContain("get-page");
    expect(readme.content).toContain("search-site");
    expect(readme.content).toContain("Claude Desktop Config");
  });
});

// --- Self-host templates ---

describe("generateMcpServer self-host: vercel", () => {
  const ctx = makeCtx({
    pages: [
      {
        url: "https://example.com/",
        title: "Test Site",
        description: "A test",
        markdown: "Content",
      },
    ],
  });

  it("produces vercel.json with .well-known/mcp rewrite", () => {
    const files = generateMcpServer(ctx, "vercel");
    const vercelJson = files.find((f) => f.filename === "mcp-server/vercel.json");
    expect(vercelJson).toBeDefined();
    const config = JSON.parse(vercelJson?.content);
    expect(config.rewrites.some((r: any) => r.source === "/.well-known/mcp")).toBe(true);
  });

  it("produces api/mcp.ts serverless function", () => {
    const files = generateMcpServer(ctx, "vercel");
    const apiFile = files.find((f) => f.filename === "mcp-server/api/mcp.ts");
    expect(apiFile).toBeDefined();
    expect(apiFile?.content).toContain("VercelRequest");
    expect(apiFile?.content).toContain("McpServer");
  });

  it("includes data files", () => {
    const files = generateMcpServer(ctx, "vercel");
    expect(files.some((f) => f.filename === "mcp-server/data/pages.json")).toBe(true);
  });

  it("package.json includes @vercel/node", () => {
    const files = generateMcpServer(ctx, "vercel");
    const pkg = JSON.parse(files.find((f) => f.filename === "mcp-server/package.json")?.content);
    expect(pkg.dependencies["@vercel/node"]).toBeDefined();
  });
});

describe("generateMcpServer self-host: cf", () => {
  const ctx = makeCtx({
    pages: [
      {
        url: "https://example.com/",
        title: "Test Site",
        description: "A test",
        markdown: "Content",
      },
    ],
  });

  it("produces wrangler.toml", () => {
    const files = generateMcpServer(ctx, "cf");
    const wrangler = files.find((f) => f.filename === "mcp-server/wrangler.toml");
    expect(wrangler).toBeDefined();
    expect(wrangler?.content).toContain("kv_namespaces");
  });

  it("produces worker.ts with .well-known/mcp handling", () => {
    const files = generateMcpServer(ctx, "cf");
    const worker = files.find((f) => f.filename === "mcp-server/worker.ts");
    expect(worker).toBeDefined();
    expect(worker?.content).toContain(".well-known/mcp");
    expect(worker?.content).toContain("initialize");
    expect(worker?.content).toContain("tools/list");
    expect(worker?.content).toContain("tools/call");
  });

  it("produces setup.sh for KV data upload", () => {
    const files = generateMcpServer(ctx, "cf");
    const setup = files.find((f) => f.filename === "mcp-server/setup.sh");
    expect(setup).toBeDefined();
    expect(setup?.content).toContain("wrangler kv");
  });

  it("includes data files", () => {
    const files = generateMcpServer(ctx, "cf");
    expect(files.some((f) => f.filename === "mcp-server/data/pages.json")).toBe(true);
  });
});

// --- Tool Annotations ---

describe("tool annotations", () => {
  const ctx = makeCtx({
    pages: [
      {
        url: "https://example.com/",
        title: "Test Site",
        description: "A test",
        markdown: "Content",
      },
    ],
  });

  it("standalone server.ts includes readOnlyHint annotations on read tools", () => {
    const files = generateMcpServer(ctx);
    const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
    expect(serverFile.content).toContain("readOnlyHint: true");
    expect(serverFile.content).toContain("idempotentHint: true");
    expect(serverFile.content).toContain("openWorldHint: false");
  });

  it("standalone server.ts includes write annotations on form submit tools", () => {
    const ctxWithForm = makeCtx({
      pages: [
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "Hi",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const files = generateMcpServer(ctxWithForm);
    const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
    expect(serverFile.content).toContain("destructiveHint: true");
    expect(serverFile.content).toContain("idempotentHint: false");
  });

  it("vercel api/mcp.ts includes readOnlyHint annotations", () => {
    const files = generateMcpServer(ctx, "vercel");
    const apiFile = files.find((f) => f.filename === "mcp-server/api/mcp.ts")!;
    expect(apiFile.content).toContain("readOnlyHint: true");
    expect(apiFile.content).toContain("idempotentHint: true");
    expect(apiFile.content).toContain("openWorldHint: false");
  });

  it("cloudflare worker.ts includes readOnlyHint annotations on server.tool calls", () => {
    const files = generateMcpServer(ctx, "cf");
    const workerFile = files.find((f) => f.filename === "mcp-server/worker.ts")!;
    expect(workerFile.content).toContain("readOnlyHint: true");
    expect(workerFile.content).toContain("idempotentHint: true");
  });

  it("cloudflare worker.ts tools/list response includes annotations", () => {
    const files = generateMcpServer(ctx, "cf");
    const workerFile = files.find((f) => f.filename === "mcp-server/worker.ts")!;
    // The tools/list response is a JS object literal inside JSON.stringify() —
    // in generated source code, annotations appear as JS syntax, not serialized JSON
    expect(workerFile.content).toContain("annotations: { readOnlyHint: true");
  });
});
