import { describe, expect, it } from "vitest";
import { astroAdapter } from "../src/adapters/astro/index.js";
import { docusaurusAdapter } from "../src/adapters/docusaurus/index.js";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import { nuxtAdapter } from "../src/adapters/nuxt/index.js";
import { allAdapters, detectPlatform, getAdapter } from "../src/adapters/registry.js";
import { shopifyAdapter } from "../src/adapters/shopify/index.js";
import { wordpressAdapter } from "../src/adapters/wordpress/index.js";
import type { FetchedPage, SiteMetadata } from "../src/audit/types.js";
import type { GenerateContext, GeneratedFile } from "../src/generate/types.js";

// Ensure adapters are registered
import "../src/adapters/index.js";

function makePage(
  html: string,
  url = "https://example.com",
  headers: Record<string, string> = {},
): FetchedPage {
  return {
    url,
    status: 200,
    html,
    headers: { "content-type": "text/html", ...headers },
    responseTime: 100,
  };
}

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

function makeCtx(pages: FetchedPage[] = [], baseUrl = "https://example.com"): GenerateContext {
  return { pages: [], rawPages: pages, metadata: baseMeta, baseUrl };
}

function makeCoreFiles(): GeneratedFile[] {
  return [
    { filename: "llms.txt", content: "# Example\n\n> A test site\n", size: 25 },
    { filename: "llms-full.txt", content: "# Full content\n", size: 16 },
    { filename: "robots.txt", content: "User-agent: *\nAllow: /\n", size: 23 },
    { filename: "agent-card.json", content: '{"name":"Example"}', size: 18 },
  ];
}

// ─── Registry ───────────────────────────────────────────────────

describe("adapter registry", () => {
  it("has all 6 adapters registered", () => {
    expect(allAdapters()).toHaveLength(6);
  });

  it("can retrieve each adapter by ID", () => {
    expect(getAdapter("wordpress")).toBe(wordpressAdapter);
    expect(getAdapter("nextjs")).toBe(nextjsAdapter);
    expect(getAdapter("shopify")).toBe(shopifyAdapter);
    expect(getAdapter("docusaurus")).toBe(docusaurusAdapter);
    expect(getAdapter("nuxt")).toBe(nuxtAdapter);
    expect(getAdapter("astro")).toBe(astroAdapter);
  });

  it("returns undefined for unknown platform", () => {
    expect(getAdapter("rails" as any)).toBeUndefined();
  });
});

// ─── WordPress Detection ────────────────────────────────────────

describe("WordPress detection", () => {
  it("detects via generator meta tag (confidence 1.0)", () => {
    const page = makePage(
      '<html><head><meta name="generator" content="WordPress 6.4.2"></head><body></body></html>',
    );
    const result = wordpressAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.platform).toBe("wordpress");
    expect(result?.confidence).toBe(1.0);
    expect(result?.version).toBe("6.4.2");
  });

  it("detects via wp-content paths (confidence 0.95)", () => {
    const page = makePage(
      '<html><body><link rel="stylesheet" href="/wp-content/themes/test/style.css"></body></html>',
    );
    const result = wordpressAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.95);
  });

  it("detects via wp-json link (confidence 0.85)", () => {
    const page = makePage("<html><head></head><body></body></html>", "https://example.com", {
      link: '<https://example.com/wp-json/>; rel="https://api.w.org/"',
    });
    const result = wordpressAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.85);
  });

  it("returns null for non-WordPress site", () => {
    const page = makePage("<html><body>Hello</body></html>");
    const result = wordpressAdapter.detect([page], baseMeta);
    expect(result).toBeNull();
  });
});

// ─── Next.js Detection ──────────────────────────────────────────

describe("Next.js detection", () => {
  it("detects via __NEXT_DATA__ (confidence 1.0)", () => {
    const page = makePage(
      '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></body></html>',
    );
    const result = nextjsAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.platform).toBe("nextjs");
    expect(result?.confidence).toBe(1.0);
  });

  it("detects via _next/static assets (confidence 0.95)", () => {
    const page = makePage(
      '<html><head><link rel="preload" href="/_next/static/chunks/main.js"></head><body></body></html>',
    );
    const result = nextjsAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.95);
  });

  it("detects via x-powered-by header (confidence 0.95)", () => {
    const page = makePage("<html><body></body></html>", "https://example.com", {
      "x-powered-by": "Next.js",
    });
    const result = nextjsAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.95);
  });

  it("returns null for non-Next.js site", () => {
    const page = makePage("<html><body>Hello</body></html>");
    const result = nextjsAdapter.detect([page], baseMeta);
    expect(result).toBeNull();
  });
});

// ─── Shopify Detection ──────────────────────────────────────────

describe("Shopify detection", () => {
  it("detects via cdn.shopify.com (confidence 0.95)", () => {
    const page = makePage(
      '<html><body><img src="https://cdn.shopify.com/s/files/1/image.jpg"></body></html>',
    );
    const result = shopifyAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.platform).toBe("shopify");
    expect(result?.confidence).toBe(0.95);
  });

  it("detects via Shopify headers (confidence 0.95)", () => {
    const page = makePage("<html><body></body></html>", "https://example.com", {
      "x-shopify-stage": "production",
    });
    const result = shopifyAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.95);
  });

  it("detects via myshopify.com domain (confidence 0.9)", () => {
    const page = makePage("<html><body></body></html>", "https://mystore.myshopify.com");
    const result = shopifyAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.9);
  });

  it("returns null for non-Shopify site", () => {
    const page = makePage("<html><body>Hello</body></html>");
    const result = shopifyAdapter.detect([page], baseMeta);
    expect(result).toBeNull();
  });
});

// ─── Docusaurus Detection ───────────────────────────────────────

describe("Docusaurus detection", () => {
  it("detects via generator meta tag (confidence 1.0)", () => {
    const page = makePage(
      '<html><head><meta name="generator" content="Docusaurus v3.1.0"></head><body></body></html>',
    );
    const result = docusaurusAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.platform).toBe("docusaurus");
    expect(result?.confidence).toBe(1.0);
    expect(result?.version).toBe("3.1.0");
  });

  it("detects via html class (confidence 0.95)", () => {
    const page = makePage('<html class="docusaurus-something" lang="en"><body></body></html>');
    const result = docusaurusAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.95);
  });

  it("detects via docusaurus DOM elements (confidence 0.9)", () => {
    const page = makePage('<html><body><div class="docusaurus-content">Docs</div></body></html>');
    const result = docusaurusAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.9);
  });

  it("returns null for non-Docusaurus site", () => {
    const page = makePage("<html><body>Hello</body></html>");
    const result = docusaurusAdapter.detect([page], baseMeta);
    expect(result).toBeNull();
  });
});

// ─── Nuxt Detection ─────────────────────────────────────────────

describe("Nuxt detection", () => {
  it("detects via generator meta tag (confidence 1.0)", () => {
    const page = makePage(
      '<html><head><meta name="generator" content="Nuxt 3.12.4"></head><body></body></html>',
    );
    const result = nuxtAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.platform).toBe("nuxt");
    expect(result?.confidence).toBe(1.0);
    expect(result?.version).toBe("3.12.4");
  });

  it("detects via __NUXT_DATA__ (confidence 0.95)", () => {
    const page = makePage(
      '<html><body><script type="application/json" id="__NUXT_DATA__">[]</script></body></html>',
    );
    const result = nuxtAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.95);
  });

  it("detects via __NUXT__ global (confidence 0.95)", () => {
    const page = makePage("<html><body><script>window.__NUXT__={}</script></body></html>");
    const result = nuxtAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.95);
  });

  it("detects via /_nuxt/ asset paths (confidence 0.85)", () => {
    const page = makePage(
      '<html><head><link rel="preload" href="/_nuxt/entry.abc123.js"></head><body></body></html>',
    );
    const result = nuxtAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.85);
  });

  it("detects via x-powered-by header (confidence 0.95)", () => {
    const page = makePage("<html><body></body></html>", "https://example.com", {
      "x-powered-by": "Nuxt",
    });
    const result = nuxtAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.95);
  });

  it("returns null for non-Nuxt site", () => {
    const page = makePage("<html><body>Hello</body></html>");
    const result = nuxtAdapter.detect([page], baseMeta);
    expect(result).toBeNull();
  });
});

// ─── Astro Detection ────────────────────────────────────────────

describe("Astro detection", () => {
  it("detects via generator meta tag (confidence 1.0)", () => {
    const page = makePage(
      '<html><head><meta name="generator" content="Astro v4.15.9"></head><body></body></html>',
    );
    const result = astroAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.platform).toBe("astro");
    expect(result?.confidence).toBe(1.0);
    expect(result?.version).toBe("4.15.9");
  });

  it("detects via astro-island custom element (confidence 0.95)", () => {
    const page = makePage(
      '<html><body><astro-island component-url="/_astro/Counter.abc.js"></astro-island></body></html>',
    );
    const result = astroAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.95);
  });

  it("detects via data-astro-cid attributes (confidence 0.9)", () => {
    const page = makePage("<html><body><div data-astro-cid-abc123>Content</div></body></html>");
    const result = astroAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.9);
  });

  it("detects via /_astro/ asset paths (confidence 0.85)", () => {
    const page = makePage(
      '<html><head><link rel="stylesheet" href="/_astro/index.abc123.css"></head><body></body></html>',
    );
    const result = astroAdapter.detect([page], baseMeta);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe(0.85);
  });

  it("returns null for non-Astro site", () => {
    const page = makePage("<html><body>Hello</body></html>");
    const result = astroAdapter.detect([page], baseMeta);
    expect(result).toBeNull();
  });
});

// ─── detectPlatform (registry-level) ────────────────────────────

describe("detectPlatform", () => {
  it("returns null for generic site", () => {
    const page = makePage("<html><body>Hello world</body></html>");
    const result = detectPlatform([page], baseMeta);
    expect(result).toBeNull();
  });

  it("returns highest confidence when multiple signals present", () => {
    const page = makePage(
      '<html><head><meta name="generator" content="WordPress 6.5"></head>' +
        '<body><script id="__NEXT_DATA__">{}</script></body></html>',
    );
    const result = detectPlatform([page], baseMeta);
    expect(result).not.toBeNull();
    // Both WordPress and Next.js are 1.0 confidence — either is acceptable
    expect(["wordpress", "nextjs"]).toContain(result?.platform);
    expect(result?.confidence).toBe(1.0);
  });

  it("picks WordPress for typical WP page", () => {
    const page = makePage(
      '<html><head><meta name="generator" content="WordPress 6.4"></head>' +
        '<body><link rel="stylesheet" href="/wp-content/themes/astra/style.css"></body></html>',
    );
    const result = detectPlatform([page], baseMeta);
    expect(result?.platform).toBe("wordpress");
  });
});

// ─── WordPress Checks ───────────────────────────────────────────

describe("WordPress checks", () => {
  it("has 4 checks", () => {
    expect(wordpressAdapter.checks).toHaveLength(4);
  });

  it("all checks return valid results", async () => {
    const page = makePage(
      '<html><head><meta name="generator" content="WordPress 6.4"></head><body></body></html>',
    );
    for (const check of wordpressAdapter.checks) {
      const result = await check.run([page], baseMeta);
      expect(result.id).toBe(check.id);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.maxScore).toBe(100);
      expect(["pass", "fail", "partial", "skip"]).toContain(result.status);
    }
  });

  it("wp-rest-api-accessible passes when wp-json link present", () => {
    const check = wordpressAdapter.checks.find((c) => c.id === "wp-rest-api-accessible")!;
    const page = makePage(
      '<html><body><link rel="https://api.w.org/" href="/wp-json/"></body></html>',
    );
    const result = check.run([page], baseMeta);
    expect((result as any).status).toBe("pass");
  });

  it("wp-robots-default-blocking passes when no AI bots blocked", () => {
    const check = wordpressAdapter.checks.find((c) => c.id === "wp-robots-default-blocking")!;
    const meta = { ...baseMeta, robotsTxt: "User-agent: *\nAllow: /\n" };
    const result = check.run([], meta);
    expect((result as any).status).toBe("pass");
  });

  // D-2: must agree with ai-agent-access, which scores training opt-outs as neutral.
  it("wp-robots-default-blocking passes when only training crawlers are blocked", () => {
    const check = wordpressAdapter.checks.find((c) => c.id === "wp-robots-default-blocking")!;
    const meta = {
      ...baseMeta,
      robotsTxt: "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n",
    };
    expect(check.run([], meta)).toMatchObject({ status: "pass", score: 100 });
  });

  it("wp-robots-default-blocking deducts 20 per blocked user/search token, evaluated by robots-parser", () => {
    const check = wordpressAdapter.checks.find((c) => c.id === "wp-robots-default-blocking")!;
    const meta = {
      ...baseMeta,
      robotsTxt:
        "User-agent: ChatGPT-User\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n",
    };
    const result = check.run([], meta) as any;
    expect(result).toMatchObject({ status: "fail", score: 60 });
    expect(result.message).toContain("ChatGPT-User, PerplexityBot");
    expect(result.message).not.toContain("GPTBot,");
  });

  it("wp-robots-default-blocking does not treat a path-only disallow as blocking", () => {
    const check = wordpressAdapter.checks.find((c) => c.id === "wp-robots-default-blocking")!;
    const meta = { ...baseMeta, robotsTxt: "User-agent: ChatGPT-User\nDisallow: /wp-admin/\n" };
    expect(check.run([], meta)).toMatchObject({ status: "pass", score: 100 });
  });
});

// ─── Next.js Checks ─────────────────────────────────────────────

describe("Next.js checks", () => {
  it("has 3 checks", () => {
    expect(nextjsAdapter.checks).toHaveLength(3);
  });

  it("all checks return valid results", async () => {
    const page = makePage('<html><body><script id="__NEXT_DATA__">{}</script></body></html>');
    for (const check of nextjsAdapter.checks) {
      const result = await check.run([page], baseMeta);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it("nextjs-well-known-served counts agent-card.json only, not the retired ai-plugin.json", async () => {
    const check = nextjsAdapter.checks.find((c) => c.id === "nextjs-well-known-served");
    const page = makePage("<html></html>");
    const withCard = await check?.run([page], {
      ...baseMeta,
      wellKnown: { "agent-card.json": '{"name":"x"}' },
    });
    expect(withCard?.status).toBe("pass");
    const pluginOnly = await check?.run([page], {
      ...baseMeta,
      wellKnown: { "ai-plugin.json": '{"schema_version":"v1"}' },
    });
    expect(pluginOnly?.status).toBe("fail");
    const namelessJson = await check?.run([page], {
      ...baseMeta,
      wellKnown: { "agent-card.json": '{"error":"not found"}' },
    });
    expect(namelessJson).toMatchObject({ status: "fail", score: 0 });
  });
});

// ─── Shopify Checks ─────────────────────────────────────────────

describe("Shopify checks", () => {
  it("has 3 checks", () => {
    expect(shopifyAdapter.checks).toHaveLength(3);
  });

  it("shopify-product-schema skips when no product pages", () => {
    const check = shopifyAdapter.checks.find((c) => c.id === "shopify-product-schema")!;
    const page = makePage("<html><body>Homepage</body></html>");
    const result = check.run([page], baseMeta);
    expect((result as any).status).toBe("skip");
  });

  it("shopify-product-schema passes with Product JSON-LD", () => {
    const check = shopifyAdapter.checks.find((c) => c.id === "shopify-product-schema")!;
    const page = makePage(
      '<html><body><script type="application/ld+json">{"@type":"Product","name":"Test"}</script></body></html>',
      "https://example.com/products/test-product",
    );
    const result = check.run([page], baseMeta);
    expect((result as any).status).toBe("pass");
  });
});

// ─── Docusaurus Checks ──────────────────────────────────────────

describe("Docusaurus checks", () => {
  it("has 2 checks", () => {
    expect(docusaurusAdapter.checks).toHaveLength(2);
  });

  it("docusaurus-versioned-docs skips when no versioned docs", () => {
    const check = docusaurusAdapter.checks.find((c) => c.id === "docusaurus-versioned-docs")!;
    const page = makePage("<html><body>Simple docs</body></html>");
    const result = check.run([page], baseMeta);
    expect((result as any).status).toBe("skip");
  });
});

// ─── Nuxt Checks ────────────────────────────────────────────────

describe("Nuxt checks", () => {
  it("has 4 checks", () => {
    expect(nuxtAdapter.checks).toHaveLength(4);
  });

  it("all checks return valid results", async () => {
    const page = makePage(
      '<html><head><meta name="generator" content="Nuxt 3.12"></head><body><p>Nuxt content here with enough text</p></body></html>',
    );
    for (const check of nuxtAdapter.checks) {
      const result = await check.run([page], baseMeta);
      expect(result.id).toBe(check.id);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.maxScore).toBe(100);
      expect(["pass", "fail", "partial", "skip"]).toContain(result.status);
    }
  });

  it("nuxt-ssr-hints passes for server-rendered pages", () => {
    const check = nuxtAdapter.checks.find((c) => c.id === "nuxt-ssr-hints")!;
    const page = makePage(
      "<html><body><div>A substantial amount of server-rendered content that proves this page is not a bare SPA shell. It has real meaningful content here.</div><p>More content for good measure to exceed the threshold.</p></body></html>",
    );
    const result = check.run([page], baseMeta);
    expect((result as any).status).toBe("pass");
  });
});

// ─── Astro Checks ───────────────────────────────────────────────

describe("Astro checks", () => {
  it("has 3 checks", () => {
    expect(astroAdapter.checks).toHaveLength(3);
  });

  it("all checks return valid results", async () => {
    const page = makePage(
      '<html><head><meta name="generator" content="Astro v4.15"></head><body><p>Astro content</p></body></html>',
    );
    for (const check of astroAdapter.checks) {
      const result = await check.run([page], baseMeta);
      expect(result.id).toBe(check.id);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.maxScore).toBe(100);
      expect(["pass", "fail", "partial", "skip"]).toContain(result.status);
    }
  });

  it("astro-sitemap-integration passes when sitemap exists", () => {
    const check = astroAdapter.checks.find((c) => c.id === "astro-sitemap-integration")!;
    const meta = { ...baseMeta, wellKnown: { "sitemap.xml": "<xml>sitemap</xml>" } };
    const result = check.run([], meta);
    expect((result as any).status).toBe("pass");
  });

  it("astro-sitemap-integration fails when no sitemap", () => {
    const check = astroAdapter.checks.find((c) => c.id === "astro-sitemap-integration")!;
    const result = check.run([], baseMeta);
    expect((result as any).status).toBe("fail");
  });

  it("astro-robots-txt passes when robots.txt allows AI bots", () => {
    const check = astroAdapter.checks.find((c) => c.id === "astro-robots-txt")!;
    const meta = { ...baseMeta, robotsTxt: "User-agent: *\nAllow: /\n" };
    const result = check.run([], meta);
    expect((result as any).status).toBe("pass");
  });

  // D-2: must agree with ai-agent-access, which scores training opt-outs as neutral.
  it("astro-robots-txt passes when only training crawlers are blocked", () => {
    const check = astroAdapter.checks.find((c) => c.id === "astro-robots-txt")!;
    const meta = {
      ...baseMeta,
      robotsTxt: "User-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: CCBot\nDisallow: /\n",
    };
    expect(check.run([], meta)).toMatchObject({ status: "pass", score: 100 });
  });

  it("astro-robots-txt fails when a user-initiated or search token is blocked at the root", () => {
    const check = astroAdapter.checks.find((c) => c.id === "astro-robots-txt")!;
    const meta = {
      ...baseMeta,
      robotsTxt: "User-agent: Claude-User\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n",
    };
    const result = check.run([], meta) as any;
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.message).toBe("robots.txt blocks AI bots: Claude-User");
  });

  it("astro-robots-txt does not treat a path-only disallow as blocking", () => {
    const check = astroAdapter.checks.find((c) => c.id === "astro-robots-txt")!;
    const meta = { ...baseMeta, robotsTxt: "User-agent: ChatGPT-User\nDisallow: /drafts/\n" };
    expect(check.run([], meta)).toMatchObject({ status: "pass", score: 100 });
  });
});

// ─── Integration File Generation ────────────────────────────────

describe("WordPress integration generation", () => {
  it("generates 5 files", () => {
    const files = wordpressAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    expect(files).toHaveLength(5);
  });

  it("generates valid PHP plugin", () => {
    const files = wordpressAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const plugin = files.find((f) => f.filename === "wordpress/w2agent-plugin.php");
    expect(plugin).toBeDefined();
    expect(plugin?.content).toContain("<?php");
    expect(plugin?.content).toContain("Plugin Name: w2agent");
    expect(plugin?.content).toContain("w2agent_generate_llms_txt");
    expect(plugin?.content).toContain("template_redirect");
    expect(plugin?.content).toContain("robots_txt");
    expect(plugin?.content).toContain("wp_head");
  });

  it("generates dynamic WP plugin (queries database)", () => {
    const files = wordpressAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const plugin = files.find((f) => f.filename === "wordpress/w2agent-plugin.php");
    expect(plugin?.content).toContain("get_posts");
    expect(plugin?.content).toContain("w2agent_generate_llms_txt");
    expect(plugin?.content).toContain("save_post");
    expect(plugin?.content).toContain("admin_menu");
  });

  it("includes INSTALL.md", () => {
    const files = wordpressAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const install = files.find((f) => f.filename === "wordpress/INSTALL.md");
    expect(install).toBeDefined();
    expect(install?.content).toContain("Dynamically generated");
    expect(install?.content).toContain("--a2a-endpoint");
  });

  it("includes seed data files", () => {
    const files = wordpressAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const filenames = files.map((f) => f.filename);
    expect(filenames).toContain("wordpress/data/llms.txt");
    expect(filenames).toContain("wordpress/data/agent-card.json");
    expect(filenames).toContain("wordpress/data/robots-rules.txt");
  });
});

describe("Next.js integration generation", () => {
  it("generates 9 files", () => {
    const files = nextjsAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    expect(files).toHaveLength(9);
  });

  it("generates ISR route handlers (not just static files)", () => {
    const files = nextjsAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const llmsRoute = files.find((f) => f.filename === "nextjs/app/llms.txt/route.ts");
    expect(llmsRoute).toBeDefined();
    expect(llmsRoute?.content).toContain("revalidate");
    expect(llmsRoute?.content).toContain("export async function GET");
    expect(llmsRoute?.content).toContain("s-maxage=3600");
  });

  it("the agent-card route 404s when .w2agent/agent-card.json is missing, never a schema.org stand-in", () => {
    // Any 200 JSON at /.well-known/agent-card.json is audited as a (broken) A2A card.
    const files = nextjsAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const route = files.find(
      (f) => f.filename === "nextjs/app/.well-known/agent-card.json/route.ts",
    )?.content;
    expect(route).toContain('return new NextResponse("Not Found", { status: 404 });');
    expect(route).not.toContain("schema.org");
    expect(route).not.toContain("WebSite");
  });

  it("generates middleware with content negotiation", () => {
    const files = nextjsAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const mw = files.find((f) => f.filename === "nextjs/middleware.ts");
    expect(mw).toBeDefined();
    expect(mw?.content).toContain("text/markdown");
    expect(mw?.content).toContain("NextResponse.rewrite");
  });

  it("generates build script for CI/CD", () => {
    const files = nextjsAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const build = files.find((f) => f.filename === "nextjs/w2agent-build.mjs");
    expect(build).toBeDefined();
    expect(build?.content).toContain("execFileSync");
    expect(build?.content).toContain("w2agent");
  });

  it("includes static seed files", () => {
    const files = nextjsAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const filenames = files.map((f) => f.filename);
    expect(filenames).toContain("nextjs/.w2agent/llms.txt");
    expect(filenames).toContain("nextjs/.w2agent/llms-full.txt");
    expect(filenames).toContain("nextjs/.w2agent/agent-card.json");
  });

  it("all generated TypeScript files start with eslint-disable header", () => {
    const files = nextjsAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const tsFiles = files.filter((f) => f.filename.endsWith(".ts"));
    expect(tsFiles.length).toBeGreaterThan(0);
    for (const file of tsFiles) {
      expect(file.content, `${file.filename} missing eslint-disable header`).toMatch(
        /^\/\* eslint-disable \*\//,
      );
    }
  });
});

describe("Shopify integration generation", () => {
  it("generates 5 files", () => {
    const files = shopifyAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    expect(files).toHaveLength(5);
  });

  it("generates Liquid snippet with dynamic product data", () => {
    const files = shopifyAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const snippet = files.find((f) => f.filename === "shopify/snippets/w2agent-head.liquid");
    expect(snippet).toBeDefined();
    expect(snippet?.content).toContain("{{ product.title");
    expect(snippet?.content).toContain("{{ product.price");
    expect(snippet?.content).toContain("product.available");
  });

  it("generates robots.txt.liquid template", () => {
    const files = shopifyAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const robots = files.find((f) => f.filename === "shopify/templates/robots.txt.liquid");
    expect(robots).toBeDefined();
    expect(robots?.content).toContain("{{ shop.url }}");
    expect(robots?.content).toContain("Disallow: /checkout");
  });
});

describe("Docusaurus integration generation", () => {
  it("generates 4 files", () => {
    const files = docusaurusAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    expect(files).toHaveLength(4);
  });

  it("generates build plugin that reads from docs directory", () => {
    const files = docusaurusAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const plugin = files.find((f) => f.filename === "docusaurus/w2agent-plugin.js");
    expect(plugin).toBeDefined();
    expect(plugin?.content).toContain("generateFromDocs");
    expect(plugin?.content).toContain("walkDir");
    expect(plugin?.content).toContain("gray-matter");
    expect(plugin?.content).toContain("postBuild");
  });

  it("includes static fallback files", () => {
    const files = docusaurusAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const filenames = files.map((f) => f.filename);
    expect(filenames).toContain("docusaurus/static/llms.txt");
    expect(filenames).toContain("docusaurus/static/.well-known/agent-card.json");
  });
});

describe("Nuxt integration generation", () => {
  it("generates 8 files", () => {
    const files = nuxtAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    expect(files).toHaveLength(8);
  });

  it("generates Nitro cached event handlers", () => {
    const files = nuxtAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const llmsRoute = files.find((f) => f.filename === "nuxt/server/routes/llms.txt.ts");
    expect(llmsRoute).toBeDefined();
    expect(llmsRoute?.content).toContain("defineCachedEventHandler");
    expect(llmsRoute?.content).toContain("maxAge: 3600");
  });

  it("generates content negotiation middleware", () => {
    const files = nuxtAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const mw = files.find((f) => f.filename === "nuxt/server/middleware/content-negotiation.ts");
    expect(mw).toBeDefined();
    expect(mw?.content).toContain("defineEventHandler");
    expect(mw?.content).toContain("text/markdown");
    expect(mw?.content).toContain("sendRedirect");
  });

  it("includes static fallback files", () => {
    const files = nuxtAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const filenames = files.map((f) => f.filename);
    expect(filenames).toContain("nuxt/public/llms.txt");
    expect(filenames).toContain("nuxt/public/llms-full.txt");
  });

  it("includes INSTALL.md", () => {
    const files = nuxtAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const install = files.find((f) => f.filename === "nuxt/INSTALL.md");
    expect(install).toBeDefined();
    expect(install?.content).toContain("Nitro");
  });
});

describe("Astro integration generation", () => {
  it("generates 8 files", () => {
    const files = astroAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    expect(files).toHaveLength(8);
  });

  it("generates static public files (Astro's strength)", () => {
    const files = astroAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const filenames = files.map((f) => f.filename);
    expect(filenames).toContain("astro/public/llms.txt");
    expect(filenames).toContain("astro/public/llms-full.txt");
    expect(filenames).toContain("astro/public/.well-known/agent-card.json");
  });

  it("generates SSR API endpoints", () => {
    const files = astroAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const llmsEndpoint = files.find((f) => f.filename === "astro/src/pages/llms.txt.ts");
    expect(llmsEndpoint).toBeDefined();
    expect(llmsEndpoint?.content).toContain("APIRoute");
    expect(llmsEndpoint?.content).toContain("export const GET");
  });

  it("generates Astro integration plugin", () => {
    const files = astroAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const plugin = files.find((f) => f.filename === "astro/w2agent-integration.mjs");
    expect(plugin).toBeDefined();
    expect(plugin?.content).toContain("astro:build:done");
    expect(plugin?.content).toContain("execFileSync");
    expect(plugin?.content).toContain("w2agent");
  });

  it("includes INSTALL.md", () => {
    const files = astroAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const install = files.find((f) => f.filename === "astro/INSTALL.md");
    expect(install).toBeDefined();
    expect(install?.content).toContain("static-first");
  });
});

// ─── MCP Webhook Snippets ──────────────────────────────────────

function makeCoreFilesWithMcp(): GeneratedFile[] {
  return [
    ...makeCoreFiles(),
    { filename: "mcp-server/server.ts", content: "// server", size: 9 },
    { filename: "mcp-server/data/pages.json", content: "[]", size: 2 },
  ];
}

describe("WordPress MCP webhook snippet", () => {
  it("generates webhook PHP file when mcp-server files present", () => {
    const files = wordpressAdapter.generateIntegration(makeCtx(), makeCoreFilesWithMcp());
    const webhook = files.find((f) => f.filename === "wordpress/w2agent-mcp-webhook.php");
    expect(webhook).toBeDefined();
    expect(webhook?.content).toContain("save_post");
    expect(webhook?.content).toContain("wp_remote_post");
    expect(webhook?.content).toContain("W2AGENT_WEBHOOK_TOKEN");
  });

  it("does not generate webhook without mcp-server files", () => {
    const files = wordpressAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const webhook = files.find((f) => f.filename === "wordpress/w2agent-mcp-webhook.php");
    expect(webhook).toBeUndefined();
  });
});

describe("Next.js MCP webhook snippet", () => {
  it("generates webhook route when mcp-server files present", () => {
    const files = nextjsAdapter.generateIntegration(makeCtx(), makeCoreFilesWithMcp());
    const webhook = files.find((f) => f.filename.includes("w2agent-mcp-webhook"));
    expect(webhook).toBeDefined();
    expect(webhook?.content).toContain("W2AGENT_WEBHOOK_TOKEN");
  });

  it("requires W2AGENT_INBOUND_TOKEN and enforces Bearer auth", () => {
    const files = nextjsAdapter.generateIntegration(makeCtx(), makeCoreFilesWithMcp());
    const webhook = files.find((f) => f.filename.includes("w2agent-mcp-webhook"));
    expect(webhook?.content).toContain("W2AGENT_INBOUND_TOKEN");
    expect(webhook?.content).toContain("status: 401");
    expect(webhook?.content).toContain("Bearer ");
  });
});

describe("Shopify MCP webhook snippet", () => {
  it("generates webhook instructions when mcp-server files present", () => {
    const files = shopifyAdapter.generateIntegration(makeCtx(), makeCoreFilesWithMcp());
    const webhook = files.find((f) => f.filename.includes("MCP-WEBHOOK"));
    expect(webhook).toBeDefined();
    expect(webhook?.content).toContain("products/update");
  });
});

describe("Docusaurus MCP webhook snippet", () => {
  it("generates postBuild plugin when mcp-server files present", () => {
    const files = docusaurusAdapter.generateIntegration(makeCtx(), makeCoreFilesWithMcp());
    const webhook = files.find((f) => f.filename.includes("mcp-webhook"));
    expect(webhook).toBeDefined();
    expect(webhook?.content).toContain("postBuild");
    expect(webhook?.content).toContain("W2AGENT_WEBHOOK_TOKEN");
  });
});

describe("Nuxt MCP webhook snippet", () => {
  it("generates webhook Nitro route when mcp-server files present", () => {
    const files = nuxtAdapter.generateIntegration(makeCtx(), makeCoreFilesWithMcp());
    const webhook = files.find((f) => f.filename.includes("w2agent-mcp-webhook"));
    expect(webhook).toBeDefined();
    expect(webhook?.content).toContain("W2AGENT_WEBHOOK_TOKEN");
    expect(webhook?.content).toContain("defineEventHandler");
  });

  it("requires W2AGENT_INBOUND_TOKEN and enforces Bearer auth", () => {
    const files = nuxtAdapter.generateIntegration(makeCtx(), makeCoreFilesWithMcp());
    const webhook = files.find((f) => f.filename.includes("w2agent-mcp-webhook"));
    expect(webhook?.content).toContain("W2AGENT_INBOUND_TOKEN");
    expect(webhook?.content).toContain("statusCode: 401");
    expect(webhook?.content).toContain("Bearer ");
  });

  it("does not generate webhook without mcp-server files", () => {
    const files = nuxtAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const webhook = files.find((f) => f.filename.includes("w2agent-mcp-webhook"));
    expect(webhook).toBeUndefined();
  });
});

describe("Astro MCP webhook snippet", () => {
  it("generates webhook integration when mcp-server files present", () => {
    const files = astroAdapter.generateIntegration(makeCtx(), makeCoreFilesWithMcp());
    const webhook = files.find((f) => f.filename.includes("w2agent-mcp-webhook"));
    expect(webhook).toBeDefined();
    expect(webhook?.content).toContain("astro:build:done");
    expect(webhook?.content).toContain("W2AGENT_WEBHOOK_TOKEN");
  });

  it("does not generate webhook without mcp-server files", () => {
    const files = astroAdapter.generateIntegration(makeCtx(), makeCoreFiles());
    const webhook = files.find((f) => f.filename.includes("w2agent-mcp-webhook"));
    expect(webhook).toBeUndefined();
  });
});

// ─── No A2A endpoint → no agent card ────────────────────────────

describe("adapters without a generated agent card", () => {
  it("ship no agent-card file or route (an empty or fallback card would fail the audit)", () => {
    // Core emits agent-card.json only with an explicit A2A endpoint; adapters must not
    // back-fill a "{}" card or a schema.org fallback at /.well-known/agent-card.json.
    const coreFiles = makeCoreFiles().filter((f) => f.filename !== "agent-card.json");
    for (const adapter of [
      wordpressAdapter,
      nextjsAdapter,
      docusaurusAdapter,
      nuxtAdapter,
      astroAdapter,
    ]) {
      const names = adapter.generateIntegration(makeCtx(), coreFiles).map((f) => f.filename);
      expect(names.filter((n) => n.includes("agent-card"))).toEqual([]);
    }
  });
});

// ─── File sizes ─────────────────────────────────────────────────

describe("generated file sizes", () => {
  it("all generated files have correct size", () => {
    for (const adapter of allAdapters()) {
      const files = adapter.generateIntegration(makeCtx(), makeCoreFiles());
      for (const file of files) {
        const expectedSize = new TextEncoder().encode(file.content).length;
        expect(file.size).toBe(expectedSize);
      }
    }
  });

  it("no generated file is empty", () => {
    for (const adapter of allAdapters()) {
      const files = adapter.generateIntegration(makeCtx(), makeCoreFiles());
      for (const file of files) {
        expect(file.content.length).toBeGreaterThan(0);
        expect(file.size).toBeGreaterThan(0);
      }
    }
  });
});
