import { createApp, defineEventHandler, toWebHandler } from "h3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACCEPT_CASES,
  BASE_URL,
  BASE_URL_ACCEPTS,
  BASE_URL_CASES,
  RUNTIME_BASE_URLS,
} from "../../core/tests/helpers/accept-cases";
import contentNegotiation from "../src/runtime/server/middleware/content-negotiation";
import indexMd from "../src/runtime/server/routes/index-md";
import { setAssets, setBaseURL } from "./stubs/imports";

// The w2agent audit's content-negotiation check needs Accept: text/markdown at / to end in
// a 2xx text/markdown body, with Vary: Accept on the redirect so caches keep browsers on HTML.
function handler() {
  const app = createApp();
  app.use(contentNegotiation);
  app.use("/index.md", indexMd);
  app.use("/", () => "<!doctype html><html><body>home</body></html>");
  return toWebHandler(app);
}

const request = (path: string, accept: string | null) =>
  handler()(
    new Request(`http://localhost${path}`, {
      headers: accept === null ? {} : { accept },
      redirect: "manual",
    }),
  );

const TARGETS = { markdown: "/index.md", plain: "/llms.txt" } as const;

describe("content negotiation middleware + /index.md route", () => {
  beforeEach(() => {
    setAssets({ "llms.txt": "# Example\n\n> Index\n" });
  });

  it("serves /index.md as text/markdown with the llms.txt content", async () => {
    const res = await request("/index.md", "text/markdown");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe("# Example\n\n> Index\n");
  });

  describe("under app.baseURL (Nitro strips the base by prefix)", () => {
    const inner = createApp();
    inner.use(contentNegotiation);
    inner.use(() => "<!doctype html><html><body>home</body></html>");
    const baseApp = createApp();
    baseApp.use(BASE_URL, inner.handler);
    const baseWeb = toWebHandler(baseApp);

    afterEach(() => setBaseURL("/"));

    for (const runtimeBase of RUNTIME_BASE_URLS) {
      for (const c of BASE_URL_CASES.flatMap((row) =>
        BASE_URL_ACCEPTS.map((a) => ({ ...row, ...a })),
      )) {
        it(`baseURL ${runtimeBase}: ${c.path} with Accept: ${c.accept} -> ${c.branch}`, async () => {
          setBaseURL(runtimeBase);
          const res = await baseWeb(
            new Request(`http://localhost${c.path}`, {
              headers: { accept: c.accept },
              redirect: "manual",
            }),
          );
          if (c.branch === "untouched") {
            expect(res.status).toBe(200);
            expect(res.headers.get("vary")).toBeNull();
            return;
          }
          expect(res.status).toBe(302);
          expect(res.headers.get("location")).toBe(`${BASE_URL}/${c.file}`);
          expect(res.headers.get("vary") ?? "").toMatch(/Accept/i);
        });
      }
    }
  });

  it("appends to an existing Vary instead of replacing it", async () => {
    const app = createApp();
    app.use(
      defineEventHandler((event) => {
        event.node.res.setHeader("Vary", "Cookie");
      }),
    );
    app.use(contentNegotiation);
    app.use(() => "<html></html>");
    const res = await toWebHandler(app)(new Request("http://localhost/"));
    const vary = (res.headers.get("vary") ?? "").split(/,\s*/);
    expect(vary).toContain("Cookie");
    expect(vary).toContain("Accept");
  });

  describe("Accept negotiation (NU-4)", () => {
    for (const c of ACCEPT_CASES) {
      it(`${c.name} -> ${c.branch}`, async () => {
        const res = await request(c.path, c.accept);
        if (c.branch === "untouched") {
          expect(res.status).toBe(200);
          expect(res.headers.get("vary")).toBeNull();
          return;
        }
        expect(res.headers.get("vary") ?? "").toMatch(/(^|,\s*)Accept(\s*,|$)/i);
        if (c.branch === "html") {
          expect(res.status).toBe(200);
          expect(await res.text()).toContain("<html>");
          return;
        }
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(TARGETS[c.branch]);
      });
    }
  });
});
