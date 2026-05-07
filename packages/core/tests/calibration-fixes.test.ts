import { describe, expect, it, vi } from "vitest";
import type { FetchedPage, SiteMetadata } from "../src/audit/types.js";
import { agentAuthChecks } from "../src/audit/checks/agent-auth.js";

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
