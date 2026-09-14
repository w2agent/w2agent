import robotsParser from "robots-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aiAgentAccess,
  contentNegotiation,
  responseTime,
  robotsTxtExists,
  sitemapExists,
  statusCodes,
} from "../../src/audit/checks/bot-accessibility.js";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

const basePage: FetchedPage = {
  url: "https://example.com",
  status: 200,
  html: "<html><body>Hello</body></html>",
  headers: {},
  responseTime: 100,
};

describe("robots-txt-exists", () => {
  it("passes when robots.txt exists", () => {
    const result = robotsTxtExists.run([basePage], {
      ...baseMeta,
      robotsTxt: "User-agent: *\nAllow: /",
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when no robots.txt", () => {
    const result = robotsTxtExists.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("ai-agent-access", () => {
  const run = (robotsTxt?: string) => aiAgentAccess.run([basePage], { ...baseMeta, robotsTxt });

  it("fails with severity error when a user-initiated agent is blocked — the site declares intent to refuse agents acting for a person", () => {
    const result = run("User-agent: ChatGPT-User\nDisallow: /");
    expect(result).toMatchObject({ status: "fail", score: 0, severity: "error" });
    expect(result.message).toContain("ChatGPT-User");
    expect(result.message).toContain("declares intent to block");
  });

  // Appending "User-agent: ChatGPT-User / Allow: /" merges into the owner's group, where the
  // longer "Disallow: /*" still wins — the old snippet left the check failing after applying it.
  it("named-group block: the snippet describes the same edit the generator makes (delete the token's lines, append its own group)", () => {
    const robotsTxt =
      "User-agent: GPTBot\nUser-agent: ChatGPT-User\nDisallow: /*\n\nUser-agent: *\nDisallow: /";
    const snippet = run(robotsTxt).fixSnippet ?? "";
    expect(
      snippet.startsWith(
        [
          "# Allow AI agents and search fetchers in robots.txt:",
          "# 1. Delete these lines (only the agents below move out; every other agent keeps its rules):",
          "#    line 2: User-agent: ChatGPT-User",
          "# 2. Append:",
          "User-agent: ChatGPT-User",
        ].join("\n"),
      ),
    ).toBe(true);

    const deleted = robotsTxt
      .split("\n")
      .filter((_, i) => i !== 1)
      .join("\n");
    const applied = `${deleted}\n\n${snippet}`;
    expect(run(applied)).toMatchObject({ status: "pass", score: 100 });
    const robots = robotsParser("https://example.com/robots.txt", applied);
    expect(robots.isAllowed("https://example.com/", "GPTBot")).toBe(false);
  });

  it("wildcard block: applying the snippet makes the check pass and keeps * path restrictions", () => {
    const robotsTxt =
      "User-agent: *\nDisallow: /*\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /";
    const result = run(robotsTxt);
    const applied = `${robotsTxt}\n\n${result.fixSnippet}`;
    expect(run(applied)).toMatchObject({ status: "pass", score: 100 });
    const robots = robotsParser("https://example.com/robots.txt", applied);
    expect(robots.isAllowed("https://example.com/private/a", "ChatGPT-User")).toBe(false);
    expect(robots.isAllowed("https://example.com/", "GPTBot")).toBe(false);
    expect(result.fixSnippet).not.toContain("GPTBot");
  });

  it("only warns (partial 50) when an AI search fetcher is blocked — lost discoverability, not refused agents", () => {
    const result = run("User-agent: PerplexityBot\nDisallow: /");
    expect(result).toMatchObject({ status: "partial", score: 50, severity: "warning" });
    expect(result.message).toContain("PerplexityBot");
    expect(result.fixSnippet).toContain("#    line 1: User-agent: PerplexityBot");
  });

  it("stays pass 100 when only training crawlers are blocked — opting out of training is neutral (D-2)", () => {
    const result = run(
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /",
    );
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.details).toMatch(/Training.*blocked: GPTBot, Google-Extended, CCBot/);
    expect(result.fixSnippet).toBeUndefined();
  });

  it("does not fix-suggest training tokens when user/search tokens are also blocked", () => {
    const result = run(
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: Claude-SearchBot\nDisallow: /",
    );
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.fixSnippet).toContain("Claude-SearchBot");
    expect(result.fixSnippet).not.toContain("GPTBot");
  });

  it("fails when User-agent: * disallows everything — user agents inherit the wildcard block", () => {
    const result = run("User-agent: *\nDisallow: /");
    expect(result).toMatchObject({ status: "fail", score: 0, severity: "error" });
    expect(result.message).toContain("Claude-User");
  });

  it("passes when only a path is disallowed — the site root stays reachable", () => {
    expect(run("User-agent: *\nDisallow: /private")).toMatchObject({ status: "pass", score: 100 });
  });

  const runStatus = (robotsTxtStatus: number | undefined) =>
    aiAgentAccess.run([basePage], { ...baseMeta, robotsTxtStatus });

  it("passes on a 4xx robots.txt — RFC 9309 'unavailable' means crawlers may access everything", () => {
    for (const status of [403, 404, 410]) {
      const result = runStatus(status);
      expect(result).toMatchObject({ status: "pass", score: 100 });
      expect(result.message).toContain("crawlers may access everything");
    }
  });

  it("fails on a 5xx robots.txt — RFC 9309 'unreachable' means crawlers must assume complete disallow", () => {
    for (const status of [500, 503]) {
      const result = runStatus(status);
      expect(result).toMatchObject({ status: "fail", score: 0, severity: "error" });
      expect(result.message).toContain(`returned ${status}`);
      expect(result.message).toContain("assume complete disallow");
    }
  });

  // A 429 only reaches metadata after every retry was rate-limited: the file was never seen,
  // so scoring it as "no robots.txt" would claim access we never measured.
  it("reports error (unmeasured) on a persistent 429", () => {
    const result = runStatus(429);
    expect(result).toMatchObject({ status: "error", score: 0 });
    expect(result.message).toContain("429");
  });

  // 0 means we never saw a response (network error, timeout): unmeasured, not a finding.
  it("reports error (unmeasured) when the robots.txt fetch got no response", () => {
    expect(runStatus(0)).toMatchObject({ status: "error", score: 0 });
  });

  it("passes on a 200 HTML soft-404 (robotsTxt absent) and on hand-built metadata with no status", () => {
    expect(runStatus(200)).toMatchObject({ status: "pass", score: 100 });
    expect(run(undefined)).toMatchObject({ status: "pass", score: 100 });
  });

  it("never evaluates Google-Agent — it has no robots.txt token; only notes it in details", () => {
    const result = run("User-agent: Google-Agent\nDisallow: /");
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.details).toContain("Google-Agent: no robots.txt token");
    expect(result.message).not.toContain("Google-Agent");
    expect(result.details).not.toMatch(/blocked: [^\n]*Google-Agent/);
  });
});

describe("sitemap-exists", () => {
  it("passes with valid sitemap", () => {
    const result = sitemapExists.run([basePage], {
      ...baseMeta,
      sitemapXml:
        '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>',
    });
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails when no sitemap", () => {
    const result = sitemapExists.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("response-time", () => {
  const run = (...times: number[]) =>
    responseTime.run(
      times.map((t, i) => ({ ...basePage, url: `https://example.com/p${i}`, responseTime: t })),
      baseMeta,
    );

  it("scores 100 for fast pages", () => {
    expect(run(200)).toMatchObject({ status: "pass", score: 100, severity: "info" });
  });

  it("fails very slow pages", () => {
    expect(run(3500)).toMatchObject({ status: "fail", score: 0, severity: "warning" });
  });

  it("uses few coarse buckets with strict < boundaries so run-to-run jitter rarely moves the score", () => {
    expect(run(499)).toMatchObject({ status: "pass", score: 100, severity: "info" });
    expect(run(500)).toMatchObject({ status: "pass", score: 70, severity: "info" });
    expect(run(1499)).toMatchObject({ status: "pass", score: 70, severity: "info" });
    expect(run(1500)).toMatchObject({ status: "partial", score: 35, severity: "warning" });
    expect(run(2999)).toMatchObject({ status: "partial", score: 35, severity: "warning" });
    expect(run(3000)).toMatchObject({ status: "fail", score: 0, severity: "warning" });
  });

  it("skips when every page is unmeasured (responseTime 0) so untimed pre-fetched pages don't earn free full marks", () => {
    const result = run(0, 0, 0);
    expect(result).toMatchObject({ status: "skip", score: 0 });
    expect(result.message).toContain("not measured");
  });

  it("skips with no pages because there is nothing to time", () => {
    expect(responseTime.run([], baseMeta)).toMatchObject({
      status: "skip",
      score: 0,
      message: "No pages to measure",
    });
  });

  it("averages only measured pages so unmeasured zeros can't drag a slow site into a faster bucket", () => {
    const result = run(0, 2000);
    expect(result).toMatchObject({ status: "partial", score: 35 });
    expect(result.message).toContain("2000ms");
    expect(result.message).toContain("1 unmeasured");
    expect(result.details).toBe("https://example.com/p1: 2000ms");
  });
});

describe("status-codes", () => {
  it("passes when all pages return 200", () => {
    const result = statusCodes.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("partial when some pages have errors", () => {
    const result = statusCodes.run(
      [basePage, { ...basePage, url: "https://example.com/broken", status: 404 }],
      baseMeta,
    );
    expect(result).toMatchObject({ status: "partial" });
    expect(result.score).toBe(50);
  });
});

describe("content-negotiation", () => {
  type Handler = (
    accept: string | null,
    url: string,
    init?: RequestInit,
  ) => Response | Promise<Response>;
  const REDIRECTS = new Set([301, 302, 303, 307, 308]);
  const MD = "# Example\n\nHello agents.";
  const md = (body = MD, headers: Record<string, string> = {}) =>
    new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8", ...headers } });
  const html = (body = "<!doctype html><html><body>Hello</body></html>") =>
    new Response(body, { headers: { "content-type": "text/html" } });
  const notFound = () => new Response("not found", { status: 404 });
  const htmlUnlessMarkdown =
    (markdown: Response | (() => Response)): Handler =>
    (accept) =>
      accept === "text/markdown"
        ? typeof markdown === "function"
          ? markdown()
          : markdown
        : html();

  let requests: { url: string; accept: string | null }[] = [];
  // Behaves like fetch: follows redirects unless redirect is "manual", and the
  // returned response's url is the final URL.
  function serve(routes: Record<string, Handler>, fallback: Handler = notFound) {
    requests = [];
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      let url = input instanceof Request ? input.url : String(input);
      const accept = new Headers(init?.headers as HeadersInit | undefined).get("accept");
      for (let hop = 0; ; hop++) {
        requests.push({ url, accept });
        const res = await (routes[url] ?? fallback)(accept, url, init);
        const location = res.headers.get("location");
        if (init?.redirect === "manual" || hop >= 5 || !REDIRECTS.has(res.status) || !location) {
          if (!res.url) Object.defineProperty(res, "url", { value: url });
          return res;
        }
        url = new URL(location, url).href;
      }
    });
  }
  const targetUrls = () =>
    [...new Set(requests.map((r) => r.url))].filter((u) => !/\/[0-9a-f-]{36}\.md$/.test(u)).sort();
  const run = (pages: FetchedPage[] = [basePage], meta: Partial<SiteMetadata> = {}, ctx = {}) =>
    contentNegotiation.run(pages, { ...baseMeta, ...meta }, ctx);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes when the homepage answers Accept: text/markdown with markdown and Vary: Accept — caches keep browsers on HTML", async () => {
    serve({ "https://example.com/": htmlUnlessMarkdown(md(MD, { vary: "Accept" })) });
    const result = await run();
    expect(result).toMatchObject({ status: "pass", score: 100, severity: "info", weight: 0.5 });
    expect(result.message).toContain("Accept: text/markdown (homepage)");
    expect(result.message).not.toContain("add Vary");
    expect(result.fixSnippet).toBeUndefined();
    expect(requests).toContainEqual({ url: "https://example.com/", accept: "text/markdown" });
  });

  it("is only partial when negotiation works without Vary: Accept — a shared cache could serve markdown to browsers", async () => {
    serve({ "https://example.com/": htmlUnlessMarkdown(md()) });
    const result = await run();
    expect(result).toMatchObject({ status: "partial", score: 50 });
    expect(result.message).toContain("add Vary: Accept");
    expect(result.fixSnippet).toContain("Vary: Accept");
    expect(result.details).toContain("no Vary: Accept");
  });

  it.each([
    "*",
    "Accept-Encoding, accept",
  ])("accepts Vary %j as varying on Accept (wildcard and case-insensitive list forms)", async (vary) => {
    serve({ "https://example.com/": htmlUnlessMarkdown(md(MD, { vary })) });
    expect(await run()).toMatchObject({ status: "pass", score: 100 });
  });

  it("does not treat Vary: Accept-Encoding alone as varying on Accept", async () => {
    serve({ "https://example.com/": htmlUnlessMarkdown(md(MD, { vary: "Accept-Encoding" })) });
    expect(await run()).toMatchObject({ status: "partial", score: 50 });
  });

  it("passes on a markdown twin at /index.md for the homepage — a stable URL needs no Vary", async () => {
    serve({ "https://example.com/": () => html(), "https://example.com/index.md": () => md() });
    const result = await run();
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain(".md URL (homepage)");
    expect(result.fixSnippet).toBeUndefined();
  });

  it("a .md hit still passes but tells the site to add Vary when its negotiation response lacks it", async () => {
    serve({
      "https://example.com/": htmlUnlessMarkdown(md()),
      "https://example.com/index.md": () => md(),
    });
    const result = await run();
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain("add Vary: Accept");
  });

  it("probes a docs page by stripping its trailing slash: /docs/intro/ → /docs/intro.md", async () => {
    serve({ "https://example.com/docs/intro.md": () => md() });
    const docs = { ...basePage, url: "https://example.com/docs/intro/?ref=nav#top" };
    const result = await run([basePage, docs]);
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.message).toContain(".md URL (docs page)");
    expect(targetUrls()).toEqual([
      "https://example.com/",
      "https://example.com/docs/intro.md",
      "https://example.com/docs/intro/?ref=nav#top",
      "https://example.com/index.md",
    ]);
  });

  it("picks the first page on a docs. subdomain of the site as the docs page", async () => {
    serve({});
    const pages = [
      basePage,
      { ...basePage, url: "https://example.com/pricing" },
      { ...basePage, url: "https://docs.example.com/getting-started" },
      { ...basePage, url: "https://example.com/docs/later" },
    ];
    const result = await run(pages, { baseUrl: "https://www.example.com" });
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(targetUrls()).toEqual([
      "https://docs.example.com/getting-started",
      "https://docs.example.com/getting-started.md",
      "https://www.example.com/",
      "https://www.example.com/index.md",
    ]);
  });

  it("on a site rooted at docs.<host>, any other crawled page there is the docs page and the homepage is probed once", async () => {
    serve({});
    const pages = [
      { ...basePage, url: "https://docs.example.com/" },
      { ...basePage, url: "https://docs.example.com/guide" },
    ];
    await run(pages, { baseUrl: "https://docs.example.com" });
    expect(requests.map((r) => r.url).sort()).toEqual([
      "https://docs.example.com/",
      "https://docs.example.com/guide",
      "https://docs.example.com/guide.md",
      "https://docs.example.com/index.md",
    ]);
  });

  it("never probes non-docs pages or failed docs pages — the plan checks the homepage and one docs page only", async () => {
    serve({});
    const pages = [
      basePage,
      { ...basePage, url: "https://example.com/blog/post" },
      { ...basePage, url: "https://example.com/docsite" },
      { ...basePage, url: "https://example.com/docs/missing", status: 404 },
    ];
    const result = await run(pages);
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.message).toContain("checked homepage");
    expect(targetUrls()).toEqual(["https://example.com/", "https://example.com/index.md"]);
  });

  it("never probes a crawled docs page that lives on another site", async () => {
    serve({});
    const pages = [
      basePage,
      { ...basePage, url: "https://other.com/docs/" },
      { ...basePage, url: "https://docs.other.com/" },
      { ...basePage, url: "https://api.example.com/docs/" },
      { ...basePage, url: "https://example.com.evil.test/docs/" },
    ];
    await run(pages);
    expect(targetUrls()).toEqual(["https://example.com/", "https://example.com/index.md"]);
  });

  it("an SPA catch-all serving its HTML shell at /index.md is not markdown", async () => {
    serve({}, () => html());
    const result = await run([basePage], { catchAll: true });
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });

  it("a catch-all that labels its HTML shell text/markdown is not markdown", async () => {
    serve({}, () => md("\n  <!DOCTYPE html><html><body>app</body></html>"));
    const result = await run();
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.details).toContain("HTML body");
  });

  it("markdown text served as text/plain does not count — agents key on the media type", async () => {
    serve(
      {},
      () => new Response(MD, { headers: { "content-type": "text/plain", vary: "Accept" } }),
    );
    expect(await run()).toMatchObject({ status: "fail", score: 0 });
  });

  it("a 'markdown' body identical to the crawled page is the page echoing, not markdown — whether or not the catch-all guard flagged the site", async () => {
    const shell = '<div id="root"></div><script src="/app.js"></script>';
    const page = { ...basePage, html: shell };
    serve({}, () => md(shell, { vary: "Accept" }));
    expect(await run([page], { catchAll: true })).toMatchObject({ status: "fail", score: 0 });
    serve({}, () => md(shell, { vary: "Accept" }));
    const result = await run([page], { catchAll: false });
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(result.details).toContain("catch-all: same body");
  });

  it("short real markdown that differs from the crawled page is a hit", async () => {
    serve({}, () => md("# Hi", { vary: "Accept" }));
    expect(await run([basePage], { catchAll: true })).toMatchObject({ status: "pass", score: 100 });
  });

  it("a 404 carrying text/markdown is a miss — an error page is not the content", async () => {
    serve(
      {},
      () =>
        new Response(MD, {
          status: 404,
          headers: { "content-type": "text/markdown", vary: "Accept" },
        }),
    );
    expect(await run()).toMatchObject({ status: "fail", score: 0 });
  });

  it("an empty text/markdown body is a miss", async () => {
    serve({}, () => md("  \n", { vary: "Accept" }));
    expect(await run()).toMatchObject({ status: "fail", score: 0 });
  });

  it("targets refused by isAllowedTarget are misses: the check fails without throwing or fetching", async () => {
    const spy = serve({}, () => md(MD, { vary: "Accept" }));
    const result = await run([basePage], {}, { isAllowedTarget: () => false });
    expect(result).toMatchObject({ status: "fail", score: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("one probe throwing does not hide another probe's hit", async () => {
    serve({
      "https://example.com/": () => {
        throw new TypeError("socket hang up");
      },
      "https://example.com/index.md": () => md(),
    });
    const result = await run();
    expect(result).toMatchObject({ status: "pass", score: 100 });
    expect(result.details).toContain("miss (request failed");
  });

  describe("HTML sniff", () => {
    it("an HTML document behind a leading comment or BOM is still HTML, even on a catch-all whose shell differs per request", async () => {
      const page = { ...basePage, html: "<!--id=1--><!doctype html><html><body>app</body></html>" };
      serve({
        "https://example.com/": () => html(page.html),
        "https://example.com/index.md": () =>
          md("<!--id=2--><!doctype html><html><body>app</body></html>"),
      });
      const result = await run([page], { catchAll: true });
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain("HTML body");

      serve({}, () => md("﻿\n<!-- build 42 -->\n<HEAD><title>x</title></HEAD><p>hi</p>"));
      expect(await run()).toMatchObject({ status: "fail", score: 0 });
    });

    it("README-style markdown that opens with a centred <div> or carries inline HTML is still markdown", async () => {
      const readme =
        '<div align="center">\n  <img src="/logo.png" alt="logo"><br>\n  <b>Example</b>\n</div>\n\n# Example\n\nSee <a href="/docs">the docs</a>.\n';
      serve({
        "https://example.com/": () => html(),
        "https://example.com/index.md": () => md(readme),
      });
      expect(await run([basePage], { catchAll: true })).toMatchObject({
        status: "pass",
        score: 100,
      });
    });

    const suffixOnly = (body: string) =>
      serve({
        "https://example.com/": () => html(),
        "https://example.com/index.md": () => md(body),
      });

    it("an HTML document behind a comment longer than any fixed sniff window is still HTML", async () => {
      suffixOnly(`<!-- ${"x".repeat(1100)} -->\n<!doctype html><html><body>app</body></html>`);
      const result = await run();
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain("HTML body");
    });

    it("stacked comments before an upper-case <HTML> are skipped — still HTML", async () => {
      suffixOnly("<!--x--><!--y-->\n<HTML><body>app</body></HTML>");
      expect((await run()).details).toContain("HTML body");
    });

    it("an unterminated leading comment is treated as HTML, never as markdown", async () => {
      suffixOnly("<!-- build 42\n# looks like markdown");
      expect((await run()).details).toContain("HTML body");
    });

    it("markdown that teaches HTML (a fenced <head> example near the top) is still markdown", async () => {
      suffixOnly("# HTML guide\n\n```html\n<head>\n  <title>x</title>\n</head>\n```\n");
      expect(await run()).toMatchObject({ status: "pass", score: 100 });
    });

    it('a README opening with <div align="center"> is still markdown', async () => {
      suffixOnly('<div align="center">\n  <b>Example</b>\n</div>\n\n# Example\n');
      expect(await run()).toMatchObject({ status: "pass", score: 100 });
    });
  });

  describe("echo of the crawled page with a byte-order mark", () => {
    const BOM = String.fromCharCode(0xfeff);
    it.each([
      ["the markdown body", BOM, ""],
      ["the crawled page", "", BOM],
    ])("a >64 KB shell identical to the crawled page except a BOM on %s is an echo, not markdown", async (_, bodyBom, pageBom) => {
      const shell = `<div id="root">${"a".repeat(70 * 1024)}</div>`;
      const page = { ...basePage, html: `${pageBom}${shell}` };
      serve({}, () => md(`${bodyBom}${shell}`, { vary: "Accept" }));
      const result = await run([page], { catchAll: false });
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain("catch-all: same body");
    });
  });

  describe("catch-all body longer than the 64 KB read cap", () => {
    it.each([
      ["ASCII", "a"],
      ["a multibyte character split at the cut", "é"],
    ])("a truncated read that matches the start of the crawled page is the catch-all echoing (%s)", async (_, filler) => {
      const lead = `<div>${"a".repeat(64 * 1024 - 6)}`;
      const shell = `${lead}${filler.repeat(3000)}</div><script src="/app.js"></script>`;
      const page = { ...basePage, html: shell };
      serve({}, () => md(shell, { vary: "Accept" }));
      const result = await run([page], { catchAll: true });
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain("catch-all: same body");
    });

    it("a truncated read that diverges from the crawled page is still markdown", async () => {
      const page = { ...basePage, html: `<div>${"a".repeat(70 * 1024)}</div>` };
      serve({}, () => md(`# Docs\n\n${"b".repeat(70 * 1024)}`, { vary: "Accept" }));
      expect(await run([page], { catchAll: true })).toMatchObject({ status: "pass", score: 100 });
    });
  });

  describe("soft-404 .md control probe", () => {
    const CONTROL = /^https:\/\/example\.com\/[0-9a-f-]{36}\.md$/;
    const softMarkdown404: Handler = () => md("# Page not found");

    it("a site answering every .md path with markdown fails — /index.md is its not-found page, not a twin", async () => {
      serve({ "https://example.com/": () => html() }, softMarkdown404);
      const result = await run();
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain("nonexistent .md path also returns markdown (catch-all)");
      expect(requests.some((r) => CONTROL.test(r.url))).toBe(true);
    });

    it("a normal site whose nonexistent .md path 404s keeps its /index.md pass", async () => {
      serve({ "https://example.com/": () => html(), "https://example.com/index.md": () => md() });
      expect(await run()).toMatchObject({ status: "pass", score: 100 });
      expect(requests.filter((r) => CONTROL.test(r.url))).toHaveLength(1);
    });

    it("sends no control probe when no .md URL hit", async () => {
      serve({ "https://example.com/": htmlUnlessMarkdown(md(MD, { vary: "Accept" })) });
      expect(await run()).toMatchObject({ status: "pass", score: 100 });
      expect(requests.some((r) => CONTROL.test(r.url))).toBe(false);
    });

    it("a control refused by isAllowedTarget is never fetched and demotes the .md hit — an unverified twin never counts", async () => {
      serve({ "https://example.com/": () => html(), "https://example.com/index.md": () => md() });
      const isAllowedTarget = vi.fn((url: string) => !CONTROL.test(url));
      const result = await run([basePage], {}, { isAllowedTarget });
      expect(isAllowedTarget.mock.calls.some(([url]) => CONTROL.test(url))).toBe(true);
      expect(requests.some((r) => CONTROL.test(r.url))).toBe(false);
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain("miss (catch-all control inconclusive)");
    });

    it("a control that throws demotes the .md hit", async () => {
      serve(
        { "https://example.com/": () => html(), "https://example.com/index.md": () => md() },
        (_, url) => {
          if (CONTROL.test(url)) throw new TypeError("socket hang up");
          return notFound();
        },
      );
      const result = await run();
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain("miss (catch-all control inconclusive)");
    });

    it("a control that never answers is aborted by its own 5 s budget (not the probes' exhausted 10 s signal) and demotes the .md hit", async () => {
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeouts = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => realTimeout(ms === 5000 ? 20 : ms));
      const signals = new Map<string, AbortSignal | null | undefined>();
      serve(
        { "https://example.com/": () => html(), "https://example.com/index.md": () => md() },
        (_, url, init) => {
          signals.set(url, init?.signal);
          if (!CONTROL.test(url)) return notFound();
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          });
        },
      );
      const result = await run();
      expect(timeouts).toHaveBeenCalledWith(5000);
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain("miss (catch-all control inconclusive)");
      const controlSignal = [...signals].find(([url]) => CONTROL.test(url))?.[1];
      expect(controlSignal).toBeDefined();
      expect(controlSignal).not.toBe(signals.get("https://example.com/"));
    });

    it("a /docs/<slug>.md soft-404 route is caught by a control in the hit's own directory, even when the root 404s", async () => {
      const docs = { ...basePage, url: "https://example.com/docs/intro" };
      serve(
        { "https://example.com/": () => html(), "https://example.com/docs/intro": () => html() },
        (_, url) =>
          /^https:\/\/example\.com\/docs\/[^/]+\.md$/.test(url)
            ? md("# Page not found")
            : notFound(),
      );
      const result = await run([basePage, docs]);
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain(
        "docs page .md URL https://example.com/docs/intro.md: miss (nonexistent .md path also returns markdown (catch-all))",
      );
      expect(
        requests.some((r) => /^https:\/\/example\.com\/docs\/[0-9a-f-]{36}\.md$/.test(r.url)),
      ).toBe(true);
    });

    it.each([
      ["without a hook", {}],
      ["with an allowing hook", { isAllowedTarget: () => true }],
    ])("an /index.md that redirects to another origin's markdown soft-404 is controlled on that origin (%s)", async (_, ctx) => {
      serve(
        {
          "https://example.com/": () => html(),
          "https://example.com/index.md": () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://cdn.example.net/site/missing.md" },
            }),
        },
        (_, url) =>
          url.startsWith("https://cdn.example.net/site/") ? md("# Page not found") : notFound(),
      );
      const result = await run([basePage], {}, ctx);
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain("nonexistent .md path also returns markdown (catch-all)");
      expect(
        requests.some((r) => /^https:\/\/cdn\.example\.net\/site\/[0-9a-f-]{36}\.md$/.test(r.url)),
      ).toBe(true);
      expect(requests.some((r) => CONTROL.test(r.url))).toBe(false);
    });

    it("sends one control per directory of the .md hits' final URLs", async () => {
      const pages = [basePage, { ...basePage, url: "https://example.com/documentation" }];
      serve({
        "https://example.com/": () => html(),
        "https://example.com/index.md": () => md(),
        "https://example.com/documentation.md": () => md(),
      });
      expect(await run(pages)).toMatchObject({ status: "pass", score: 100 });
      expect(requests.filter((r) => /\/[0-9a-f-]{36}\.md$/.test(r.url)).map((r) => r.url)).toEqual([
        expect.stringMatching(CONTROL),
      ]);

      const docs = { ...basePage, url: "https://example.com/docs/intro/" };
      serve({
        "https://example.com/": () => html(),
        "https://example.com/index.md": () => md(),
        "https://example.com/docs/intro.md": () => md(),
      });
      expect(await run([basePage, docs])).toMatchObject({ status: "pass", score: 100 });
      const controls = requests.filter((r) => /\/[0-9a-f-]{36}\.md$/.test(r.url)).map((r) => r.url);
      expect(controls).toHaveLength(2);
      expect(controls.filter((u) => CONTROL.test(u))).toHaveLength(1);
      expect(
        controls.filter((u) => /^https:\/\/example\.com\/docs\/[0-9a-f-]{36}\.md$/.test(u)),
      ).toHaveLength(1);
    });

    it("demotes only the directory whose control returned markdown", async () => {
      const docs = { ...basePage, url: "https://docs.example.com/guide" };
      serve(
        {
          "https://example.com/": () => html(),
          "https://example.com/index.md": () => md(),
          "https://docs.example.com/guide": () => html(),
          "https://docs.example.com/guide.md": () => md(),
        },
        (_, url) => (url.startsWith("https://docs.example.com/") ? md("# Not found") : notFound()),
      );
      const result = await run([basePage, docs]);
      expect(result).toMatchObject({ status: "pass", score: 100 });
      expect(result.message).toContain(".md URL (homepage)");
      expect(result.message).not.toContain("docs page");
      expect(result.details).toContain(
        "docs page .md URL https://docs.example.com/guide.md: miss (nonexistent .md path also returns markdown (catch-all))",
      );
    });
  });

  describe("Accept negotiation that redirects", () => {
    const redirect = (headers: Record<string, string>) => () =>
      new Response(null, { status: 302, headers: { location: "/markdown", ...headers } });

    it.each([
      ["without a hook", {}],
      ["with an allowing hook", { isAllowedTarget: () => true }],
    ])("Vary: Accept on the negotiated URL's redirect passes — the redirect target is its own URL (%s)", async (_, ctx) => {
      serve({
        "https://example.com/": htmlUnlessMarkdown(redirect({ vary: "Accept" })),
        "https://example.com/markdown": () => md(),
      });
      const result = await run([basePage], {}, ctx);
      expect(result).toMatchObject({ status: "pass", score: 100 });
      expect(result.message).not.toContain("add Vary");
      expect(requests).toContainEqual({
        url: "https://example.com/markdown",
        accept: "text/markdown",
      });
    });

    it("an i18n redirect sent to everyone (no Vary) to a page that negotiates with Vary: Accept passes — the redirect doesn't depend on Accept", async () => {
      serve({
        "https://example.com/": () =>
          new Response(null, { status: 302, headers: { location: "/en/" } }),
        "https://example.com/en/": htmlUnlessMarkdown(md(MD, { vary: "Accept" })),
      });
      const result = await run();
      expect(result).toMatchObject({ status: "pass", score: 100 });
      expect(result.message).not.toContain("add Vary");
      expect(result.fixSnippet).toBeUndefined();
    });

    it("a redirect without Vary anywhere is partial", async () => {
      serve({
        "https://example.com/": htmlUnlessMarkdown(redirect({})),
        "https://example.com/markdown": () => md(),
      });
      expect(await run()).toMatchObject({ status: "partial", score: 50 });
    });

    it("the redirect target still has to be 2xx markdown", async () => {
      serve({
        "https://example.com/": htmlUnlessMarkdown(redirect({ vary: "Accept" })),
        "https://example.com/markdown": () => html(),
      });
      expect(await run()).toMatchObject({ status: "fail", score: 0 });
    });

    it("a redirect to a target refused by isAllowedTarget is a miss without throwing or fetching it", async () => {
      serve({
        "https://example.com/": htmlUnlessMarkdown(redirect({ vary: "Accept" })),
        "https://example.com/markdown": () => md(),
      });
      const result = await run(
        [basePage],
        {},
        {
          isAllowedTarget: (url: string) => url !== "https://example.com/markdown",
        },
      );
      expect(result).toMatchObject({ status: "fail", score: 0 });
      expect(result.details).toContain("miss (request failed");
      expect(requests.some((r) => r.url === "https://example.com/markdown")).toBe(false);
    });
  });
});
