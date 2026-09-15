import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAudit } from "../src/audit/engine.js";
import { AuditError, classifyHomepage } from "../src/audit/errors.js";
import type { FetchedPage, SiteMetadata } from "../src/audit/types.js";
import { fetchPage } from "../src/shared/fetcher.js";

const URL_UNDER_TEST = "https://example.com";
const opts = { timeout: 5000, userAgent: "test" };

const CF_CHALLENGE_BODY =
  '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>';

function page(partial: Partial<FetchedPage>): FetchedPage {
  return {
    url: URL_UNDER_TEST,
    status: 200,
    html: "<html><body>ok</body></html>",
    headers: {},
    responseTime: 10,
    ...partial,
  };
}

function response(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

/** Sends one chunk, then fails the stream — a connection reset mid-body. */
function erroringBody(
  status: number,
  firstChunk: string,
  headers: Record<string, string> = {},
): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.error(new TypeError("terminated: ECONNRESET"));
      sent = true;
      controller.enqueue(new TextEncoder().encode(firstChunk));
    },
  });
  return new Response(body, { status, headers });
}

const metadata: SiteMetadata = { baseUrl: URL_UNDER_TEST, wellKnown: {} };

describe("classifyHomepage — responses the audit must refuse to score", () => {
  it("403 with a Cloudflare challenge body is blocked, with vendor and signal evidence", () => {
    const err = classifyHomepage(
      page({ status: 403, html: CF_CHALLENGE_BODY, headers: { "cf-ray": "abc" } }),
      URL_UNDER_TEST,
    );
    expect(err?.kind).toBe("blocked");
    expect(err?.evidence).toMatchObject({ status: 403, vendor: "cloudflare" });
    expect(err?.evidence.signal).toContain("/cdn-cgi/challenge-platform/");
    expect(err?.message).toBe(
      "example.com served an anti-bot challenge (Cloudflare) to w2agent's crawler. Allow the w2agent user-agent to audit it.",
    );
  });

  it("a cf-mitigated: challenge header is blocked at any status, including 200", () => {
    const err = classifyHomepage(
      page({ status: 200, headers: { "cf-mitigated": "challenge" } }),
      URL_UNDER_TEST,
    );
    expect(err?.kind).toBe("blocked");
    expect(err?.evidence).toMatchObject({ status: 200, signal: "cf-mitigated: challenge" });
  });

  it("an ambiguous 403 with no challenge markers is unknown_failure, not blocked", () => {
    const err = classifyHomepage(
      page({ status: 403, html: "<html><body>Forbidden</body></html>" }),
      URL_UNDER_TEST,
    );
    expect(err?.kind).toBe("unknown_failure");
    expect(err?.evidence).toEqual({ status: 403 });
    expect(err?.message).toContain("HTTP 403");
  });

  it("401 with WWW-Authenticate is auth_gated", () => {
    const err = classifyHomepage(
      page({ status: 401, headers: { "www-authenticate": 'Basic realm="staging"' } }),
      URL_UNDER_TEST,
    );
    expect(err?.kind).toBe("auth_gated");
    expect(err?.evidence).toEqual({ status: 401 });
  });

  it("401 without WWW-Authenticate is not auth_gated and does not stop the audit", () => {
    expect(classifyHomepage(page({ status: 401 }), URL_UNDER_TEST)).toBeNull();
  });

  it.each([200, 301, 404, 500, 502, 504])("status %i is scorable (no error)", (status) => {
    expect(classifyHomepage(page({ status }), URL_UNDER_TEST)).toBeNull();
  });

  it("a 429 handed in directly is rate_limited", () => {
    const err = classifyHomepage(page({ status: 429, html: "Too Many Requests" }), URL_UNDER_TEST);
    expect(err?.kind).toBe("rate_limited");
    expect(err?.evidence).toEqual({ status: 429 });
  });

  it("a 503 handed in directly is unknown_failure, not rate_limited", () => {
    const err = classifyHomepage(
      page({ status: 503, html: "Service Unavailable" }),
      URL_UNDER_TEST,
    );
    expect(err?.kind).toBe("unknown_failure");
    expect(err?.evidence).toEqual({ status: 503 });
  });

  it("a bare status-0 page with no failure detail keeps the existing unreachable wording", () => {
    const err = classifyHomepage(page({ status: 0, html: "" }), URL_UNDER_TEST);
    expect(err?.kind).toBe("unreachable");
    expect(err?.message).toBe(
      "Could not reach example.com. Check the URL or your network connection.",
    );
  });

  it("is an AuditError with a stable name, usable across a module boundary", () => {
    const err = classifyHomepage(page({ status: 403 }), URL_UNDER_TEST);
    expect(err).toBeInstanceOf(AuditError);
    expect(err).toBeInstanceOf(Error);
    expect(err?.name).toBe("AuditError");
  });
});

describe("fetchPage failure detail feeding classifyHomepage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function fetchHomepage(): Promise<FetchedPage> {
    const promise = fetchPage(URL_UNDER_TEST, opts);
    await vi.runAllTimersAsync();
    return promise;
  }

  it("429 after retry exhaustion is rate_limited", async () => {
    vi.mocked(fetch).mockImplementation(async () => response(429, "slow down"));
    const home = await fetchHomepage();
    expect(fetch).toHaveBeenCalledTimes(4);
    // fetchPage never surfaces a live 429/503 as a page status — always 0 + detail.
    expect(home.status).toBe(0);
    expect(home.fetchFailure).toMatchObject({ kind: "rate_limited", status: 429 });
    const err = classifyHomepage(home, URL_UNDER_TEST);
    expect(err?.kind).toBe("rate_limited");
    expect(err?.evidence.status).toBe(429);
  });

  it("503 after retry exhaustion without markers is unknown_failure, not rate_limited", async () => {
    vi.mocked(fetch).mockImplementation(async () => response(503, "maintenance"));
    const home = await fetchHomepage();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(home.status).toBe(0);
    expect(home.fetchFailure).toMatchObject({ kind: "unknown_failure", status: 503 });
    expect(classifyHomepage(home, URL_UNDER_TEST)?.kind).toBe("unknown_failure");
  });

  it.each([
    503, 429,
  ])("a %i challenge is detected on the first response and never retried", async (status) => {
    vi.mocked(fetch).mockImplementation(async () =>
      response(status, CF_CHALLENGE_BODY, { "cf-ray": "abc" }),
    );
    const home = await fetchHomepage();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(home.fetchFailure?.kind).toBe("blocked");
    const err = classifyHomepage(home, URL_UNDER_TEST);
    expect(err?.kind).toBe("blocked");
    expect(err?.evidence).toMatchObject({ status, vendor: "cloudflare" });
    expect(err?.evidence.signal).toContain("/cdn-cgi/challenge-platform/");
  });

  it("an ordinary 403 challenge page is still returned to the caller with body and headers", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      response(403, CF_CHALLENGE_BODY, { "cf-ray": "abc" }),
    );
    const home = await fetchHomepage();
    expect(home.status).toBe(403);
    expect(home.html).toBe(CF_CHALLENGE_BODY);
    expect(home.headers["cf-ray"]).toBe("abc");
    expect(home.fetchFailure).toBeUndefined();
    expect(classifyHomepage(home, URL_UNDER_TEST)?.kind).toBe("blocked");
  });

  it("an AbortError after retry exhaustion is timeout", async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException("aborted", "AbortError"));
    const home = await fetchHomepage();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(home.fetchFailure).toMatchObject({ kind: "timeout", cause: "AbortError" });
    const err = classifyHomepage(home, URL_UNDER_TEST);
    expect(err?.kind).toBe("timeout");
    expect(err?.evidence).toEqual({ cause: "AbortError" });
  });

  it("a DNS failure is unreachable and carries the underlying code", async () => {
    const dns = new TypeError("fetch failed");
    (dns as { cause?: unknown }).cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    });
    vi.mocked(fetch).mockRejectedValue(dns);
    const home = await fetchHomepage();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(home.fetchFailure).toMatchObject({ kind: "unreachable", cause: "ENOTFOUND" });
    const err = classifyHomepage(home, URL_UNDER_TEST);
    expect(err?.message).toBe(
      "Could not reach example.com. Check the URL or your network connection.",
    );
    expect(err?.evidence.cause).toBe("ENOTFOUND");
  });

  // A transient outage behind a JSD-instrumented CDN must still be retried:
  // /cdn-cgi/challenge-platform/scripts/jsd/ is instrumentation, not a challenge
  // (live capture 2026-09-15: www.g2.com 403, www.crunchbase.com 200).
  it("retries a 503 whose error page carries JavaScript Detections instrumentation", async () => {
    const jsd =
      '<html><head><title>Service Unavailable</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body>503</body></html>';
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(503, jsd, { server: "cloudflare" }))
      .mockResolvedValueOnce(response(200, "<html><body>back up</body></html>"));
    const home = await fetchHomepage();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(home.status).toBe(200);
    expect(home.fetchFailure).toBeUndefined();
  });

  it("keeps the bytes already received when a challenge body resets mid-read", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      erroringBody(503, '<html><script>window._cf_chl_opt={cvId:"3"}</script>'),
    );
    const home = await fetchHomepage();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(home.fetchFailure).toMatchObject({
      kind: "blocked",
      status: 503,
      challenge: { vendor: "cloudflare", signal: "body: window._cf_chl_opt" },
    });
  });

  describe("a response whose body fails to read is classified from its headers", () => {
    it("403 with cf-mitigated is blocked, not unreachable", async () => {
      vi.mocked(fetch).mockImplementation(async () =>
        erroringBody(403, "<html>", { "cf-mitigated": "challenge" }),
      );
      const home = await fetchHomepage();
      expect(home.status).toBe(0);
      expect(home.fetchFailure).toEqual({
        kind: "blocked",
        status: 403,
        challenge: { vendor: "cloudflare", signal: "cf-mitigated: challenge" },
        cause: "body-read-failed",
      });
      expect(classifyHomepage(home, URL_UNDER_TEST)?.kind).toBe("blocked");
    });

    it("401 with WWW-Authenticate is auth_gated", async () => {
      vi.mocked(fetch).mockImplementation(async () =>
        erroringBody(401, "<html>", { "www-authenticate": "Basic realm=x" }),
      );
      const home = await fetchHomepage();
      expect(home.fetchFailure).toEqual({
        kind: "auth_gated",
        status: 401,
        cause: "body-read-failed",
      });
    });

    it("403 with no markers is unknown_failure", async () => {
      vi.mocked(fetch).mockImplementation(async () => erroringBody(403, "<html>"));
      const home = await fetchHomepage();
      expect(home.fetchFailure).toEqual({
        kind: "unknown_failure",
        status: 403,
        cause: "body-read-failed",
      });
    });

    it("200 stays status 0 and unreachable — an empty page must never look scorable", async () => {
      vi.mocked(fetch).mockImplementation(async () => erroringBody(200, "<html>"));
      const home = await fetchHomepage();
      expect(home.status).toBe(0);
      expect(home.html).toBe("");
      expect(home.fetchFailure).toEqual({ kind: "unreachable", cause: "body-read-failed" });
    });
  });

  it("a refused connection is unreachable", async () => {
    const refused = new TypeError("fetch failed");
    (refused as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    vi.mocked(fetch).mockRejectedValue(refused);
    const home = await fetchHomepage();
    expect(home.fetchFailure).toMatchObject({ kind: "unreachable", cause: "ECONNREFUSED" });
  });
});

describe("runAudit homepage guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const audit = (pages: FetchedPage[], overrides = {}) =>
    runAudit(
      URL_UNDER_TEST,
      { prefetchedPages: pages, prefetchedMetadata: metadata, ...overrides },
      undefined,
      [],
    );

  it("throws a typed AuditError for a prefetched challenge homepage used verbatim", async () => {
    const err = await audit([page({ status: 403, html: CF_CHALLENGE_BODY })]).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect(err.name).toBe("AuditError");
    expect(err.kind).toBe("blocked");
    expect(err.evidence.vendor).toBe("cloudflare");
  });

  describe("a verbatim prefetched list with no page for the audited URL", () => {
    const pages = () => [
      page({ url: `${URL_UNDER_TEST}/login`, status: 403, html: "Sign in" }),
      page({ url: `${URL_UNDER_TEST}/a` }),
    ];

    it("fetches the homepage and throws when it is challenged", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(403, CF_CHALLENGE_BODY, { "cf-mitigated": "challenge" })),
      );
      const err = await audit(pages()).catch((e) => e);
      expect(err).toBeInstanceOf(AuditError);
      expect(err.kind).toBe("blocked");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(URL_UNDER_TEST);
    });

    it("fetches the homepage and proceeds when it is fine", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(200, "<html><body>hi</body></html>")),
      );
      const report = await audit(pages());
      expect(report.pagesScanned).toBe(2);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("does not fetch at all when the list does contain the homepage", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(200)),
      );
      await audit([page({}), ...pages()]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("throws for an unreachable homepage on the reselect path", async () => {
    const pages = [
      page({ status: 0, html: "", fetchFailure: { kind: "unreachable", cause: "ENOTFOUND" } }),
      page({ url: `${URL_UNDER_TEST}/a` }),
    ];
    const err = await audit(pages, { maxPages: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect(err.kind).toBe("unreachable");
    expect(err.evidence.cause).toBe("ENOTFOUND");
  });

  it("throws for an unreachable homepage on the crawl path", async () => {
    const dns = new TypeError("fetch failed");
    (dns as { cause?: unknown }).cause = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw dns;
      }),
    );
    const err = await runAudit(URL_UNDER_TEST, { maxPages: 1 }, undefined, []).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect(err.kind).toBe("unreachable");
  });

  it.each([200, 404])("proceeds normally for a %i homepage", async (status) => {
    const report = await audit([page({ status })]);
    expect(report.pagesScanned).toBe(1);
  });
});
