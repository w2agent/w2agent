import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentAuthChecks } from "../src/audit/checks/agent-auth.js";
import { contentNegotiation } from "../src/audit/checks/bot-accessibility.js";
import { llmsTxtLinksResolve } from "../src/audit/checks/discovery.js";
import { crawlSite, fetchUnderUas, probeSiteMetadata } from "../src/audit/crawler.js";
import { runAudit } from "../src/audit/engine.js";
import { type AuditOptions, DEFAULT_OPTIONS } from "../src/audit/types.js";
import { runGenerate } from "../src/generate/engine.js";
import { fetchPage, fetchText, guardedFetch, TargetNotAllowedError } from "../src/index.js";
import { checkContentNegotiation } from "../src/shared/fetcher.js";

// The threat: a public site under audit steers the auditor (via redirects,
// sitemap entries, llms.txt links, well-known probes) onto private/internal
// hosts. The hook stands in for the platform's private-IP check: it refuses
// loopback, RFC1918, link-local and any "internal"/"api" host we pretend
// resolves privately.
const PRIVATE = /^https?:\/\/(127\.|10\.|169\.254\.|internal\.site\.test|api\.site\.test)/;
const isAllowedTarget = (url: string) => !PRIVATE.test(url);

const SITE = "https://site.test";

type Route = (init: RequestInit | undefined) => Response;
let routes: Record<string, Route>;
let calls: { url: string; init?: RequestInit }[];
let fetchMock: ReturnType<typeof vi.spyOn>;

function redirect(status: number, location: string): Route {
  return () => new Response("redirect body", { status, headers: { location } });
}
function ok(body = "ok", headers: Record<string, string> = {}): Route {
  return () => new Response(body, { status: 200, headers });
}

beforeEach(() => {
  routes = {};
  calls = [];
  fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const route = routes[url];
    return route ? route(init) : new Response("", { status: 404 });
  });
});

afterEach(() => {
  fetchMock.mockRestore();
});

const fetchedPrivate = () => calls.filter((c) => PRIVATE.test(c.url)).map((c) => c.url);

describe("guardedFetch", () => {
  it("without a hook is plain fetch: one call, caller init untouched (OSS localhost audits keep working)", async () => {
    routes["http://localhost:3000/"] = ok();
    const init: RequestInit = { redirect: "follow", headers: { "User-Agent": "t" } };
    const res = await guardedFetch("http://localhost:3000/", init);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/", init);
  });

  it("refuses a disallowed initial URL without touching the network", async () => {
    await expect(guardedFetch("http://127.0.0.1/admin", {}, isAllowedTarget)).rejects.toThrow(
      TargetNotAllowedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the hook throws (fail closed)", async () => {
    const throwing = () => {
      throw new Error("dns down");
    };
    await expect(guardedFetch(`${SITE}/`, {}, throwing)).rejects.toThrow(TargetNotAllowedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a non-http(s) redirect target even if the hook would allow it", async () => {
    routes[`${SITE}/`] = redirect(302, "file:///etc/passwd");
    await expect(guardedFetch(`${SITE}/`, {}, () => true)).rejects.toThrow(TargetNotAllowedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a public URL 302-ing to a private host is refused before the second hop is fetched", async () => {
    routes[`${SITE}/go`] = redirect(302, "http://169.254.169.254/latest/meta-data");
    await expect(guardedFetch(`${SITE}/go`, {}, isAllowedTarget)).rejects.toThrow(
      TargetNotAllowedError,
    );
    expect(calls.map((c) => c.url)).toEqual([`${SITE}/go`]);
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("follows allowed hops, resolving relative Location against the current URL", async () => {
    routes[`${SITE}/a/b`] = redirect(301, "../c");
    routes[`${SITE}/c`] = ok("final");
    const hooked: string[] = [];
    const res = await guardedFetch(`${SITE}/a/b`, {}, (u) => {
      hooked.push(u);
      return true;
    });
    expect(await res.text()).toBe("final");
    expect(hooked).toEqual([`${SITE}/a/b`, `${SITE}/c`]);
  });

  it("303 turns POST into a bodiless GET", async () => {
    routes[`${SITE}/post`] = redirect(303, "/done");
    routes[`${SITE}/done`] = ok();
    await guardedFetch(`${SITE}/post`, { method: "POST", body: "x=1" }, isAllowedTarget);
    expect(calls[1].url).toBe(`${SITE}/done`);
    expect(calls[1].init?.method).toBe("GET");
    expect(calls[1].init?.body).toBeUndefined();
  });

  it("302 turns POST into GET", async () => {
    routes[`${SITE}/post`] = redirect(302, "/done");
    routes[`${SITE}/done`] = ok();
    await guardedFetch(`${SITE}/post`, { method: "POST", body: "x=1" }, isAllowedTarget);
    expect(calls[1].init?.method).toBe("GET");
    expect(calls[1].init?.body).toBeUndefined();
  });

  it("303 keeps HEAD as HEAD", async () => {
    routes[`${SITE}/h`] = redirect(303, "/done");
    routes[`${SITE}/done`] = ok();
    await guardedFetch(`${SITE}/h`, { method: "HEAD" }, isAllowedTarget);
    expect(calls[1].init?.method).toBe("HEAD");
  });

  it("307 keeps method and body", async () => {
    routes[`${SITE}/post`] = redirect(307, "/moved");
    routes[`${SITE}/moved`] = ok();
    await guardedFetch(`${SITE}/post`, { method: "POST", body: "x=1" }, isAllowedTarget);
    expect(calls[1].init?.method).toBe("POST");
    expect(calls[1].init?.body).toBe("x=1");
  });

  it("allows 20 redirects but refuses the 21st", async () => {
    for (let i = 0; i < 20; i++) routes[`${SITE}/r${i}`] = redirect(302, `/r${i + 1}`);
    routes[`${SITE}/r20`] = ok("end");
    const res = await guardedFetch(`${SITE}/r0`, {}, isAllowedTarget);
    expect(await res.text()).toBe("end");

    routes[`${SITE}/r20`] = redirect(302, "/r21");
    routes[`${SITE}/r21`] = ok();
    calls = [];
    await expect(guardedFetch(`${SITE}/r0`, {}, isAllowedTarget)).rejects.toThrow(/redirects/);
    expect(calls.map((c) => c.url)).not.toContain(`${SITE}/r21`);
  });

  it("returns a 3xx without Location as the final response", async () => {
    routes[`${SITE}/`] = () => new Response("", { status: 302 });
    const res = await guardedFetch(`${SITE}/`, {}, isAllowedTarget);
    expect(res.status).toBe(302);
  });

  it("respects redirect:'manual' — returns the 3xx without following, still checks the initial URL", async () => {
    routes[`${SITE}/`] = redirect(302, `${SITE}/next`);
    const res = await guardedFetch(`${SITE}/`, { redirect: "manual" }, isAllowedTarget);
    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      guardedFetch("http://10.0.0.1/", { redirect: "manual" }, isAllowedTarget),
    ).rejects.toThrow(TargetNotAllowedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Parity with native follow: slice 7 reuses this for off-origin OAuth AS
  // fetches, so credentials must not leak to whatever origin a redirect names.
  const sentHeaders = (i: number) => new Headers(calls[i].init?.headers);

  it("cross-origin 302 of a POST: GET, no body, credentials and body headers dropped", async () => {
    routes[`${SITE}/token`] = redirect(302, "https://other.test/landing");
    routes["https://other.test/landing"] = ok();
    await guardedFetch(
      `${SITE}/token`,
      {
        method: "POST",
        body: "x=1",
        headers: {
          Authorization: "Bearer s3cret",
          Cookie: "sid=1",
          "Proxy-Authorization": "Basic p",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "w2agent",
        },
      },
      isAllowedTarget,
    );
    expect(calls[1].url).toBe("https://other.test/landing");
    expect(calls[1].init?.method).toBe("GET");
    expect(calls[1].init?.body).toBeUndefined();
    const h = sentHeaders(1);
    for (const name of ["authorization", "cookie", "proxy-authorization", "content-type"]) {
      expect(h.has(name)).toBe(false);
    }
    expect(h.get("user-agent")).toBe("w2agent");
  });

  it("same-origin 307 keeps authorization, content-type and body", async () => {
    routes[`${SITE}/a`] = redirect(307, "/b");
    routes[`${SITE}/b`] = ok();
    await guardedFetch(
      `${SITE}/a`,
      {
        method: "POST",
        body: "{}",
        headers: { Authorization: "Bearer s3cret", "Content-Type": "application/json" },
      },
      isAllowedTarget,
    );
    const h = sentHeaders(1);
    expect(h.get("authorization")).toBe("Bearer s3cret");
    expect(h.get("content-type")).toBe("application/json");
    expect(calls[1].init?.body).toBe("{}");
  });

  it("same-origin 303 rewrite drops body headers but keeps authorization", async () => {
    routes[`${SITE}/a`] = redirect(303, "/b");
    routes[`${SITE}/b`] = ok();
    await guardedFetch(
      `${SITE}/a`,
      {
        method: "POST",
        body: "{}",
        headers: new Headers({
          Authorization: "Bearer s3cret",
          "Content-Type": "application/json",
        }),
      },
      isAllowedTarget,
    );
    const h = sentHeaders(1);
    expect(h.get("authorization")).toBe("Bearer s3cret");
    expect(h.has("content-type")).toBe(false);
  });

  it("strips credentials cross-origin for array-shaped headers too", async () => {
    routes[`${SITE}/a`] = redirect(301, "https://other.test/b");
    routes["https://other.test/b"] = ok();
    await guardedFetch(
      `${SITE}/a`,
      {
        headers: [
          ["Authorization", "Bearer s3cret"],
          ["Accept", "application/json"],
        ],
      },
      isAllowedTarget,
    );
    const h = sentHeaders(1);
    expect(h.has("authorization")).toBe(false);
    expect(h.get("accept")).toBe("application/json");
  });
});

describe("hook slower than the caller's timeout", () => {
  // Platform scenario: slow DNS behind the async private-IP check. An allowed
  // target must time out like a slow network does — not wait out the hook on
  // every retry and turn a whole audit into "Could not reach host".
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const slowHook = (ms: number, counter: { started: number }) => () => {
    counter.started++;
    return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms));
  };

  it("rejects with the signal's reason when aborted mid-hook, without fetching", async () => {
    const controller = new AbortController();
    const reason = new DOMException("timed out", "TimeoutError");
    setTimeout(() => controller.abort(reason), 50);
    const p = guardedFetch(
      `${SITE}/`,
      { signal: controller.signal },
      slowHook(300, { started: 0 }),
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes its abort listener once the hook settles (no per-hop listener leak on a shared signal)", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    routes[`${SITE}/a`] = redirect(302, "/b");
    routes[`${SITE}/b`] = ok();
    await guardedFetch(`${SITE}/a`, { signal: controller.signal }, isAllowedTarget);
    const hookListeners = add.mock.calls.filter(([type]) => type === "abort").map(([, fn]) => fn);
    expect(hookListeners).toHaveLength(2);
    for (const fn of hookListeners) {
      expect(remove.mock.calls.some(([type, f]) => type === "abort" && f === fn)).toBe(true);
    }
  });

  it("costs fetchText exactly what a timed-out fetch costs (no hook-time amplification)", async () => {
    const timedFetchText = async (hook: (u: string) => boolean | Promise<boolean>) => {
      const start = Date.now();
      const p = fetchText(`${SITE}/`, { timeout: 50, userAgent: "t", isAllowedTarget: hook }).then(
        (r) => ({ r, elapsed: Date.now() - start }),
      );
      await vi.runAllTimersAsync();
      return p;
    };

    // Baseline: instant hook, network hangs past the timeout.
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const baseline = await timedFetchText(() => true);
    const baselineAttempts = fetchMock.mock.calls.length;

    // Slow hook (300 ms > 50 ms timeout), network would answer instantly.
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response("ok"));
    const counter = { started: 0 };
    const slow = await timedFetchText(slowHook(300, counter));

    expect(baseline.r).toBeNull();
    expect(slow.r).toBeNull();
    expect(baselineAttempts).toBe(4);
    expect(counter.started).toBe(baselineAttempts);
    expect(slow.elapsed).toBe(baseline.elapsed);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchPage / fetchText / checkContentNegotiation with a hook", () => {
  const opts = { timeout: 5000, userAgent: "t", isAllowedTarget };

  it("refused initial URL → fetchPage status 0, fetchText null, no fetch, no retries", async () => {
    const page = await fetchPage("http://10.0.0.1/", opts);
    expect(page).toMatchObject({ url: "http://10.0.0.1/", status: 0, html: "" });
    expect(await fetchText("http://10.0.0.1/robots.txt", opts)).toBeNull();
    expect(await checkContentNegotiation("http://10.0.0.1/", opts)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refused redirect hop → status 0 and the private host is never fetched", async () => {
    routes[`${SITE}/x`] = redirect(302, "http://127.0.0.1:8080/");
    expect((await fetchPage(`${SITE}/x`, opts)).status).toBe(0);
    expect(await fetchText(`${SITE}/x`, opts)).toBeNull();
    expect(fetchedPrivate()).toEqual([]);
  });

  it("fetchPage keeps url = requested URL after following redirects (prefetch cache key)", async () => {
    routes[`${SITE}/old`] = redirect(301, "/new");
    routes[`${SITE}/new`] = ok("<html>new</html>");
    const page = await fetchPage(`${SITE}/old`, opts);
    expect(page).toMatchObject({ url: `${SITE}/old`, status: 200, html: "<html>new</html>" });
  });

  it("without a hook fetchPage calls fetch once with redirect 'follow' (native behaviour)", async () => {
    routes[`${SITE}/`] = ok();
    await fetchPage(`${SITE}/`, { timeout: 5000, userAgent: "t" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0].init?.redirect).toBe("follow");
  });
});

describe("crawler with a hook", () => {
  const options: AuditOptions = {
    ...DEFAULT_OPTIONS,
    maxPages: 5,
    requestDelay: 0,
    isAllowedTarget,
  };

  it("a sitemap entry that redirects to a private IP is not followed by crawlSite/crawlPages", async () => {
    routes[`${SITE}/`] = ok("<html><body>home</body></html>");
    routes[`${SITE}/sitemap.xml`] = ok(
      `<urlset><url><loc>${SITE}/p1</loc></url><url><loc>${SITE}/p2</loc></url></urlset>`,
    );
    routes[`${SITE}/p1`] = redirect(302, "http://169.254.169.254/latest/meta-data");
    routes[`${SITE}/p2`] = ok("<html><body>p2</body></html>");
    const { pages } = await crawlSite(`${SITE}/`, options);
    expect(calls.map((c) => c.url)).toContain(`${SITE}/p1`);
    expect(fetchedPrivate()).toEqual([]);
    expect(pages.map((p) => p.url)).not.toContain(`${SITE}/p1`);
  });

  it("fillFromSitemap does not fetch a subdomain sitemap entry the hook refuses", async () => {
    routes[`${SITE}/`] = ok("<html><body>home</body></html>");
    routes[`${SITE}/sitemap.xml`] = ok(
      "<urlset><url><loc>https://internal.site.test/admin</loc></url></urlset>",
    );
    routes["https://internal.site.test/admin"] = ok("<html>secret</html>");
    const { pages } = await crawlSite(`${SITE}/`, options);
    expect(fetchedPrivate()).toEqual([]);
    expect(pages).toHaveLength(1);
  });

  it("fetchUnderUas does not follow a homepage redirect onto a private host", async () => {
    routes[`${SITE}/`] = redirect(302, "http://10.1.2.3/");
    const res = await fetchUnderUas(`${SITE}/`, options);
    expect(fetchedPrivate()).toEqual([]);
    expect(Object.values(res).every((r) => r.outcome === "fetch-error")).toBe(true);
  });

  it("probeMcpInit's POST does not follow a 307 onto a private host", async () => {
    routes[`${SITE}/`] = ok("<html></html>");
    routes[`${SITE}/.well-known/mcp`] = (init) =>
      init?.method === "POST"
        ? new Response("", { status: 307, headers: { location: "http://127.0.0.1:9000/mcp" } })
        : new Response("{}", { status: 200 });
    const metadata = await probeSiteMetadata(`${SITE}/`, options, { homepageHtml: "" });
    expect(
      calls.some((c) => c.url === `${SITE}/.well-known/mcp` && c.init?.method === "POST"),
    ).toBe(true);
    expect(fetchedPrivate()).toEqual([]);
    expect(metadata.mcpInit?.success).toBe(false);
  });
});

describe("runAudit threads the hook into checks", () => {
  it("llms.txt links and agent-auth probes to refused hosts are never fetched", async () => {
    routes[`${SITE}/`] = ok("<html><body>home</body></html>");
    routes[`${SITE}/llms.txt`] = ok(`# Site\n- [Admin](http://10.0.0.5/admin)\n- [Home](${SITE}/)`);
    const checks = [
      llmsTxtLinksResolve,
      contentNegotiation,
      ...agentAuthChecks.filter((c) => c.id === "public-api"),
    ];
    const report = await runAudit(
      `${SITE}/`,
      { maxPages: 1, requestDelay: 0, isAllowedTarget },
      undefined,
      checks,
    );
    expect(fetchedPrivate()).toEqual([]);
    expect(calls.map((c) => c.url)).toContain(`${SITE}/api/`);
    const links = report.categories
      .flatMap((c) => c.checks)
      .find((c) => c.id === "llms-txt-links-resolve");
    expect(links?.message).toBe("1/2 URLs in llms.txt resolve successfully");
  });

  it("a check receives the hook as ctx", async () => {
    routes[`${SITE}/`] = ok("<html></html>");
    const seen: unknown[] = [];
    const probe = {
      id: "ctx-probe",
      name: "ctx probe",
      category: "technical" as const,
      weight: 1,
      severity: "info" as const,
      run: (_p: unknown, _m: unknown, ctx?: Pick<AuditOptions, "isAllowedTarget">) => {
        seen.push(ctx?.isAllowedTarget);
        return {
          id: "ctx-probe",
          name: "ctx probe",
          category: "technical" as const,
          status: "pass" as const,
          score: 100,
          maxScore: 100,
          weight: 1,
          message: "",
          severity: "info" as const,
        };
      },
    };
    await runAudit(`${SITE}/`, { maxPages: 1, requestDelay: 0, isAllowedTarget }, undefined, [
      probe,
    ]);
    expect(seen).toEqual([isAllowedTarget]);
  });
});

describe("runGenerate passes the hook to its crawl", () => {
  it("neither the crawl nor the link fallback fetches a refused page", async () => {
    routes[`${SITE}/`] = ok(
      '<html><head><title>Home</title></head><body><a href="/about">About</a><a href="https://internal.site.test/x">x</a><p>hello world</p></body></html>',
    );
    routes[`${SITE}/about`] = ok("<html><body>about</body></html>");
    const refuseAbout = (u: string) => isAllowedTarget(u) && !u.endsWith("/about");
    await runGenerate(`${SITE}/`, {
      maxPages: 3,
      formats: ["llms-txt"],
      isAllowedTarget: refuseAbout,
    });
    expect(calls.map((c) => c.url)).toContain(`${SITE}/`);
    expect(calls.map((c) => c.url)).not.toContain(`${SITE}/about`);
  });
});
