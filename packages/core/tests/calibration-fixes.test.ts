import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { FetchedPage, SiteMetadata } from "../src/audit/types.js";
import { agentAuthChecks } from "../src/audit/checks/agent-auth.js";
import { wellKnownAiPlugin } from "../src/audit/checks/discovery.js";
import { simClaude, simChatgpt, simGemini, simPerplexity, simDeepseek } from "../src/audit/checks/multi-ua-sim.js";
import { crawlSite, fetchUnderUas } from "../src/audit/crawler.js";

const publicApi = agentAuthChecks.find((c) => c.id === "public-api")!;

function makePage(html = "<html></html>", url = "https://stripe.com/"): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}
function makeMeta(baseUrl = "https://stripe.com"): SiteMetadata {
  return { baseUrl, wellKnown: {} };
}

describe("public-api accepts 4xx + JSON as positive evidence (A3)", () => {
  it("treats 404 + application/json from api.<host>/ as a real API surface", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://stripe.com/api/") {
        return new Response("<html></html>", { status: 404, headers: { "content-type": "text/html" } });
      }
      if (u === "https://api.stripe.com/") {
        return new Response('{"error":"missing auth"}', { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });
    const result = await publicApi.run([makePage()], makeMeta());
    fetchSpy.mockRestore();
    expect(result.status).toBe("pass");
    expect(result.score).toBe(100);
  });

  it("positive baseline: 200 + application/json still passes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://api.stripe.com/") {
        return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });
    const result = await publicApi.run([makePage()], makeMeta());
    fetchSpy.mockRestore();
    expect(result.status).toBe("pass");
    expect(result.score).toBe(100);
  });

  it("5xx + application/json does NOT pass (predicate excludes 5xx)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response('{"error":"unavailable"}', { status: 503, headers: { "content-type": "application/json" } });
    });
    const result = await publicApi.run([makePage()], makeMeta());
    fetchSpy.mockRestore();
    expect(result.status).toBe("fail");
  });

  it("4xx + text/html does NOT pass (predicate requires JSON/YAML content-type)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("<html>Unauthorized</html>", { status: 401, headers: { "content-type": "text/html" } });
    });
    const result = await publicApi.run([makePage()], makeMeta());
    fetchSpy.mockRestore();
    expect(result.status).toBe("fail");
  });

  it("YAML still passes: 200 + application/yaml from <host>/api/", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://stripe.com/api/") {
        return new Response("openapi: 3.0.0\n", { status: 200, headers: { "content-type": "application/yaml" } });
      }
      return new Response("", { status: 404 });
    });
    const result = await publicApi.run([makePage()], makeMeta());
    fetchSpy.mockRestore();
    expect(result.status).toBe("pass");
    expect(result.score).toBe(100);
  });
});

// --- A4: probeDeveloperPortal subdomain fallback ---
const developerPortal = agentAuthChecks.find((c) => c.id === "developer-portal")!;
const BIG_CONTENT = "Welcome to the API " + "x".repeat(1000);

describe("developer-portal subdomain fallback (A4)", () => {
  it("canonical path hits → no subdomain probe fired", async () => {
    const urls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      urls.push(u);
      if (u === "https://example.com/api") {
        return new Response(`<html><body>${BIG_CONTENT}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    });
    const result = await developerPortal.run(
      [{ url: "https://example.com/", status: 200, html: "<html></html>", headers: {}, responseTime: 100 }],
      { baseUrl: "https://example.com", wellKnown: {} },
    );
    fetchSpy.mockRestore();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("https://example.com/api");
    // No subdomain URLs should have been attempted
    const subdomainCalls = urls.filter(
      (u) => u.startsWith("https://docs.") || u.startsWith("https://developers.") || u.startsWith("https://developer."),
    );
    expect(subdomainCalls).toHaveLength(0);
  });

  it("all canonical fail → docs.<host>/ returns 200 → pass", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://docs.example.com/") {
        return new Response(`<html><body>${BIG_CONTENT}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    });
    const result = await developerPortal.run(
      [{ url: "https://example.com/", status: 200, html: "<html></html>", headers: {}, responseTime: 100 }],
      { baseUrl: "https://example.com", wellKnown: {} },
    );
    fetchSpy.mockRestore();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("docs.example.com");
  });

  it("all canonical and all subdomain fail → fail", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("", { status: 404 });
    });
    const result = await developerPortal.run(
      [{ url: "https://example.com/", status: 200, html: "<html></html>", headers: {}, responseTime: 100 }],
      { baseUrl: "https://example.com", wellKnown: {} },
    );
    fetchSpy.mockRestore();
    expect(result.status).toBe("fail");
  });

  it("docs.<host>/ 404 → developers.<host>/ 200 → pass", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://developers.example.com/") {
        return new Response(`<html><body>${BIG_CONTENT}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    });
    const result = await developerPortal.run(
      [{ url: "https://example.com/", status: 200, html: "<html></html>", headers: {}, responseTime: 100 }],
      { baseUrl: "https://example.com", wellKnown: {} },
    );
    fetchSpy.mockRestore();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("developers.example.com");
  });
});

// --- A4: llms.txt subdomain fallback ---
const BASE_AUDIT_OPTIONS = {
  maxPages: 1,
  timeout: 5000,
  requestDelay: 0,
  concurrency: 1,
  userAgent: "test-agent",
};

function makeCrawlFetch(overrides: Record<string, { status: number; body: string; ct?: string }>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const u = String(url);
    for (const [pattern, resp] of Object.entries(overrides)) {
      if (u === pattern || u.startsWith(pattern)) {
        return new Response(resp.body, {
          status: resp.status,
          headers: { "content-type": resp.ct ?? "text/plain" },
        });
      }
    }
    return new Response("", { status: 404 });
  });
}

describe("llms.txt subdomain fallback (A4)", () => {
  it("canonical <host>/llms.txt 200 → metadata.llmsTxt set, no subdomain probe", async () => {
    const urls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      urls.push(u);
      if (u === "https://example.com/") {
        return new Response("<html><body>homepage</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (u === "https://example.com/llms.txt") {
        return new Response("# LLMs\nModel: gpt-4", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("", { status: 404 });
    });
    const result = await crawlSite("https://example.com/", BASE_AUDIT_OPTIONS);
    fetchSpy.mockRestore();
    expect(result.metadata.llmsTxt).toContain("LLMs");
    const subdomainLlmsCalls = urls.filter(
      (u) =>
        (u.includes("docs.example.com") || u.includes("developers.example.com") || u.includes("developer.example.com")) &&
        u.includes("llms.txt"),
    );
    expect(subdomainLlmsCalls).toHaveLength(0);
  });

  it("canonical <host>/llms.txt 404 → docs.<host>/llms.txt 200 → metadata.llmsTxt set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://example.com/") {
        return new Response("<html><body>homepage</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (u === "https://docs.example.com/llms.txt") {
        return new Response("# Docs LLMs\nModel: claude-3", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("", { status: 404 });
    });
    const result = await crawlSite("https://example.com/", BASE_AUDIT_OPTIONS);
    fetchSpy.mockRestore();
    expect(result.metadata.llmsTxt).toContain("Docs LLMs");
  });
});

// --- A5: probeUrl one-retry with 2s back-off ---
const portalCheck = agentAuthChecks.find((c) => c.id === "developer-portal")!;
const A5_BIG_CONTENT = "Welcome to the developer API " + "x".repeat(1000);
// Fresh page array per call to avoid portalCache WeakMap hits across tests.
function a5Page() {
  return [{ url: "https://example.com/", status: 200, html: "<html></html>", headers: {}, responseTime: 100 }];
}
const A5_META = { baseUrl: "https://example.com", wellKnown: {} };

describe("probeUrl retry behaviour (A5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("network error on attempt 1, 200 on attempt 2 → pass (≥2 fetch calls)", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://example.com/api") {
        callCount++;
        if (callCount === 1) throw new Error("ECONNRESET");
        return new Response(`<html><body>${A5_BIG_CONTENT}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    });

    const resultPromise = portalCheck.run(a5Page(), A5_META);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("pass");
  });

  it("503 on attempt 1, 200 on attempt 2 → pass (≥2 fetch calls)", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://example.com/api") {
        callCount++;
        if (callCount === 1) {
          return new Response("", { status: 503, headers: { "content-type": "text/plain" } });
        }
        return new Response(`<html><body>${A5_BIG_CONTENT}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    });

    const resultPromise = portalCheck.run(a5Page(), A5_META);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("pass");
  });

  it("503 on both attempts → developer-portal fails (all canonical/subdomain paths give up)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("", { status: 503, headers: { "content-type": "text/plain" } });
    });

    const resultPromise = portalCheck.run(a5Page(), A5_META);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("fail");
  });

  it("404 is NOT retried — exactly 1 fetch call for /api path", async () => {
    let apiCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://example.com/api") {
        apiCallCount++;
        return new Response("", { status: 404 });
      }
      return new Response("", { status: 404 });
    });

    const resultPromise = portalCheck.run(a5Page(), A5_META);
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(apiCallCount).toBe(1);
  });

  it("200 is NOT retried — exactly 1 fetch call for /api path", async () => {
    let apiCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://example.com/api") {
        apiCallCount++;
        return new Response(`<html><body>${A5_BIG_CONTENT}</body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    });

    const resultPromise = portalCheck.run(a5Page(), A5_META);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(apiCallCount).toBe(1);
    expect(result.status).toBe("pass");
  });
});

// --- A2: crawler sitemap fallback when link-starvation occurs ---
const SPA_SHELL_HTML = "<html><body><div id='__next'></div></body></html>";
const CONTENT_PAGE_HTML = "<html><body><main><h1>Product</h1>" + "word ".repeat(300) + "</main></body></html>";
// Sitemap with www. prefix — parseSitemapWithMetadata (exact origin) will skip these,
// but fillFromSitemap (subdomain-aware) will pick them up, triggering the fallback.
function makeSitemapXml(host: string, count: number): string {
  const locs = Array.from({ length: count }, (_, i) => `<url><loc>https://${host}/page${i + 1}</loc></url>`).join("\n");
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs}\n</urlset>`;
}

describe("crawler sitemap fallback (A2)", () => {
  it("triggers when homepage has no internal links and sitemap has 5 URLs", async () => {
    // Sitemap uses www.spa.example.com — exact-origin parse skips them, fallback picks them up
    const sitemapXml = makeSitemapXml("www.spa.example.com", 5);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://spa.example.com/") {
        return new Response(SPA_SHELL_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (u === "https://spa.example.com/sitemap.xml") {
        return new Response(sitemapXml, { status: 200, headers: { "content-type": "application/xml" } });
      }
      if (u.startsWith("https://www.spa.example.com/page")) {
        return new Response(CONTENT_PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("", { status: 404 });
    });

    const out = await crawlSite("https://spa.example.com/", {
      maxPages: 6,
      timeout: 5000,
      requestDelay: 0,
      concurrency: 1,
      userAgent: "test-agent",
      verbose: false,
    });
    fetchSpy.mockRestore();

    expect(out.pages.length).toBeGreaterThanOrEqual(3);
  });

  it("no-op when homepage has many internal links (pages.length >= 3 after main loop)", async () => {
    const homepageHtml = `<html><body>
      <a href="/about">About</a>
      <a href="/pricing">Pricing</a>
      <a href="/docs">Docs</a>
      <a href="/blog">Blog</a>
      <a href="/contact">Contact</a>
    </body></html>`;
    const sitemapXml = makeSitemapXml("www.example.com", 5);
    const fetchedUrls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      fetchedUrls.push(u);
      if (u === "https://example.com/") {
        return new Response(homepageHtml, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (u === "https://example.com/sitemap.xml") {
        return new Response(sitemapXml, { status: 200, headers: { "content-type": "application/xml" } });
      }
      if (u.startsWith("https://example.com/")) {
        return new Response(CONTENT_PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("", { status: 404 });
    });

    await crawlSite("https://example.com/", {
      maxPages: 6,
      timeout: 5000,
      requestDelay: 0,
      concurrency: 1,
      userAgent: "test-agent",
      verbose: false,
    });
    fetchSpy.mockRestore();

    // Sitemap-only URLs (www.example.com) should never be fetched — fallback not triggered
    const sitemapOnlyCalls = fetchedUrls.filter((u) => u.startsWith("https://www.example.com/page"));
    expect(sitemapOnlyCalls).toHaveLength(0);
  });

  it("no-op when no sitemap (sitemap.xml is 404)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://spa.example.com/") {
        return new Response(SPA_SHELL_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("", { status: 404 });
    });

    const out = await crawlSite("https://spa.example.com/", {
      maxPages: 6,
      timeout: 5000,
      requestDelay: 0,
      concurrency: 1,
      userAgent: "test-agent",
      verbose: false,
    });
    fetchSpy.mockRestore();

    expect(out.pages.length).toBe(1);
  });

  it("parses CDATA-wrapped <loc> URLs from sitemap (WordPress-style)", async () => {
    const cdataSitemap = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc><![CDATA[https://spa.example.com/article-cdata]]></loc></url>
    </urlset>`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://spa.example.com/" || u === "https://spa.example.com")
        return new Response('<html><body><div id="__next"></div></body></html>',
          { status: 200, headers: { "content-type": "text/html" } });
      if (u.endsWith("/sitemap.xml"))
        return new Response(cdataSitemap, { status: 200, headers: { "content-type": "application/xml" } });
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u === "https://spa.example.com/article-cdata")
        return new Response("<html><body><h1>article</h1>" + "x".repeat(2000) + "</body></html>",
          { status: 200, headers: { "content-type": "text/html" } });
      return new Response("", { status: 404 });
    });
    const out = await crawlSite("https://spa.example.com/", { maxPages: 6, timeout: 5000, verbose: false, userAgent: "test" });
    fetchSpy.mockRestore();
    // The CDATA-wrapped URL should have been fetched as part of the fallback.
    expect(out.pages.some((p) => p.url === "https://spa.example.com/article-cdata")).toBe(true);
  });

  it("respects maxPages cap during fallback", async () => {
    const sitemapXml = makeSitemapXml("www.spa.example.com", 5);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://spa.example.com/") {
        return new Response(SPA_SHELL_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (u === "https://spa.example.com/sitemap.xml") {
        return new Response(sitemapXml, { status: 200, headers: { "content-type": "application/xml" } });
      }
      if (u.startsWith("https://www.spa.example.com/page")) {
        return new Response(CONTENT_PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("", { status: 404 });
    });

    const out = await crawlSite("https://spa.example.com/", {
      maxPages: 2,
      timeout: 5000,
      requestDelay: 0,
      concurrency: 1,
      userAgent: "test-agent",
      verbose: false,
    });
    fetchSpy.mockRestore();

    // homepage (1) + 1 from sitemap fallback = 2
    expect(out.pages.length).toBe(2);
  });
});

// Body-cancel on 5xx retry path is verified by code inspection in agent-auth.ts —
// driving it through a unit test requires patching native Response.body in a way
// that fights with vitest's fake-timers + the chunked-body-read code path.
// The behavior is a one-line `await res.body?.cancel()` on the retry branch.

// --- A1: no-js-dependency SPA shell detection ---
import { noJsDependency } from "../src/audit/checks/technical.js";

function makeJsPage(html: string, url = "https://example.com/"): FetchedPage {
  return { url, status: 200, html, headers: {}, responseTime: 100 };
}

describe("no-js-dependency SPA detection (A1)", () => {
  // This page has 55+ words from nav/meta text so it PASSES word-count alone,
  // but the SPA shell signals (root mount + 0 anchors + script >> body text) must catch it.
  it("SPA shell with __next root marker, 0 anchors, lots of script → fail even when word count clears 50", () => {
    const navWords = "Home About Pricing Contact Blog Support Docs Sign in Get started Try now Demo Features Enterprise ".repeat(5);
    const html = `<html>
  <head><title>OpenAI</title><meta name="description" content="${"great platform ".repeat(5)}"/></head>
  <body>
    <div id="__next"></div>
    <p>${navWords}</p>
    <script>const data = "${"x".repeat(5000)}";</script>
  </body>
</html>`;
    const result = noJsDependency.run([makeJsPage(html)]);
    expect(result.status).toBe("fail");
    expect(result.score).toBe(0);
  });

  it("real article page with substantial body text and root marker → pass (5 anchors + high word count)", () => {
    const html = `<html><body><div id="root"></div><h1>Article Title</h1>${"<p>" + "Lorem ipsum dolor sit amet ".repeat(100) + "</p>"}<a href="/x">link 1</a><a href="/y">link 2</a><a href="/z">link 3</a><a href="/q">link 4</a><a href="/r">link 5</a></body></html>`;
    const result = noJsDependency.run([makeJsPage(html)]);
    expect(result.status).toBe("pass");
  });

  it("no root marker, low word count → word-count fail (regression)", () => {
    const html = `<html><body>short page</body></html>`;
    const result = noJsDependency.run([makeJsPage(html)]);
    expect(result.status).toBe("fail");
  });

  it("no root marker, high word count → pass (regression)", () => {
    const html = `<html><body>${"long content ".repeat(50)}</body></html>`;
    const result = noJsDependency.run([makeJsPage(html)]);
    expect(result.status).toBe("pass");
  });
});

// --- A4 polish: www. stripping + sequential subdomain probing ---
// Fresh page array per call to avoid portalCache WeakMap hits across tests.
function a4polishPage(host = "example.com") {
  return [{ url: `https://${host}/`, status: 200, html: "<html></html>", headers: {}, responseTime: 100 }];
}
const PORTAL_BIG = "Welcome to the API docs " + "x".repeat(1000);

describe("A4 polish: www. stripping and sequential subdomain probing", () => {
  it("www. is stripped before subdomain probe — probes docs.example.com not docs.www.example.com", async () => {
    const probedUrls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      probedUrls.push(String(url));
      return new Response("", { status: 404 });
    });
    await developerPortal.run(
      a4polishPage("www.example.com"),
      { baseUrl: "https://www.example.com", wellKnown: {} },
    );
    fetchSpy.mockRestore();
    const subdomainCalls = probedUrls.filter((u) => u.startsWith("https://docs.") || u.startsWith("https://developers.") || u.startsWith("https://developer."));
    expect(subdomainCalls.some((u) => u.includes("docs.www.example.com"))).toBe(false);
    expect(subdomainCalls.some((u) => u === "https://docs.example.com/")).toBe(true);
  });

  it("stripWww is a no-op on apex domain — probes docs.example.com correctly", async () => {
    const probedUrls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      probedUrls.push(String(url));
      return new Response("", { status: 404 });
    });
    await developerPortal.run(
      a4polishPage("example.com"),
      { baseUrl: "https://example.com", wellKnown: {} },
    );
    fetchSpy.mockRestore();
    const subdomainCalls = probedUrls.filter((u) => u.startsWith("https://docs.") || u.startsWith("https://developers.") || u.startsWith("https://developer."));
    expect(subdomainCalls.some((u) => u === "https://docs.example.com/")).toBe(true);
  });

  it("sequential subdomain probing stops on first hit — developers and developer not called after docs 200", async () => {
    const probedUrls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      probedUrls.push(u);
      if (u === "https://docs.example.com/") {
        return new Response(`<html><body>${PORTAL_BIG}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("", { status: 404 });
    });
    const result = await developerPortal.run(
      a4polishPage(),
      { baseUrl: "https://example.com", wellKnown: {} },
    );
    fetchSpy.mockRestore();
    expect(result.status).toBe("pass");
    expect(probedUrls.some((u) => u === "https://developers.example.com/")).toBe(false);
    expect(probedUrls.some((u) => u === "https://developer.example.com/")).toBe(false);
  });
});

describe("ai-plugin.json well-known probe (D2a)", () => {
  const meta: SiteMetadata = { baseUrl: "https://example.com", wellKnown: {} };
  const page: FetchedPage = { url: "https://example.com", status: 200, html: "<html></html>", headers: {}, responseTime: 100 };

  it("200 + valid manifest with schema_version → pass", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://example.com/.well-known/ai-plugin.json") {
        return new Response(
          JSON.stringify({
            schema_version: "v1",
            name_for_model: "example",
            name_for_human: "Example",
            description_for_model: "An example plugin",
            api: { type: "openapi", url: "https://example.com/openapi.yaml" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    });
    const result = await wellKnownAiPlugin.run([page], meta);
    fetchSpy.mockRestore();
    expect(result.status).toBe("pass");
  });

  it("200 + JSON missing schema_version → partial", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://example.com/.well-known/ai-plugin.json") {
        return new Response(JSON.stringify({ name: "thing" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    });
    const result = await wellKnownAiPlugin.run([page], meta);
    fetchSpy.mockRestore();
    expect(result.status).toBe("partial");
  });

  it("200 + invalid JSON → partial", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://example.com/.well-known/ai-plugin.json") {
        return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 404 });
    });
    const result = await wellKnownAiPlugin.run([page], meta);
    fetchSpy.mockRestore();
    expect(result.status).toBe("partial");
  });

  it("404 → fail", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("", { status: 404 });
    });
    const result = await wellKnownAiPlugin.run([page], meta);
    fetchSpy.mockRestore();
    expect(result.status).toBe("fail");
  });
});

describe("multi-UA simulation (D1)", () => {
  const page = makePage("<html><body>content</body></html>", "https://example.com/");

  // Test 1: pass when reachable + expectations met
  it("sim-claude passes when reachable and llmsTxt present", async () => {
    const meta: SiteMetadata = {
      ...makeMeta("https://example.com"),
      llmsTxt: "# llms.txt\n",
      multiUaResponses: {
        claude: { status: 200, contentLength: 5000, finalUrl: "https://example.com/", reachable: true },
      },
    };
    const result = await simClaude.run([page], meta);
    expect(result.status).toBe("pass");
    expect(result.score).toBe(100);
  });

  // Test 2: fail when UA can't reach
  it("sim-claude fails when claude UA is blocked (reachable=false)", async () => {
    const meta: SiteMetadata = {
      ...makeMeta("https://example.com"),
      multiUaResponses: {
        claude: { status: 403, contentLength: 0, finalUrl: "https://example.com/", reachable: false },
      },
    };
    const result = await simClaude.run([page], meta);
    expect(result.status).toBe("fail");
    expect(result.score).toBe(0);
  });

  // Test 3: partial when reachable but expectations missing
  it("sim-claude returns partial when reachable but no llmsTxt/openapi/mcpInit", async () => {
    const meta: SiteMetadata = {
      ...makeMeta("https://example.com"),
      multiUaResponses: {
        claude: { status: 200, contentLength: 5000, finalUrl: "https://example.com/", reachable: true },
      },
    };
    const result = await simClaude.run([page], meta);
    expect(result.status).toBe("partial");
    expect(result.score).toBe(50);
  });

  // Test 4: skip when no multiUaResponses key for that UA
  it("sim-claude skips when multiUaResponses has no claude key", async () => {
    const meta: SiteMetadata = {
      ...makeMeta("https://example.com"),
      multiUaResponses: {},
    };
    const result = await simClaude.run([page], meta);
    expect(result.status).toBe("skip");
  });

  // Test 4b: skip when multiUaResponses is absent entirely
  it("sim-claude skips when multiUaResponses is undefined", async () => {
    const meta: SiteMetadata = makeMeta("https://example.com");
    const result = await simClaude.run([page], meta);
    expect(result.status).toBe("skip");
  });

  // Test 5: fetchUnderUas populates all 5 keys
  it("fetchUnderUas populates all 5 UA keys with varied results", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const ua = (init?.headers as Record<string, string>)?.["User-Agent"] ?? "";
      if (ua.includes("ClaudeBot")) {
        return new Response("<html>allowed</html>", { status: 200 });
      }
      if (ua.includes("ChatGPT")) {
        return new Response("<html>allowed</html>", { status: 200 });
      }
      if (ua.includes("Google-Extended")) {
        return new Response("", { status: 403 });
      }
      if (ua.includes("PerplexityBot")) {
        return new Response("<html>long content here for perplexity bot testing purposes to exceed threshold</html>", {
          status: 200,
        });
      }
      if (ua.includes("DeepSeekBot")) {
        return new Response("<html>ok</html>", { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const result = await fetchUnderUas("https://example.com/", { timeout: 5000 } as import("../src/audit/types.js").AuditOptions);
    fetchSpy.mockRestore();

    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(["claude", "chatgpt", "gemini", "perplexity", "deepseek"]),
    );
    expect(result.claude.reachable).toBe(true);
    expect(result.gemini.reachable).toBe(false);
    expect(result.gemini.status).toBe(403);
  });
});
