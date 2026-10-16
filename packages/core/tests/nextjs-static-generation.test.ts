import { describe, expect, it } from "vitest";
import { nextjsStaticGenerationCheck } from "../src/adapters/nextjs/checks.js";
import type { FetchedPage } from "../src/audit/types.js";

function page(headers: Record<string, string> = {}, html = "<html><body>hi</body></html>") {
  return {
    url: "https://example.com/",
    status: 200,
    html,
    headers,
    responseTime: 10,
  } as FetchedPage;
}

const nextData = (flags: string) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{},"page":"/",${flags}}</script></body></html>`;

const run = (pages: FetchedPage[]) =>
  nextjsStaticGenerationCheck.run(pages, { baseUrl: "https://example.com", wellKnown: {} }) as {
    status: string;
    score: number;
    message: string;
  };

const prerendered = () => page({ "x-nextjs-prerender": "1", "x-nextjs-cache": "HIT" });
const dynamic = () => page({ "cache-control": "private, no-cache, no-store, max-age=0" });

describe("nextjs-static-generation", () => {
  it("passes for App Router prerendered pages", () => {
    const r = run([prerendered(), prerendered(), page({ "x-vercel-cache": "hit" })]);
    expect(r).toMatchObject({ status: "pass", score: 100 });
    expect(r.message).toContain("3/3");
  });

  it.each([
    ["x-nextjs-cache STALE", { "x-nextjs-cache": "STALE" }],
    ["x-vercel-cache PRERENDER", { "x-vercel-cache": "PRERENDER" }],
    ["x-vercel-cache REVALIDATED", { "x-vercel-cache": "REVALIDATED" }],
    ["comma-joined HIT, HIT", { "x-vercel-cache": "HIT, HIT" }],
    ["comma-joined MISS, HIT", { "x-vercel-cache": "MISS, HIT" }],
    ["x-nextjs-prerender", { "x-nextjs-prerender": "1" }],
    ["s-maxage", { "cache-control": "s-maxage=31536000, stale-while-revalidate" }],
    ["public", { "cache-control": "public, max-age=0, must-revalidate" }],
  ])("%s is static evidence on its own", (_name, headers) => {
    const r = run([page(headers), dynamic()]);
    expect(r.message).toContain("1/2");
  });

  it("MISS-only and no-cache-only pages carry no static evidence", () => {
    const r = run([
      page({ "x-vercel-cache": "MISS" }),
      page({ "cache-control": "no-cache" }),
      dynamic(),
    ]);
    expect(r.message).toContain("0/1");
  });

  it("is partial 60 when most pages are dynamic", () => {
    const r = run([dynamic(), dynamic(), page({ "cache-control": "no-store" })]);
    expect(r).toMatchObject({ status: "partial", score: 60 });
    expect(r.message).toContain("0/3");
  });

  it("mixed site (1 prerendered, 9 dynamic) is partial 60 and reports the fraction", () => {
    const r = run([prerendered(), ...Array.from({ length: 9 }, dynamic)]);
    expect(r).toMatchObject({ status: "partial", score: 60 });
    expect(r.message).toContain("1/10");
  });

  it("one dynamic page no longer vetoes a mostly static site", () => {
    const r = run([prerendered(), prerendered(), prerendered(), dynamic()]);
    expect(r).toMatchObject({ status: "pass", score: 100 });
    expect(r.message).toContain("3/4");
  });

  it.each([
    "private, max-age=60",
    "no-store",
    "private, no-cache, no-store",
  ])("cache-control %s is dynamic evidence", (cc) => {
    expect(run([page({ "cache-control": cc })]).message).toContain("0/1");
  });

  it("a lone no-cache does not override build-time static evidence (S3/CloudFront export)", () => {
    const headers = { "cache-control": "no-cache" };
    expect(run([page(headers, nextData('"nextExport":true'))]).message).toContain("1/1");
    expect(run([page(headers, nextData('"autoExport":true'))]).message).toContain("1/1");
    expect(run([page({ ...headers, "x-nextjs-prerender": "1" })]).message).toContain("1/1");
  });

  it("custom _app getInitialProps (appGip) is dynamic even with host-default public cache-control", () => {
    const cc = { "cache-control": "public, max-age=0, must-revalidate" };
    const r = run([page(cc, nextData('"appGip":true')), page(cc, nextData('"appGip":true'))]);
    expect(r).toMatchObject({ status: "partial", score: 60 });
    expect(r.message).toContain("0/2");
  });

  it("getStaticProps pages stay static under a custom _app (appGip + gsp)", () => {
    const r = run([page({}, nextData('"appGip":true,"gsp":true'))]);
    expect(r).toMatchObject({ status: "pass" });
    expect(r.message).toContain("1/1");
  });

  it("passes at exactly 50% static", () => {
    expect(run([prerendered(), dynamic()]).status).toBe("pass");
  });

  it("passes for Pages Router SSG (gsp)", () => {
    const r = run([page({}, nextData('"gsp":true')), page({}, nextData('"gsp":true'))]);
    expect(r.status).toBe("pass");
  });

  it("passes for auto-static optimized Pages Router pages (nextExport)", () => {
    expect(run([page({}, nextData('"nextExport":true'))]).status).toBe("pass");
  });

  it("does not count Pages Router SSR (gssp) as static", () => {
    const r = run([page({}, nextData('"gssp":true')), page({}, nextData('"gssp":true'))]);
    expect(r).toMatchObject({ status: "partial", score: 60 });
    expect(r.message).toContain("0/2");
  });

  it("does not count getInitialProps (gip) as static", () => {
    expect(run([page({}, nextData('"gip":true'))]).status).toBe("partial");
  });

  it("bare __NEXT_DATA__ without flags is not evidence", () => {
    const r = run([page({}, nextData('"buildId":"x"'))]);
    expect(r.status).toBe("partial");
    expect(r.message).toContain("No static-generation evidence");
  });

  it("gssp text outside the __NEXT_DATA__ script is ignored", () => {
    const html = `${nextData('"gsp":true')}<p>"gssp":true</p>`;
    expect(run([page({}, html)]).status).toBe("pass");
  });

  it("a cache MISS alone is not dynamic evidence", () => {
    const r = run([
      prerendered(),
      page({ "x-vercel-cache": "MISS" }),
      page({ "x-nextjs-cache": "MISS" }),
    ]);
    expect(r.status).toBe("pass");
    expect(r.message).toContain("1/1");
  });

  it("dynamic cache-control wins within a page", () => {
    const r = run([page({ "x-nextjs-cache": "HIT", "cache-control": "private, max-age=0" })]);
    expect(r.status).toBe("partial");
    expect(r.message).toContain("0/1");
  });

  it("is partial when there are no pages", () => {
    expect(run([])).toMatchObject({ status: "partial", score: 60 });
  });
});
