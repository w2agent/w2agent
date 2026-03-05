import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalUrls,
  charsetUtf8,
  httpsCheck,
  mobileViewport,
  noJsDependency,
  securityHeaders,
} from "../../src/audit/checks/technical.js";
import type { FetchedPage, SiteMetadata } from "../../src/audit/types.js";

const baseMeta: SiteMetadata = {
  baseUrl: "https://example.com",
  wellKnown: {},
};

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, "../fixtures", name), "utf-8");
}

const basePage: FetchedPage = {
  url: "https://example.com",
  status: 200,
  html: "<html><body>test</body></html>",
  headers: {},
  responseTime: 100,
};

describe("https", () => {
  it("passes for HTTPS pages", () => {
    const result = httpsCheck.run([basePage], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("fails for HTTP pages", () => {
    const result = httpsCheck.run([{ ...basePage, url: "http://example.com" }], baseMeta);
    expect(result).toMatchObject({ status: "fail", score: 0 });
  });
});

describe("security-headers", () => {
  it("passes with all security headers", () => {
    const page: FetchedPage = {
      ...basePage,
      headers: {
        "content-security-policy": "default-src 'self'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "strict-transport-security": "max-age=31536000",
      },
    };
    const result = securityHeaders.run([page], baseMeta);
    expect(result).toMatchObject({ status: "pass", score: 100 });
  });

  it("partial with some headers", () => {
    const page: FetchedPage = {
      ...basePage,
      headers: { "x-frame-options": "DENY" },
    };
    const result = securityHeaders.run([page], baseMeta);
    expect(result.score).toBe(25);
  });
});

describe("canonical-urls", () => {
  it("passes with canonical URLs", () => {
    const html = loadFixture("basic-page.html");
    const result = canonicalUrls.run([{ ...basePage, html }], baseMeta);
    expect(result.score).toBe(100);
  });

  it("fails without canonical", () => {
    const result = canonicalUrls.run([basePage], baseMeta);
    expect(result.score).toBe(0);
  });
});

describe("mobile-viewport", () => {
  it("passes with viewport", () => {
    const html = loadFixture("basic-page.html");
    const result = mobileViewport.run([{ ...basePage, html }], baseMeta);
    expect(result.score).toBe(100);
  });
});

describe("charset-utf8", () => {
  it("passes with charset meta", () => {
    const html = loadFixture("basic-page.html");
    const result = charsetUtf8.run([{ ...basePage, html }], baseMeta);
    expect(result.score).toBe(100);
  });

  it("passes with charset header", () => {
    const page: FetchedPage = {
      ...basePage,
      headers: { "content-type": "text/html; charset=utf-8" },
    };
    const result = charsetUtf8.run([page], baseMeta);
    expect(result.score).toBe(100);
  });
});

describe("no-js-dependency", () => {
  it("passes when content accessible without JS", () => {
    const html = loadFixture("basic-page.html");
    const result = noJsDependency.run([{ ...basePage, html }], baseMeta);
    expect(result.score).toBe(100);
  });

  it("fails with minimal content", () => {
    const result = noJsDependency.run(
      [{ ...basePage, html: '<html><body><div id="app"></div></body></html>' }],
      baseMeta,
    );
    expect(result.score).toBe(0);
  });
});
