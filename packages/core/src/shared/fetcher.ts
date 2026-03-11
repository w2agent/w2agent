import type { AuditOptions, FetchedPage } from "../audit/types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function retryableFetch(
  url: string,
  init: Omit<RequestInit, "signal">,
  timeout: number,
): Promise<Response | null> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });

      // Non-retryable status: return immediately (includes 2xx, 3xx, 4xx except 429, 5xx except 503)
      if (response.status !== 429 && response.status !== 503) {
        return response;
      }

      // Retryable status — if no retries left, discard body and return null
      if (attempt >= MAX_RETRIES) {
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
      const isRetryable =
        (err instanceof DOMException && err.name === "AbortError") || err instanceof TypeError; // ECONNRESET, ECONNREFUSED, ETIMEDOUT

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
  options: Pick<AuditOptions, "timeout" | "userAgent">,
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
  );

  if (!response) {
    return { url, status: 0, html: "", headers: {}, responseTime: Date.now() - start };
  }

  const html = await response.text();
  const responseTime = Date.now() - start;

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return { url, status: response.status, html, headers, responseTime };
}

export async function fetchText(
  url: string,
  options: Pick<AuditOptions, "timeout" | "userAgent">,
): Promise<{ text: string; status: number } | null> {
  const response = await retryableFetch(
    url,
    {
      headers: { "User-Agent": options.userAgent },
      redirect: "follow",
    },
    options.timeout,
  );

  if (!response) return null;

  const text = await response.text();
  return { text, status: response.status };
}

export async function checkContentNegotiation(
  url: string,
  options: Pick<AuditOptions, "timeout" | "userAgent">,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": options.userAgent,
        Accept: "text/markdown",
      },
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type") || "";
    return contentType.includes("text/markdown");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
