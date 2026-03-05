import type { AuditOptions, FetchedPage } from "../audit/types.js";

export async function fetchPage(
  url: string,
  options: Pick<AuditOptions, "timeout" | "userAgent">,
): Promise<FetchedPage> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": options.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });

    const html = await response.text();
    const responseTime = Date.now() - start;

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return { url, status: response.status, html, headers, responseTime };
  } catch (err) {
    const responseTime = Date.now() - start;
    if (err instanceof DOMException && err.name === "AbortError") {
      return { url, status: 0, html: "", headers: {}, responseTime };
    }
    return { url, status: 0, html: "", headers: {}, responseTime };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(
  url: string,
  options: Pick<AuditOptions, "timeout" | "userAgent">,
): Promise<{ text: string; status: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": options.userAgent },
      redirect: "follow",
    });
    const text = await response.text();
    return { text, status: response.status };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
