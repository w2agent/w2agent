import { beforeEach, describe, expect, it } from "vitest";
import { generateLlmsTxt } from "../app/lib/generate";
import { getLlmsTxt, resetLlmsCache } from "../app/lib/llms-cache";

interface Deferred {
  resolve(res: Response): void;
  reject(error: Error): void;
  promise: Promise<Response>;
}

function deferred(): Deferred {
  let resolve!: (res: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function connection(root: string, hasNextPage: boolean) {
  return Response.json({
    data: {
      [root]: {
        edges: [{ node: { title: "T", handle: "t", onlineStoreUrl: "u", isPublished: true } }],
        pageInfo: { hasNextPage, endCursor: hasNextPage ? "c" : null },
      },
    },
  });
}

const shopOk = () =>
  Response.json({
    data: { shop: { name: "Acme", description: "", primaryDomain: { url: "https://a.test" } } },
  });

interface Call {
  root: string;
  signal?: AbortSignal;
}

function trackedAdmin(handler: (call: Call, index: number) => Promise<Response>) {
  const calls: Call[] = [];
  const admin = {
    graphql: (query: string, options?: { signal?: AbortSignal }) => {
      const root = query.includes("ShopInfo")
        ? "shop"
        : query.includes("Products")
          ? "products"
          : "pages";
      const call = { root, signal: options?.signal };
      calls.push(call);
      return handler(call, calls.length - 1);
    },
  };
  return { admin, calls };
}

describe("generateLlmsTxt failure containment", () => {
  it("requests no further pages after a sibling fails and aborts pending calls", async () => {
    const shop = deferred();
    const pending: Record<string, Deferred[]> = { products: [], pages: [] };
    const { admin, calls } = trackedAdmin((call) => {
      if (call.root === "shop") return shop.promise;
      const d = deferred();
      pending[call.root].push(d);
      return d.promise;
    });

    const run = generateLlmsTxt(admin);
    const outcome = run.then(
      () => "ok",
      (error: Error) => error.message,
    );
    await flush();
    expect(calls).toHaveLength(3);

    shop.reject(new Error("HTTP 500"));
    await flush();
    const pendingCalls = calls.filter((c) => c.root !== "shop");
    expect(pendingCalls).toHaveLength(2);
    for (const c of pendingCalls) expect(c.signal?.aborted).toBe(true);

    pending.products[0].resolve(connection("products", true));
    pending.pages[0].resolve(connection("pages", true));

    expect(await outcome).toBe("HTTP 500");
    await flush();
    expect(calls).toHaveLength(3);
  });
});

describe("generateLlmsTxt shop call", () => {
  it("aborts the pending ShopInfo call when pagination fails", async () => {
    const shop = deferred();
    const { admin, calls } = trackedAdmin((call) => {
      if (call.root === "shop") return shop.promise;
      return Promise.reject(new Error("throttled"));
    });

    const outcome = generateLlmsTxt(admin).then(
      () => "ok",
      (error: Error) => error.message,
    );
    await flush();
    expect(calls[0].root).toBe("shop");
    expect(calls[0].signal?.aborted).toBe(true);

    shop.resolve(shopOk());
    expect(await outcome).toBe("throttled");
  });
});

describe("llms cache with a failed scan", () => {
  beforeEach(() => resetLlmsCache());

  it("shares the in-flight scan until every call settles, then starts exactly one new scan", async () => {
    let shopFails = true;
    const held: Deferred[] = [];
    const { admin, calls } = trackedAdmin((call) => {
      if (call.root === "shop") {
        return shopFails ? Promise.reject(new Error("HTTP 500")) : Promise.resolve(shopOk());
      }
      if (!shopFails) return Promise.resolve(connection(call.root, false));
      const d = deferred();
      held.push(d);
      return d.promise;
    });
    const generate = () => generateLlmsTxt(admin);

    const first = getLlmsTxt("alpha", generate);
    const firstOutcome = first.then(
      () => "ok",
      (error: Error) => error.message,
    );
    await flush();
    expect(calls).toHaveLength(3);
    expect(held).toHaveLength(2);

    const second = getLlmsTxt("alpha", generate);
    expect(second).toBe(first);
    await flush();
    expect(calls).toHaveLength(3);

    for (const d of held) d.resolve(connection("products", false));
    expect(await firstOutcome).toBe("HTTP 500");

    shopFails = false;
    const third = getLlmsTxt("alpha", generate);
    expect(third).not.toBe(first);
    expect(await third).toContain("# Acme");
    expect(calls).toHaveLength(6);
  });
});
