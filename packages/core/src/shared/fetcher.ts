import type { AuditOptions, FetchedPage } from "../audit/types.js";

export const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_TEXT_BYTES = 1 * 1024 * 1024; // 1 MB

export async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;

      const space = maxBytes - total;
      if (value.length >= space) {
        chunks.push(value.slice(0, space));
        total += space;
        break;
      }

      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(buf);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type IsAllowedTarget = NonNullable<AuditOptions["isAllowedTarget"]>;

export class TargetNotAllowedError extends Error {
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`Fetch target not allowed: ${url} (${reason})`);
    this.name = "TargetNotAllowedError";
  }
}

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const BODY_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
];

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function assertAllowedTarget(
  url: string,
  isAllowedTarget: IsAllowedTarget,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new TargetNotAllowedError(url, "invalid URL");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new TargetNotAllowedError(url, `unsupported protocol ${protocol}`);
  }
  const verdict = Promise.resolve()
    .then(() => isAllowedTarget(url))
    .then(
      (allowed) => allowed === true,
      () => false,
    );
  // A hook slower than the caller's timeout must abort like a slow fetch would.
  const allowed = await untilAborted(verdict, signal);
  if (!allowed) throw new TargetNotAllowedError(url, "refused by isAllowedTarget");
}

export async function guardedFetch(
  url: string,
  init: RequestInit = {},
  isAllowedTarget?: IsAllowedTarget,
): Promise<Response> {
  if (!isAllowedTarget) return fetch(url, init);

  await assertAllowedTarget(url, isAllowedTarget, init.signal);
  if ((init.redirect ?? "follow") !== "follow") return fetch(url, init);

  let current = url;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  let headers = init.headers;
  let redirects = 0;

  while (true) {
    const response = await fetch(current, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;

    await response.body?.cancel().catch(() => {});

    if (redirects >= MAX_REDIRECTS) {
      throw new TargetNotAllowedError(current, `more than ${MAX_REDIRECTS} redirects`);
    }
    redirects++;

    let next: string;
    try {
      next = new URL(location, current).href;
    } catch {
      throw new TargetNotAllowedError(location, "invalid redirect Location");
    }
    await assertAllowedTarget(next, isAllowedTarget, init.signal);

    const stripped: string[] = [];
    if (new URL(next).origin !== new URL(current).origin) {
      stripped.push(...CROSS_ORIGIN_STRIPPED_HEADERS);
    }
    if (
      ((response.status === 301 || response.status === 302) && method === "POST") ||
      (response.status === 303 && method !== "GET" && method !== "HEAD")
    ) {
      method = "GET";
      body = undefined;
      stripped.push(...BODY_HEADERS);
    }
    if (stripped.length > 0 && headers !== undefined) {
      const kept = new Headers(headers);
      for (const name of stripped) kept.delete(name);
      headers = kept;
    }
    current = next;
  }
}

async function retryableFetch(
  url: string,
  init: Omit<RequestInit, "signal">,
  timeout: number,
  isAllowedTarget?: IsAllowedTarget,
  exhausted?: { status: number },
): Promise<Response | null> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await guardedFetch(
        url,
        { ...init, signal: controller.signal },
        isAllowedTarget,
      );

      // Non-retryable status: return immediately (includes 2xx, 3xx, 4xx except 429, 5xx except 503)
      if (response.status !== 429 && response.status !== 503) {
        return response;
      }

      // Retryable status — if no retries left, discard body and return null
      if (attempt >= MAX_RETRIES) {
        if (exhausted) exhausted.status = response.status;
        await response.body?.cancel();
        return null;
      }

      // Calculate backoff delay
      let delayMs = 500 * 2 ** attempt; // 500ms, 1000ms, 2000ms
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("retry-after");
        if (retryAfterHeader) {
          const seconds = Number(retryAfterHeader);
          const retryAfterMs = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfterHeader) - Date.now();
          if (retryAfterMs > 0 && retryAfterMs <= 30_000) {
            delayMs = retryAfterMs;
          }
        }
      }

      await response.body?.cancel();
      await sleep(delayMs);
    } catch (err) {
      // Only retry timeouts. TypeError (DNS fail, ECONNREFUSED, host unreachable)
      // almost never recovers on retry and burns ~4× timeout for nothing.
      const isRetryable = err instanceof DOMException && err.name === "AbortError";

      if (!isRetryable || attempt >= MAX_RETRIES) {
        return null; // exhausted or non-retryable — callers treat null as failure
      }

      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

export async function fetchPage(
  url: string,
  options: Pick<AuditOptions, "timeout" | "userAgent" | "isAllowedTarget">,
): Promise<FetchedPage> {
  const start = Date.now();

  const response = await retryableFetch(
    url,
    {
      headers: {
        "User-Agent": options.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    },
    options.timeout,
    options.isAllowedTarget,
  );

  const html = response ? await readBodyCapped(response, MAX_HTML_BYTES).catch(() => null) : null;
  if (!response || html === null) {
    return { url, status: 0, html: "", headers: {}, responseTime: Date.now() - start };
  }

  const responseTime = Date.now() - start;

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return { url, status: response.status, html, headers, responseTime };
}

export async function fetchText(
  url: string,
  options: Pick<AuditOptions, "timeout" | "userAgent" | "isAllowedTarget">,
  request: { accept?: string; retriesExhausted?: { status: number } } = {},
): Promise<{ text: string; status: number; contentType: string } | null> {
  const response = await retryableFetch(
    url,
    {
      headers: {
        "User-Agent": options.userAgent,
        ...(request.accept ? { Accept: request.accept } : {}),
      },
      redirect: "follow",
    },
    options.timeout,
    options.isAllowedTarget,
    request.retriesExhausted,
  );

  if (!response) return null;

  const text = await readBodyCapped(response, MAX_TEXT_BYTES).catch(() => null);
  if (text === null) return null;
  return { text, status: response.status, contentType: response.headers.get("content-type") ?? "" };
}
