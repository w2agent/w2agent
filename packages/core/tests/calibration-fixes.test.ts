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
});
