import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { FetchedPage, SiteMetadata } from "../src/audit/types.js";
import { agentAuthChecks } from "../src/audit/checks/agent-auth.js";
import { crawlSite } from "../src/audit/crawler.js";

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
