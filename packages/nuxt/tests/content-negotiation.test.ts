import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import * as fs from "node:fs";
import contentNegotiation from "../src/runtime/server/middleware/content-negotiation";
import indexMd from "../src/runtime/server/routes/index-md";

const mockFs = vi.mocked(fs);

// The w2agent audit's content-negotiation check needs Accept: text/markdown at / to end in
// a 2xx text/markdown body, with Vary: Accept on the redirect so caches keep browsers on HTML.
function handler() {
  const app = createApp();
  app.use(contentNegotiation);
  app.use("/index.md", indexMd);
  app.use("/", () => "<!doctype html><html><body>home</body></html>");
  return toWebHandler(app);
}

const get = (path: string, accept: string) =>
  handler()(new Request(`http://localhost${path}`, { headers: { accept } }));

describe("content negotiation middleware + /index.md route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("# Example\n\n> Index\n" as never);
  });

  it("redirects Accept: text/markdown at / to /index.md with Vary: Accept", async () => {
    const res = await get("/", "text/markdown");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/index.md");
    expect(res.headers.get("vary")).toBe("Accept");
  });

  it("serves /index.md as text/markdown with the llms.txt content", async () => {
    const res = await get("/index.md", "text/markdown");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe("# Example\n\n> Index\n");
  });

  it("still sends Accept: text/plain at / to /llms.txt", async () => {
    const res = await get("/", "text/plain");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/llms.txt");
  });

  it("leaves browsers on the HTML homepage", async () => {
    const res = await get("/", "text/html");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<html>");
  });
});
