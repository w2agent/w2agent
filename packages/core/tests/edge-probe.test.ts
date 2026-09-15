import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crawlSite, fetchUnderUas, probeSiteMetadata } from "../src/audit/crawler.js";
import { BOT_TOKENS } from "../src/audit/shared/bot-tokens.js";
import {
  AUDIT_CRAWL_PROFILE,
  type AuditOptions,
  DEFAULT_OPTIONS,
  type MultiUaResponse,
} from "../src/audit/types.js";

const SITE = "https://site.test";
const HOME = `${SITE}/`;
const OPTIONS: AuditOptions = { ...DEFAULT_OPTIONS, ...AUDIT_CRAWL_PROFILE, requestDelay: 0 };
const MAIN_UA = OPTIONS.userAgent;

const uaOf = (token: string) => BOT_TOKENS.find((b) => b.token === token)?.uaString ?? "";
const OPENAI_UA = uaOf("ChatGPT-User");

// /p1 and /p2 carry priority 0.9, /p3 carries 0.1 — so the crawl's own
// selection puts /p1 and /p2 first, and the edge probe must take exactly those.
const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>${HOME}</loc></url><url><loc>${SITE}/p1</loc><priority>0.9</priority></url><url><loc>${SITE}/p2</loc><priority>0.9</priority></url><url><loc>${SITE}/p3</loc><priority>0.1</priority></url></urlset>`;
const HOME_HTML = "<html><head><title>Home</title></head><body><p>hello</p></body></html>";

type Call = { url: string; method: string; ua: string };
let calls: Call[] = [];
let fetchMock: ReturnType<typeof vi.spyOn> | undefined;

type Route = (ua: string, method: string) => Response;
let routes: Record<string, Route>;

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

function install() {
  fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const ua = (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? "";
    calls.push({ url, method, ua });
    const route = routes[new URL(url).pathname];
    if (route) return route(ua, method);
    return new Response("", { status: 404 });
  });
}

beforeEach(() => {
  calls = [];
  routes = {
    "/": () => html(HOME_HTML),
    "/robots.txt": () => new Response("User-agent: *\nAllow: /", { status: 200 }),
    "/sitemap.xml": () => new Response(SITEMAP, { status: 200 }),
    "/p1": () => html("<html><body>p1</body></html>"),
    "/p2": () => html("<html><body>p2</body></html>"),
    "/p3": () => html("<html><body>p3</body></html>"),
  };
  install();
});

afterEach(() => {
  fetchMock?.mockRestore();
});

const REACH_KEYS = ["openai", "perplexity", "google"] as const;

/**
 * The exact surface `checks/reach.ts` reads. Pinned so the edge-probe work
 * cannot move a reach-* verdict: every new field is additive.
 */
function reachView(r: MultiUaResponse) {
  const { status, contentLength, finalUrl, reachable, outcome } = r;
  return { status, contentLength, finalUrl, reachable, outcome };
}

function reachViews(responses: Record<string, MultiUaResponse>) {
  return REACH_KEYS.map((k) => reachView(responses[k]));
}

describe("reach-* byte identity across the extended multi-UA pass", () => {
  it("pins the reach surface on an all-200 site", async () => {
    const metadata = await probeSiteMetadata(HOME, OPTIONS);
    const ok = {
      status: 200,
      contentLength: HOME_HTML.length,
      finalUrl: "",
      reachable: true,
      outcome: "ok",
    };
    expect(reachViews(metadata.multiUaResponses ?? {})).toEqual([ok, ok, ok]);
  });

  it("pins the reach surface on a 403 / empty-200 / 200 mix", async () => {
    routes["/"] = (ua) => {
      if (ua.includes("ChatGPT-User")) return html("<html>blocked</html>", 403);
      if (ua.includes("Perplexity-User")) return html("");
      return html(HOME_HTML);
    };
    const { responses } = await fetchUnderUas(HOME, OPTIONS);
    expect(reachViews(responses)).toEqual([
      {
        status: 403,
        contentLength: "<html>blocked</html>".length,
        finalUrl: "",
        reachable: false,
        outcome: "ok",
      },
      { status: 200, contentLength: 0, finalUrl: "", reachable: false, outcome: "ok" },
      {
        status: 200,
        contentLength: HOME_HTML.length,
        finalUrl: "",
        reachable: true,
        outcome: "ok",
      },
    ]);
  });

  it("pins the reach surface on a timeout and on a fetch error", async () => {
    fetchMock?.mockImplementation(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const timedOut = await fetchUnderUas(HOME, OPTIONS);
    const timeoutRow = {
      status: 0,
      contentLength: 0,
      finalUrl: HOME,
      reachable: false,
      outcome: "timeout",
    };
    expect(reachViews(timedOut.responses)).toEqual([timeoutRow, timeoutRow, timeoutRow]);

    fetchMock?.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    const errored = await fetchUnderUas(HOME, OPTIONS);
    const errorRow = { ...timeoutRow, outcome: "fetch-error" };
    expect(reachViews(errored.responses)).toEqual([errorRow, errorRow, errorRow]);
  });
});

describe("a body-read error keeps its evidence without moving the reach surface", () => {
  const CF = "/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1";

  function brokenStream(head: string, status: number, headers: Record<string, string>): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(head));
          controller.error(new Error("stream broke"));
        },
      }),
      { status, headers: { "content-type": "text/html", ...headers } },
    );
  }

  it("pins the reach projection at 0/0/url/false/fetch-error while retaining the challenge", async () => {
    routes["/"] = (ua) =>
      ua === MAIN_UA
        ? html(HOME_HTML)
        : brokenStream(`<html><script>${CF}</script>`, 403, {
            "cf-mitigated": "challenge",
            server: "cloudflare",
          });

    const { responses } = await fetchUnderUas(HOME, OPTIONS);

    // THE HARD CONSTRAINT: reach-* sees exactly what it saw before this fix.
    expect(reachView(responses.openai)).toEqual({
      status: 0,
      contentLength: 0,
      finalUrl: HOME,
      reachable: false,
      outcome: "fetch-error",
    });
    // The evidence lives in edge-only fields.
    expect(responses.openai.observedStatus).toBe(403);
    expect(responses.openai.challenge).toEqual({
      vendor: "cloudflare",
      signal: "cf-mitigated: challenge",
    });
    expect(responses.openai.headers).toEqual({ cfMitigated: "challenge", server: "cloudflare" });
  });

  it("records no observedStatus when the request never produced a response", async () => {
    fetchMock?.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    const { responses } = await fetchUnderUas(HOME, OPTIONS);
    expect(responses.openai.observedStatus).toBeUndefined();
    expect(responses.openai.headers).toEqual({});
  });
});

describe("politeness pacing of the fetches the probe adds", () => {
  it("delays the controls and the extra-page agent fetches, not the homepage agent loop", async () => {
    const paced: AuditOptions = { ...OPTIONS, requestDelay: 60 };
    const stamps: { url: string; ua: string; at: number }[] = [];
    fetchMock?.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const ua = (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? "";
      stamps.push({ url, ua, at: Date.now() });
      const route = routes[new URL(url).pathname];
      return route ? route(ua, init?.method ?? "GET") : new Response("", { status: 404 });
    });

    await fetchUnderUas(HOME, paced, { extraPages: [`${SITE}/p1`] });

    const gap = (i: number) => stamps[i].at - stamps[i - 1].at;
    // stamps: 3 homepage agent fetches, homepage control, /p1 control, 3 /p1 agents.
    expect(stamps).toHaveLength(8);
    expect(gap(1)).toBeLessThan(50); // homepage agent loop: unpaced
    expect(gap(2)).toBeLessThan(50);
    for (const i of [3, 4, 5, 6, 7]) expect(gap(i)).toBeGreaterThanOrEqual(50);
  });
});

describe("edgeProbe shape", () => {
  it("puts the homepage first, carrying the crawler's own control status and the same result objects", async () => {
    const metadata = await probeSiteMetadata(HOME, OPTIONS);
    const homepageEntry = metadata.edgeProbe?.[0];

    expect(homepageEntry?.url).toBe(HOME);
    expect(homepageEntry?.control).toMatchObject({ token: "control", status: 200, outcome: "ok" });
    for (const [i, key] of REACH_KEYS.entries()) {
      expect(homepageEntry?.results[i]).toBe(metadata.multiUaResponses?.[key]);
    }
  });

  it("probes at most two extra pages, taken from the crawl's own selection", async () => {
    const metadata = await probeSiteMetadata(HOME, OPTIONS);

    expect(metadata.edgeProbe?.map((p) => p.url)).toEqual([HOME, `${SITE}/p1`, `${SITE}/p2`]);
    for (const entry of metadata.edgeProbe ?? []) {
      expect(entry.results.map((r) => r.token)).toEqual([
        "ChatGPT-User",
        "Perplexity-User",
        "Google-Agent",
      ]);
      expect(entry.results.every((r) => r.url === entry.url)).toBe(true);
    }
    expect(calls.some((c) => c.url === `${SITE}/p3`)).toBe(false);
  });

  it("invents no URL when the site offers no discoverable pages", async () => {
    routes["/sitemap.xml"] = () => new Response("", { status: 404 });
    const metadata = await probeSiteMetadata(HOME, OPTIONS);
    expect(metadata.edgeProbe?.map((p) => p.url)).toEqual([HOME]);
  });

  it("crawlSite and standalone probeSiteMetadata produce the same edgeProbe", async () => {
    const probed = await probeSiteMetadata(HOME, OPTIONS);
    const crawled = await crawlSite(HOME, OPTIONS);
    expect(crawled.metadata.edgeProbe).toEqual(probed.edgeProbe);
  });

  it("fetches its own homepage control even when only the HTML was handed in", async () => {
    const metadata = await probeSiteMetadata(HOME, OPTIONS, { homepageHtml: HOME_HTML });
    expect(metadata.edgeProbe?.[0].control).toMatchObject({ status: 200, outcome: "ok" });
  });
});

describe("control fetch (homepage included)", () => {
  it("is single-shot on the homepage: the crawl's retrying fetch never supplies the control", async () => {
    // The homepage control is a *second* fetch under MAIN_UA, issued after the
    // agent loop. Hit 1 is `fetchPage` (200, no retry); the control is hit 2 and
    // sees the 503. `fetchPage` as the control would retry into a 3rd hit.
    let mainUaHits = 0;
    routes["/"] = (ua) => {
      if (ua !== MAIN_UA) return html(HOME_HTML);
      mainUaHits++;
      return mainUaHits === 1 ? html(HOME_HTML) : html("<html>busy</html>", 503);
    };

    const metadata = await probeSiteMetadata(HOME, OPTIONS);

    expect(metadata.edgeProbe?.[0].control).toMatchObject({ status: 503, outcome: "ok" });
    expect(calls.filter((c) => c.url === HOME && c.ua === MAIN_UA)).toHaveLength(2);
  });

  it("runs the homepage control after the agent loop, so reach-* keeps its request order", async () => {
    await probeSiteMetadata(HOME, OPTIONS);
    const uas = calls.filter((c) => c.url === HOME).map((c) => c.ua);
    expect(uas).toEqual([
      MAIN_UA,
      OPENAI_UA,
      uaOf("Perplexity-User"),
      uaOf("Google-Agent"),
      MAIN_UA,
    ]);
  });

  it("is single-shot on an extra page: a 503 that a retry would have turned into a 200 stays 503", async () => {
    let mainUaHits = 0;
    routes["/p1"] = (ua) => {
      if (ua !== MAIN_UA) return html("<html>p1</html>");
      mainUaHits++;
      return mainUaHits === 1 ? html("<html>busy</html>", 503) : html("<html>p1</html>");
    };

    const metadata = await probeSiteMetadata(HOME, OPTIONS);
    const p1 = metadata.edgeProbe?.find((p) => p.url === `${SITE}/p1`);

    expect(p1?.control).toMatchObject({ status: 503, outcome: "ok" });
    expect(calls.filter((c) => c.url === `${SITE}/p1` && c.ua === MAIN_UA)).toHaveLength(1);
  });

  it("records the failure and skips the agent fetches when the control throws", async () => {
    routes["/p1"] = (ua) => {
      if (ua === MAIN_UA) throw new TypeError("refused");
      return html("<html>p1</html>");
    };
    const metadata = await probeSiteMetadata(HOME, OPTIONS);
    const p1 = metadata.edgeProbe?.find((p) => p.url === `${SITE}/p1`);
    expect(p1?.control).toMatchObject({ status: 0, outcome: "fetch-error" });
    expect(p1?.results).toEqual([]);
    expect(calls.filter((c) => c.url === `${SITE}/p1`)).toHaveLength(1);
  });

  it("skips the agent fetches when the control itself was challenged", async () => {
    routes["/p1"] = () =>
      html("<html>p1</html>", 200, { "cf-mitigated": "challenge", server: "cloudflare" });
    const metadata = await probeSiteMetadata(HOME, OPTIONS);
    const p1 = metadata.edgeProbe?.find((p) => p.url === `${SITE}/p1`);
    expect(p1?.control.challenge).toEqual({
      vendor: "cloudflare",
      signal: "cf-mitigated: challenge",
    });
    expect(p1?.results).toEqual([]);
    expect(calls.filter((c) => c.url === `${SITE}/p1`)).toHaveLength(1);
  });
});

describe("shared time budget", () => {
  it("budget-skips the extra pages without fetching them once the budget is gone", async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const before = calls.length;
    fetchMock?.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        method: init?.method ?? "GET",
        ua: (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? "",
      });
      now += 20_000;
      return html("<html>ok</html>");
    });

    const { responses, edgeProbe } = await fetchUnderUas(HOME, OPTIONS, {
      extraPages: [`${SITE}/p1`, `${SITE}/p2`],
    });
    nowSpy.mockRestore();

    // One agent fetch, then the homepage control — which is deliberately NOT
    // budget-gated, so a homepage that burned the budget is still explained.
    expect(calls.slice(before)).toHaveLength(2);
    expect(calls.slice(before).map((c) => c.ua)).toEqual([OPENAI_UA, MAIN_UA]);
    expect(responses.openai.outcome).toBe("ok");
    expect(responses.perplexity.outcome).toBe("budget-skipped");
    expect(edgeProbe[0].control.outcome).toBe("ok");

    const extras = edgeProbe.slice(1);
    expect(extras.map((e) => e.control.outcome)).toEqual(["budget-skipped", "budget-skipped"]);
    for (const entry of extras) {
      expect(entry.results.map((r) => r.outcome)).toEqual([
        "budget-skipped",
        "budget-skipped",
        "budget-skipped",
      ]);
    }
  });
});

describe("challenge and header evidence", () => {
  const CF_MARKER = "/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1";

  it("records the challenge, vendor and edge headers of an agent-UA block", async () => {
    routes["/"] = (ua) =>
      ua === MAIN_UA
        ? html(HOME_HTML)
        : html(`<html><script>${CF_MARKER}</script></html>`, 403, {
            "cf-mitigated": "challenge",
            server: "cloudflare",
            "retry-after": "30",
          });

    const { responses } = await fetchUnderUas(HOME, OPTIONS);
    expect(responses.openai.challenge).toEqual({
      vendor: "cloudflare",
      signal: "cf-mitigated: challenge",
    });
    expect(responses.openai.headers).toEqual({
      cfMitigated: "challenge",
      server: "cloudflare",
      retryAfter: "30",
    });
  });

  it("carries no challenge and no headers the response did not send", async () => {
    const { responses } = await fetchUnderUas(HOME, OPTIONS);
    expect(responses.openai.challenge).toBeUndefined();
    expect(responses.openai.headers).toEqual({});
  });

  it("fingerprints a body marker inside the 4 KB prefix but not one beyond it", async () => {
    const near = `<html>${CF_MARKER}${"x".repeat(200)}</html>`;
    routes["/"] = (ua) => (ua === MAIN_UA ? html(HOME_HTML) : html(near, 403));
    const inPrefix = await fetchUnderUas(HOME, OPTIONS);
    expect(inPrefix.responses.openai.challenge).toEqual({
      vendor: "cloudflare",
      signal: `body: ${CF_MARKER.slice(0, "/cdn-cgi/challenge-platform/h/".length)}`,
    });

    const far = `<html>${"x".repeat(5000)}${CF_MARKER}</html>`;
    routes["/"] = (ua) => (ua === MAIN_UA ? html(HOME_HTML) : html(far, 403));
    const beyondPrefix = await fetchUnderUas(HOME, OPTIONS);
    expect(beyondPrefix.responses.openai.challenge).toBeUndefined();
    expect(beyondPrefix.responses.openai.contentLength).toBe(far.length);
  });

  it("reads the prefix across chunk boundaries without truncating the body count", async () => {
    const marker = CF_MARKER;
    const body = `<html>${"y".repeat(3000)}${marker}${"z".repeat(70_000)}</html>`;
    routes["/"] = (ua) =>
      ua === MAIN_UA
        ? html(HOME_HTML)
        : new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const bytes = new TextEncoder().encode(body);
                for (let i = 0; i < bytes.length; i += 512) {
                  controller.enqueue(bytes.subarray(i, i + 512));
                }
                controller.close();
              },
            }),
            { status: 403, headers: { "content-type": "text/html" } },
          );

    const { responses } = await fetchUnderUas(HOME, OPTIONS);
    expect(responses.openai.challenge?.vendor).toBe("cloudflare");
    // 64 KB cap still governs contentLength.
    expect(responses.openai.contentLength).toBeGreaterThanOrEqual(64 * 1024);
    expect(responses.openai.contentLength).toBeLessThan(65 * 1024);
  });

  it("sends the documented agent UA strings on every probed page", async () => {
    await probeSiteMetadata(HOME, OPTIONS);
    const p1Uas = calls.filter((c) => c.url === `${SITE}/p1`).map((c) => c.ua);
    expect(p1Uas).toEqual([MAIN_UA, OPENAI_UA, uaOf("Perplexity-User"), uaOf("Google-Agent")]);
  });
});
