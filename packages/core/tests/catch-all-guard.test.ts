import { afterEach, describe, expect, it, vi } from "vitest";
import { allChecks } from "../src/audit/checks/index.js";
import { probeSiteMetadata } from "../src/audit/crawler.js";
import { runAudit } from "../src/audit/engine.js";
import type { AuditOptions, AuditReport, Check, CheckResult } from "../src/audit/types.js";
import { DEFAULT_OPTIONS } from "../src/audit/types.js";

const SITE = "https://example.com";
const OPTIONS: Partial<AuditOptions> = { maxPages: 1, requestDelay: 0, timeout: 1000 };
const SPA_SHELL =
  '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

const WELL_KNOWN_CHECK_IDS = [
  "well-known-agent-card",
  "well-known-agents-json",
  "well-known-ara",
  "well-known-ai-plugin",
  "well-known-ucp",
  "mcp-discovery",
  "oauth-support",
  "oauth-protected-resource",
  "api-catalog-rfc9727",
  "web-bot-auth-directory",
  "mcp-server-card",
  "llms-txt-exists",
  "robots-txt-exists",
];

type Route = (url: URL) => Response;

function mockSite(route: Route) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const raw = input instanceof Request ? input.url : String(input);
    return route(new URL(raw));
  });
}

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function checksById(report: AuditReport): Map<string, CheckResult> {
  return new Map(report.categories.flatMap((c) => c.checks).map((r) => [r.id, r]));
}

const metaOptions = { ...DEFAULT_OPTIONS, ...OPTIONS };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("catch-all / soft-404 guard", () => {
  it("an SPA answering 200 text/html for every path passes zero well-known checks", async () => {
    mockSite(() => html(SPA_SHELL));

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    expect(Object.values(metadata.wellKnown).filter(Boolean)).toEqual([]);
    expect(metadata.robotsTxt).toBeUndefined();
    expect(metadata.llmsTxt).toBeUndefined();

    const report = await runAudit(SITE, OPTIONS, undefined, allChecks);
    const byId = checksById(report);
    for (const id of WELL_KNOWN_CHECK_IDS) {
      const r = byId.get(id);
      expect(r, id).toBeDefined();
      expect({ id, status: r?.status, score: r?.score }).toMatchObject({ id, score: 0 });
      expect(["fail", "skip"], id).toContain(r?.status);
    }

    const warning = report.warnings.find((w) => w.id === "catch-all-responses");
    expect(warning).toBeDefined();
    expect(warning?.message).toMatch(/do not exist|non-existent/i);
  });

  it("well-known files not served with a JSON content-type are not counted, even when bodies differ per path", async () => {
    mockSite((url) => {
      if (url.pathname === "/.well-known/agent-card.json") {
        return new Response('{"name":"Example"}', { headers: { "content-type": "text/plain" } });
      }
      return html(`<p>No page at ${url.pathname}</p>`);
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    expect(Object.values(metadata.wellKnown).filter(Boolean)).toEqual([]);
  });

  it("a site that 404s unknown paths and serves real JSON well-known files keeps its passes", async () => {
    mockSite((url) => {
      switch (url.pathname) {
        case "/":
          return html(SPA_SHELL);
        case "/api/":
          return json({ ok: true });
        case "/.well-known/agent-card.json":
          return json({ name: "Example", url: SITE });
        case "/.well-known/oauth-protected-resource":
          return json({ resource: SITE, authorization_servers: [SITE] });
        default:
          return html("<h1>Not found</h1>", 404);
      }
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(false);

    const report = await runAudit(SITE, OPTIONS, undefined, allChecks);
    const byId = checksById(report);
    expect(byId.get("well-known-agent-card")).toMatchObject({ status: "pass", score: 100 });
    expect(byId.get("oauth-protected-resource")).toMatchObject({ status: "pass", score: 100 });
    expect(report.warnings.find((w) => w.id === "catch-all-responses")).toBeUndefined();
  });

  it("a JSON catch-all does not count well-known bodies identical to its soft-404 body", async () => {
    const realPrm = { resource: SITE, authorization_servers: [SITE] };
    mockSite((url) => {
      if (url.pathname === "/.well-known/oauth-protected-resource") return json(realPrm);
      return json({});
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.catchAll).toBe(true);
    expect(metadata.wellKnown["agent-card.json"]).toBeUndefined();
    expect(metadata.wellKnown.ucp).toBeUndefined();
    expect(metadata.wellKnown.mcp).toBeUndefined();
    expect(metadata.wellKnown["oauth-authorization-server"]).toBeUndefined();
    expect(metadata.wellKnown["oauth-protected-resource"]).toBe(JSON.stringify(realPrm));

    const report = await runAudit(SITE, OPTIONS, undefined, allChecks);
    const byId = checksById(report);
    for (const id of [
      "well-known-agent-card",
      "well-known-ucp",
      "mcp-discovery",
      "oauth-support",
    ]) {
      expect(byId.get(id)?.score, id).toBe(0);
    }
    expect(report.warnings.some((w) => w.id === "catch-all-responses")).toBe(true);
  });

  it("robots.txt and llms.txt served as HTML are absent; the llms.txt subdomain fallback still runs", async () => {
    mockSite((url) => {
      if (url.hostname === "docs.example.com" && url.pathname === "/llms.txt") {
        return new Response("# Docs\n", { headers: { "content-type": "text/markdown" } });
      }
      if (url.pathname === "/robots.txt" || url.pathname === "/llms.txt") return html(SPA_SHELL);
      return html("nope", 404);
    });

    const metadata = await probeSiteMetadata(SITE, metaOptions);
    expect(metadata.robotsTxt).toBeUndefined();
    expect(metadata.llmsTxt).toBe("# Docs\n");
  });
});

describe("well-known checks that probe directly reject non-JSON and non-object bodies", () => {
  const byId = (id: string) => allChecks.find((c) => c.id === id) as Check;
  const meta = { baseUrl: SITE, wellKnown: {} };

  it.each([
    "web-bot-auth-directory",
    "api-catalog-rfc9727",
    "mcp-server-card",
  ])("%s fails on a 2xx HTML page and on a JSON array", async (id) => {
    mockSite(() => html(SPA_SHELL));
    expect(await byId(id).run([], meta)).toMatchObject({ status: "fail", score: 0 });
    vi.restoreAllMocks();
    mockSite(() => json([1, 2]));
    expect(await byId(id).run([], meta)).toMatchObject({ status: "fail", score: 0 });
  });
});
