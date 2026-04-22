import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchedPage } from "../src/audit/types.js";
import type { EcommerceArtifacts } from "../src/generate/ecommerce.js";
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
    ...(overrides.allowedOffOriginHosts
      ? { allowedOffOriginHosts: overrides.allowedOffOriginHosts }
      : {}),
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
    expect(result.tools.some((t) => t.name === "submit-contact")).toBe(true);
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

  it("names form tool from action URL path segment", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/newsletter",
          title: "Newsletter",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/subscribe",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const result = detectTools(ctx);
    expect(result.tools.some((t) => t.name === "submit-subscribe")).toBe(true);
  });

  it("names form tool from form id attribute", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/contact",
          title: "Contact",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/submit",
              method: "POST",
              id: "contact-form",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const result = detectTools(ctx);
    expect(result.tools.some((t) => t.name === "submit-contact-form")).toBe(true);
  });

  it("names form tool from form name attribute when no id", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/",
          title: "Home",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/submit",
              method: "POST",
              name: "newsletter",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const result = detectTools(ctx);
    expect(result.tools.some((t) => t.name === "submit-newsletter")).toBe(true);
  });

  it("deduplicates form tool names with numeric suffix", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/",
          title: "Home",
          description: "",
          markdown: "",
          forms: [
            {
              action: "/contact",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
            {
              action: "/contact",
              method: "GET",
              fields: [{ name: "q", type: "text", required: false }],
            },
          ],
        },
      ],
    });
    const result = detectTools(ctx);
    const names = result.tools.filter((t) => t.condition === "hasForm").map((t) => t.name);
    expect(names).toContain("submit-contact");
    expect(names).toContain("submit-contact-2");
  });

  it("falls back to submit-form-N for anchor-only actions", () => {
    const ctx = makeCtx({
      pages: [
        {
          url: "https://example.com/",
          title: "Home",
          description: "",
          markdown: "",
          forms: [
            {
              action: "#",
              method: "POST",
              fields: [{ name: "email", type: "email", required: true }],
            },
          ],
        },
      ],
    });
    const result = detectTools(ctx);
    expect(result.tools.some((t) => t.name === "submit-form-0")).toBe(true);
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

    expect(readme.content).toContain("# My Site Agent Server");
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
    // Verify stub is gone, real fetch present
    expect(serverFile.content).not.toContain("Form submission stub");
    expect(serverFile.content).toContain("fetch(");
  });

  it("standalone form tools use resolved absolute action URL", () => {
    const ctx = makeCtx({
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
    const files = generateMcpServer(ctx);
    const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
    // Action URL resolved at generation time to absolute
    expect(serverFile.content).toContain('"https://example.com/contact"');
    // Not the raw relative path
    expect(serverFile.content).not.toContain('fetch("/contact"');
  });

  it("standalone form tools include timeout and error handling", () => {
    const ctx = makeCtx({
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
    const files = generateMcpServer(ctx);
    const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
    expect(serverFile.content).toContain("AbortController");
    expect(serverFile.content).toContain("10000");
    expect(serverFile.content).toContain("isError: true");
    expect(serverFile.content).toContain("application/x-www-form-urlencoded");
    expect(serverFile.content).toContain("URLSearchParams");
    // Response truncation at 2000 chars
    expect(serverFile.content).toContain("2000");
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

  it("vercel api/mcp.ts includes form submission tools when forms detected", () => {
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
    const files = generateMcpServer(ctxWithForm, "vercel");
    const apiFile = files.find((f) => f.filename === "mcp-server/api/mcp.ts")!;
    // Real fetch, not a stub
    expect(apiFile.content).toContain("fetch(");
    expect(apiFile.content).toContain("AbortController");
    expect(apiFile.content).toContain("10000");
    expect(apiFile.content).toContain("isError: true");
    expect(apiFile.content).toContain("application/x-www-form-urlencoded");
    // Write annotations
    expect(apiFile.content).toContain("destructiveHint: true");
    expect(apiFile.content).toContain("idempotentHint: false");
    // Action URL resolved at generation time
    expect(apiFile.content).toContain('"https://example.com/contact"');
  });

  it("cloudflare worker.ts includes form submission tools when forms detected", () => {
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
    const files = generateMcpServer(ctxWithForm, "cf");
    const workerFile = files.find((f) => f.filename === "mcp-server/worker.ts")!;
    // Real fetch in tools/call handler
    expect(workerFile.content).toContain("fetch(");
    expect(workerFile.content).toContain("AbortController");
    expect(workerFile.content).toContain("10000");
    expect(workerFile.content).toContain("isError: true");
    expect(workerFile.content).toContain("application/x-www-form-urlencoded");
    // Write annotations present in tools/list response
    expect(workerFile.content).toContain("destructiveHint: true");
    expect(workerFile.content).toContain("idempotentHint: false");
    // Action URL resolved at generation time
    expect(workerFile.content).toContain('"https://example.com/contact"');
  });

  // Security: forms whose action resolves off-origin must be skipped so the
  // generated server cannot be steered into SSRF / proxy behavior.
  describe("off-origin form action policy (security)", () => {
    it("skips form tool when action resolves to a different origin", () => {
      const ctx = makeCtx({
        pages: [
          {
            url: "https://example.com/contact",
            title: "Contact",
            description: "",
            markdown: "Hi",
            forms: [
              {
                action: "https://evil.example/submit",
                method: "POST",
                fields: [{ name: "email", type: "text", required: true }],
              },
            ],
          },
        ],
      });
      const files = generateMcpServer(ctx);
      const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
      expect(serverFile.content).not.toContain("evil.example");
      expect(serverFile.content).not.toContain("submit-contact");
    });

    it("skips form tool when action resolves to a private IP", () => {
      const ctx = makeCtx({
        pages: [
          {
            url: "https://example.com/contact",
            title: "Contact",
            description: "",
            markdown: "Hi",
            forms: [
              {
                action: "http://169.254.169.254/",
                method: "POST",
                fields: [{ name: "email", type: "text", required: true }],
              },
            ],
          },
        ],
      });
      const files = generateMcpServer(ctx);
      const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
      expect(serverFile.content).not.toContain("169.254.169.254");
    });

    it("keeps off-origin form when host is in allowedOffOriginHosts", () => {
      const ctx = makeCtx({
        pages: [
          {
            url: "https://example.com/contact",
            title: "Contact",
            description: "",
            markdown: "Hi",
            forms: [
              {
                action: "https://forms.partner.com/submit",
                method: "POST",
                fields: [{ name: "email", type: "text", required: true }],
              },
            ],
          },
        ],
        allowedOffOriginHosts: ["forms.partner.com"],
      });
      const files = generateMcpServer(ctx);
      const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
      expect(serverFile.content).toContain("https://forms.partner.com/submit");
    });
  });

  // Security: hostile form field names must be emitted as quoted bracket keys,
  // never as bare JS identifiers, or an attacker-controlled site can inject
  // arbitrary code into the generated MCP server.
  describe("form field name injection (security)", () => {
    const HOSTILE = '}); injected(); ({ q';
    const ctxWithHostile = () =>
      makeCtx({
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
                fields: [{ name: HOSTILE, type: "text", required: false }],
              },
            ],
          },
        ],
      });

    const quotedKey = `[${JSON.stringify(HOSTILE)}]`;
    const bareKey = `${HOSTILE}:`;

    it("standalone server.ts emits hostile field name as bracket-quoted key", () => {
      const files = generateMcpServer(ctxWithHostile());
      const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
      expect(serverFile.content).toContain(`${quotedKey}: z.`);
      expect(serverFile.content).not.toContain(bareKey);
    });

    it("vercel api/mcp.ts emits hostile field name as bracket-quoted key", () => {
      const files = generateMcpServer(ctxWithHostile(), "vercel");
      const apiFile = files.find((f) => f.filename === "mcp-server/api/mcp.ts")!;
      expect(apiFile.content).toContain(`${quotedKey}: z.`);
      expect(apiFile.content).not.toContain(bareKey);
    });

    it("cloudflare worker.ts emits hostile field name as bracket-quoted key", () => {
      const files = generateMcpServer(ctxWithHostile(), "cf");
      const workerFile = files.find((f) => f.filename === "mcp-server/worker.ts")!;
      expect(workerFile.content).toContain(`${quotedKey}: z.`);
      expect(workerFile.content).not.toContain(bareKey);
    });
  });
});

// --- OpenAPI tools ---

describe("detectTools — OpenAPI endpoints", () => {
  it("sets hasOpenapi=false when no openapi in metadata", () => {
    const ctx = makeCtx();
    const result = detectTools(ctx);
    expect(result.hasOpenapi).toBe(false);
    expect(result.openapiEndpoints).toHaveLength(0);
  });

  it("detects openapi endpoints and adds tools", () => {
    const ctx = makeCtx({
      metadata: {
        baseUrl: "https://api.example.com",
        wellKnown: {},
        openapi: {
          specUrl: "https://api.example.com/openapi.json",
          version: "3.0.0",
          serverUrl: "https://api.example.com",
          endpoints: [
            {
              path: "/pets",
              method: "get",
              operationId: "listPets",
              summary: "List all pets",
              parameters: [{ name: "limit", in: "query", required: false, type: "integer" }],
            },
            {
              path: "/pets/{petId}",
              method: "get",
              operationId: "showPetById",
              summary: "Get a pet by ID",
              parameters: [{ name: "petId", in: "path", required: true, type: "string" }],
            },
          ],
        } as any,
      },
    });
    const result = detectTools(ctx);
    expect(result.hasOpenapi).toBe(true);
    expect(result.openapiEndpoints).toHaveLength(2);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("list-pets");
    expect(names).toContain("show-pet-by-id");
  });

  it("caps endpoints at 20", () => {
    const endpoints = Array.from({ length: 25 }, (_, i) => ({
      path: `/resource/${i}`,
      method: "get",
      parameters: [],
    }));
    const ctx = makeCtx({
      metadata: {
        baseUrl: "https://api.example.com",
        wellKnown: {},
        openapi: { specUrl: "...", version: "3.0.0", endpoints } as any,
      },
    });
    const result = detectTools(ctx);
    expect(result.openapiEndpoints).toHaveLength(20);
    expect(result.tools.filter((t) => t.condition === "hasOpenapi")).toHaveLength(20);
  });
});

describe("generateMcpServer — OpenAPI tools in output", () => {
  it("generated server.ts includes openapi tool handler", () => {
    const ctx = makeCtx({
      metadata: {
        baseUrl: "https://api.example.com",
        wellKnown: {},
        openapi: {
          specUrl: "https://api.example.com/openapi.json",
          version: "3.0.0",
          serverUrl: "https://api.example.com",
          endpoints: [
            {
              path: "/pets",
              method: "get",
              operationId: "listPets",
              summary: "List all pets",
              parameters: [],
            },
          ],
        } as any,
      },
    });
    const files = generateMcpServer(ctx);
    const serverTs = files.find((f) => f.filename === "mcp-server/server.ts");
    expect(serverTs?.content).toContain('"list-pets"');
    expect(serverTs?.content).toContain("fetch(");
  });

  it("generated server.ts includes path param substitution", () => {
    const ctx = makeCtx({
      metadata: {
        baseUrl: "https://api.example.com",
        wellKnown: {},
        openapi: {
          specUrl: "...",
          version: "3.0.0",
          serverUrl: "https://api.example.com",
          endpoints: [
            {
              path: "/pets/{petId}",
              method: "get",
              operationId: "getPet",
              parameters: [{ name: "petId", in: "path", required: true, type: "string" }],
            },
          ],
        } as any,
      },
    });
    const files = generateMcpServer(ctx);
    const serverTs = files.find((f) => f.filename === "mcp-server/server.ts");
    expect(serverTs?.content).toContain("{petId}");
    expect(serverTs?.content).toContain('params["petId"]');
  });

  // Security: hostile OpenAPI parameter / property names must never land in
  // generated code as bare identifiers. Attacker publishes a malicious
  // openapi.json; generator must not let its names become executable JS.
  describe("OpenAPI parameter/property name injection (security)", () => {
    const HOSTILE = '"]; injected(); params["q';
    const ctxWithHostileParam = () =>
      makeCtx({
        metadata: {
          baseUrl: "https://api.example.com",
          wellKnown: {},
          openapi: {
            specUrl: "https://api.example.com/openapi.json",
            version: "3.0.0",
            serverUrl: "https://api.example.com",
            endpoints: [
              {
                path: "/x",
                method: "get",
                operationId: "getX",
                parameters: [
                  { name: HOSTILE, in: "query", required: true, type: "string" },
                ],
              },
            ],
          } as any,
        },
      });

    const ctxWithHostileBodyProp = () =>
      makeCtx({
        metadata: {
          baseUrl: "https://api.example.com",
          wellKnown: {},
          openapi: {
            specUrl: "https://api.example.com/openapi.json",
            version: "3.0.0",
            serverUrl: "https://api.example.com",
            endpoints: [
              {
                path: "/x",
                method: "post",
                operationId: "postX",
                parameters: [],
                requestBody: { properties: { [HOSTILE]: { type: "string" } } },
              },
            ],
          } as any,
        },
      });

    const quotedKey = `[${JSON.stringify(HOSTILE)}]`;
    const quotedAccess = `params[${JSON.stringify(HOSTILE)}]`;
    const badSchemaKey = `${HOSTILE}:`;
    const badMember = `params.${HOSTILE}`;

    it("query param: standalone server.ts quotes hostile name in schema and access", () => {
      const files = generateMcpServer(ctxWithHostileParam());
      const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
      expect(serverFile.content).toContain(`${quotedKey}: z.`);
      expect(serverFile.content).toContain(quotedAccess);
      expect(serverFile.content).not.toContain(badSchemaKey);
      expect(serverFile.content).not.toContain(badMember);
    });

    it("query param: vercel api/mcp.ts quotes hostile name in schema and access", () => {
      const files = generateMcpServer(ctxWithHostileParam(), "vercel");
      const apiFile = files.find((f) => f.filename === "mcp-server/api/mcp.ts")!;
      expect(apiFile.content).toContain(`${quotedKey}: z.`);
      expect(apiFile.content).toContain(quotedAccess);
      expect(apiFile.content).not.toContain(badSchemaKey);
      expect(apiFile.content).not.toContain(badMember);
    });

    it("query param: cloudflare worker.ts quotes hostile name in schema and access", () => {
      const files = generateMcpServer(ctxWithHostileParam(), "cf");
      const workerFile = files.find((f) => f.filename === "mcp-server/worker.ts")!;
      expect(workerFile.content).toContain(`${quotedKey}: z.`);
      expect(workerFile.content).toContain(quotedAccess);
      expect(workerFile.content).not.toContain(badSchemaKey);
      expect(workerFile.content).not.toContain(badMember);
    });

    it("body property: standalone server.ts quotes hostile name in schema and access", () => {
      const files = generateMcpServer(ctxWithHostileBodyProp());
      const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
      expect(serverFile.content).toContain(`${quotedKey}: z.`);
      expect(serverFile.content).toContain(quotedAccess);
      expect(serverFile.content).not.toContain(badSchemaKey);
      expect(serverFile.content).not.toContain(badMember);
    });
  });

  it("cloudflare worker.ts includes openapi tool in sdk section and tools/list", () => {
    const ctx = makeCtx({
      metadata: {
        baseUrl: "https://api.example.com",
        wellKnown: {},
        openapi: {
          specUrl: "https://api.example.com/openapi.json",
          version: "3.0.0",
          serverUrl: "https://api.example.com",
          endpoints: [
            {
              path: "/pets",
              method: "get",
              operationId: "listPets",
              summary: "List all pets",
              parameters: [{ name: "limit", in: "query", required: false, type: "integer" }],
            },
          ],
        } as any,
      },
    });
    const files = generateMcpServer(ctx, "cf");
    const workerFile = files.find((f) => f.filename === "mcp-server/worker.ts")!;
    expect(workerFile).toBeDefined();
    // SDK section
    expect(workerFile.content).toContain('"list-pets"');
    // tools/list entry
    expect(workerFile.content).toContain('name: "list-pets"');
    // readOnly annotations (GET endpoint)
    expect(workerFile.content).toContain("readOnlyHint: true");
    expect(workerFile.content).toContain("destructiveHint: false");
  });

  it("cloudflare worker.ts tools/call dispatches openapi tool with fetch", () => {
    const ctx = makeCtx({
      metadata: {
        baseUrl: "https://api.example.com",
        wellKnown: {},
        openapi: {
          specUrl: "https://api.example.com/openapi.json",
          version: "3.0.0",
          serverUrl: "https://api.example.com",
          endpoints: [
            {
              path: "/pets/{petId}",
              method: "get",
              operationId: "getPet",
              summary: "Get a pet",
              parameters: [{ name: "petId", in: "path", required: true, type: "string" }],
            },
          ],
        } as any,
      },
    });
    const files = generateMcpServer(ctx, "cf");
    const workerFile = files.find((f) => f.filename === "mcp-server/worker.ts")!;
    // tools/call: else if dispatch
    expect(workerFile.content).toContain('"get-pet"');
    expect(workerFile.content).toContain("fetch(");
    expect(workerFile.content).toContain("AbortController");
    expect(workerFile.content).toContain("10000");
    expect(workerFile.content).toContain("isError: true");
    // Path param substitution baked in (the generated URL expression contains the path)
    expect(workerFile.content).toContain("{petId}");
  });

  it("cloudflare worker.ts openapi POST tool uses write annotations and body", () => {
    const ctx = makeCtx({
      metadata: {
        baseUrl: "https://api.example.com",
        wellKnown: {},
        openapi: {
          specUrl: "https://api.example.com/openapi.json",
          version: "3.0.0",
          serverUrl: "https://api.example.com",
          endpoints: [
            {
              path: "/pets",
              method: "post",
              operationId: "createPet",
              summary: "Create a pet",
              parameters: [],
              requestBody: { properties: { name: { type: "string" }, age: { type: "integer" } } },
            },
          ],
        } as any,
      },
    });
    const files = generateMcpServer(ctx, "cf");
    const workerFile = files.find((f) => f.filename === "mcp-server/worker.ts")!;
    expect(workerFile.content).toContain('"create-pet"');
    // Write annotations in tools/list
    expect(workerFile.content).toContain("destructiveHint: true");
    expect(workerFile.content).toContain("idempotentHint: false");
    // Body construction
    expect(workerFile.content).toContain("application/json");
    expect(workerFile.content).toContain("JSON.stringify");
  });
});

// --- E-commerce tools ---

const mockArtifacts: EcommerceArtifacts = {
  products: [
    {
      productId: "p_abc123",
      name: "Test Widget",
      description: "A great widget",
      url: "https://example.com/products/widget",
      price: 29.99,
      currency: "USD",
      availability: "InStock",
      brand: "Acme",
      sku: "WIDGET-001",
      source: "json-ld",
    },
    {
      productId: "p_def456",
      name: "Another Product",
      url: "https://example.com/products/another",
      price: 49.99,
      currency: "USD",
      availability: "OutOfStock",
      rating: 4.2,
      reviewCount: 55,
      bestRating: 5,
      source: "microdata",
    },
  ],
};

describe("e-commerce tools", () => {
  it("adds commerce tools when artifacts have products", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Shop", description: "", markdown: "Welcome" }],
    });
    const result = detectTools(ctx, mockArtifacts);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("search-products");
    expect(names).toContain("get-product");
    expect(names).toContain("check-inventory");
    expect(names).toContain("get-reviews");
    expect(result.hasProducts).toBe(true);
  });

  it("does not add commerce tools without artifacts", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Home", description: "", markdown: "Hello" }],
    });
    const result = detectTools(ctx);
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("search-products");
    expect(result.hasProducts).toBe(false);
  });

  it("does not add commerce tools when artifacts have no products", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Home", description: "", markdown: "Hello" }],
    });
    const result = detectTools(ctx, { products: [] });
    expect(result.hasProducts).toBe(false);
  });

  it("generates products.json when artifacts have products", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Shop", description: "", markdown: "Welcome" }],
    });
    const files = generateMcpServer(ctx, undefined, mockArtifacts);
    const productsFile = files.find((f) => f.filename === "mcp-server/data/products.json");
    expect(productsFile).toBeDefined();
    const data = JSON.parse(productsFile!.content);
    expect(data).toHaveLength(2);
    expect(data[0].productId).toBe("p_abc123");
  });

  it("does not generate products.json without artifacts", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Home", description: "", markdown: "Hello" }],
    });
    const files = generateMcpServer(ctx);
    expect(files.some((f) => f.filename === "mcp-server/data/products.json")).toBe(false);
  });

  it("standalone server.ts includes commerce tools when products exist", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Shop", description: "", markdown: "Content" }],
    });
    const files = generateMcpServer(ctx, undefined, mockArtifacts);
    const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
    expect(serverFile.content).toContain('server.tool("search-products"');
    expect(serverFile.content).toContain('server.tool("get-product"');
    expect(serverFile.content).toContain('server.tool("check-inventory"');
    expect(serverFile.content).toContain('server.tool("get-reviews"');
    expect(serverFile.content).toContain("searchProducts");
    expect(serverFile.content).toContain("data/products.json");
  });

  it("vercel api/mcp.ts includes commerce tools when products exist", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Shop", description: "", markdown: "Content" }],
    });
    const files = generateMcpServer(ctx, "vercel", mockArtifacts);
    const apiFile = files.find((f) => f.filename === "mcp-server/api/mcp.ts")!;
    expect(apiFile.content).toContain('server.tool("search-products"');
    expect(apiFile.content).toContain("products.json");
  });

  it("cf worker.ts includes commerce tools and setup.sh uploads products", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Shop", description: "", markdown: "Content" }],
    });
    const files = generateMcpServer(ctx, "cf", mockArtifacts);
    const workerFile = files.find((f) => f.filename === "mcp-server/worker.ts")!;
    expect(workerFile.content).toContain("search-products");
    const setupFile = files.find((f) => f.filename === "mcp-server/setup.sh")!;
    expect(setupFile.content).toContain('"products"');
  });

  it("commerce tools have readOnly annotations in standalone template", () => {
    const ctx = makeCtx({
      pages: [{ url: "https://example.com/", title: "Shop", description: "", markdown: "Content" }],
    });
    const files = generateMcpServer(ctx, undefined, mockArtifacts);
    const serverFile = files.find((f) => f.filename === "mcp-server/server.ts")!;
    const searchIdx = serverFile.content.indexOf('"search-products"');
    const afterSearch = serverFile.content.slice(searchIdx, searchIdx + 300);
    expect(afterSearch).toContain("readOnlyHint: true");
  });
});
