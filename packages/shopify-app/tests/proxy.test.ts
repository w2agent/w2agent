import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appProxy = vi.fn();

vi.mock("../app/shopify.server", () => ({
  authenticate: { public: { appProxy: (...args: unknown[]) => appProxy(...args) } },
}));

import { resetLlmsCache } from "../app/lib/llms-cache";
import { loader } from "../app/routes/proxy.$";

const TTL_MS = 15 * 60 * 1000;

function makeAdmin(name: string, opts: { fail?: () => boolean; delayMs?: number } = {}) {
  const calls: string[] = [];
  const admin = {
    graphql: async (query: string) => {
      calls.push(
        query.includes("ShopInfo") ? "shop" : query.includes("Products") ? "products" : "pages",
      );
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail?.()) throw new Error("boom");
      const pageInfo = { hasNextPage: false, endCursor: null };
      if (query.includes("ShopInfo")) {
        return Response.json({
          data: {
            shop: { name, description: null, primaryDomain: { url: `https://${name}.example` } },
          },
        });
      }
      if (query.includes("Products")) {
        return Response.json({
          data: {
            products: {
              edges: [
                {
                  node: {
                    title: `${name} item`,
                    handle: "item",
                    onlineStoreUrl: "https://x",
                    descriptionHtml: "",
                  },
                },
              ],
              pageInfo,
            },
          },
        });
      }
      return Response.json({ data: { pages: { edges: [], pageInfo } } });
    },
  };
  return { admin, calls };
}

function hit(path = "/apps/w2agent/llms.txt") {
  return loader({
    request: new Request(`https://shop.example${path}?shop=attacker.myshopify.com`),
    params: {},
    context: {},
  } as never);
}

function as(shop: string, admin: unknown) {
  appProxy.mockResolvedValue({ admin, session: { shop } });
}

beforeEach(() => {
  appProxy.mockReset();
  resetLlmsCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("proxy loader", () => {
  it("serves llms.txt with a 15 minute public cache header", async () => {
    const { admin } = makeAdmin("alpha");
    as("alpha.myshopify.com", admin);
    const res = (await hit()) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=900");
    expect(await res.text()).toContain("# alpha");
  });

  it("serves a second hit inside the TTL without calling the Admin API", async () => {
    const { admin, calls } = makeAdmin("alpha");
    as("alpha.myshopify.com", admin);
    await hit();
    const n = calls.length;
    expect(n).toBe(3);
    const res = (await hit()) as Response;
    expect(calls.length).toBe(n);
    expect(await res.text()).toContain("# alpha");
  });

  it("rebuilds after the TTL expires", async () => {
    vi.useFakeTimers();
    const { admin, calls } = makeAdmin("alpha");
    as("alpha.myshopify.com", admin);
    await hit();
    vi.advanceTimersByTime(TTL_MS - 1000);
    await hit();
    expect(calls.length).toBe(3);
    vi.advanceTimersByTime(2000);
    await hit();
    expect(calls.length).toBe(6);
  });

  it("keys the cache by the verified shop, not the query string", async () => {
    const a = makeAdmin("alpha");
    const b = makeAdmin("beta");
    as("alpha.myshopify.com", a.admin);
    const resA = (await hit()) as Response;
    as("beta.myshopify.com", b.admin);
    const resB = (await hit()) as Response;
    const textA = await resA.text();
    const textB = await resB.text();
    expect(textA).toContain("# alpha");
    expect(textA).not.toContain("beta");
    expect(textB).toContain("# beta");
    expect(textB).not.toContain("alpha");
    expect(b.calls.length).toBe(3);
  });

  it("shares one scan between concurrent hits for a shop", async () => {
    const { admin, calls } = makeAdmin("alpha", { delayMs: 10 });
    as("alpha.myshopify.com", admin);
    const results = (await Promise.all([hit(), hit(), hit()])) as Response[];
    expect(calls.length).toBe(3);
    for (const r of results) expect(await r.text()).toContain("# alpha");
  });

  it("serves the stale body when a rebuild fails", async () => {
    vi.useFakeTimers();
    let failing = false;
    const { admin } = makeAdmin("alpha", { fail: () => failing });
    as("alpha.myshopify.com", admin);
    await hit();
    vi.advanceTimersByTime(TTL_MS + 1000);
    failing = true;
    const res = (await hit()) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("# alpha");
    expect(console.error).toHaveBeenCalled();
  });

  it("returns 503 with Retry-After and no-store when there is nothing cached, then retries", async () => {
    let failing = true;
    const { admin, calls } = makeAdmin("alpha", { fail: () => failing });
    as("alpha.myshopify.com", admin);
    const res = (await hit()) as Response;
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const failedCalls = calls.length;
    failing = false;
    const ok = (await hit()) as Response;
    expect(ok.status).toBe(200);
    expect(calls.length).toBeGreaterThan(failedCalls);
    expect(await ok.text()).toContain("# alpha");
  });

  it("does not log tokens when generation fails", async () => {
    const { admin } = makeAdmin("alpha", { fail: () => true });
    as("alpha.myshopify.com", admin);
    await hit();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("alpha.myshopify.com");
    expect(logged).not.toMatch(/accessToken/i);
  });

  it("does not share a failed in-flight scan with later hits", async () => {
    let failing = true;
    const { admin } = makeAdmin("alpha", { fail: () => failing, delayMs: 5 });
    as("alpha.myshopify.com", admin);
    const [r1, r2] = (await Promise.all([hit(), hit()])) as Response[];
    expect(r1.status).toBe(503);
    expect(r2.status).toBe(503);
    failing = false;
    expect(((await hit()) as Response).status).toBe(200);
  });

  it("passes a Response thrown by authenticate through unchanged", async () => {
    const thrown = new Response("Bad signature", { status: 400 });
    appProxy.mockRejectedValue(thrown);
    await expect(hit()).rejects.toBe(thrown);
  });

  it("does not turn an authenticate failure into a 503 or stale hit", async () => {
    const { admin } = makeAdmin("alpha");
    as("alpha.myshopify.com", admin);
    await hit();
    const thrown = new Response("Unauthorized", { status: 401 });
    appProxy.mockRejectedValue(thrown);
    await expect(hit()).rejects.toBe(thrown);
  });

  it("returns 401 when the app is not installed", async () => {
    appProxy.mockResolvedValue({ admin: undefined, session: undefined });
    const res = (await hit()) as Response;
    expect(res.status).toBe(401);
  });

  it("returns 404 for other paths", async () => {
    const { admin, calls } = makeAdmin("alpha");
    as("alpha.myshopify.com", admin);
    const res = (await hit("/apps/w2agent/other")) as Response;
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });
});
