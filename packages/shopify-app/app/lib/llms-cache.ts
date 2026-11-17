export const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_SHOPS = 500;

interface Entry {
  body: string;
  at: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string>>();

export function resetLlmsCache() {
  cache.clear();
  inflight.clear();
}

function store(shop: string, body: string) {
  cache.delete(shop);
  cache.set(shop, { body, at: Date.now() });
  while (cache.size > MAX_SHOPS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function getStale(shop: string): string | undefined {
  return cache.get(shop)?.body;
}

export function getLlmsTxt(shop: string, generate: () => Promise<string>): Promise<string> {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.body);

  const pending = inflight.get(shop);
  if (pending) return pending;

  const run = generate()
    .then((body) => {
      store(shop, body);
      return body;
    })
    .finally(() => {
      inflight.delete(shop);
    });
  inflight.set(shop, run);
  return run;
}
