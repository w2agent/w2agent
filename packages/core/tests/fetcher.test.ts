import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPage, fetchText } from "../src/shared/fetcher.js";

const opts = { timeout: 5000, userAgent: "test" };

function mockResponse(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe("fetchPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns page on 200 with no retry", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse(200, "<html>ok</html>"));
    const result = await fetchPage("https://example.com", opts);
    expect(result.status).toBe(200);
    expect(result.html).toBe("<html>ok</html>");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns page immediately on 404 with no retry", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse(404));
    const result = await fetchPage("https://example.com", opts);
    expect(result.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds on 2nd attempt", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(mockResponse(200, "<html>ok</html>"));
    const promise = fetchPage("https://example.com", opts);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 and succeeds on 3rd attempt", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(200, "<html>ok</html>"));
    const promise = fetchPage("https://example.com", opts);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries on AbortError (timeout) and succeeds on retry", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    vi.mocked(fetch)
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(mockResponse(200, "<html>ok</html>"));
    const promise = fetchPage("https://example.com", opts);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on TypeError (network error) and succeeds on retry", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(mockResponse(200, "<html>ok</html>"));
    const promise = fetchPage("https://example.com", opts);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns status 0 after exhausting all 4 attempts on 429", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse(429));
    const promise = fetchPage("https://example.com", opts);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe(0);
    expect(result.html).toBe("");
    expect(fetch).toHaveBeenCalledTimes(4); // attempt 0, 1, 2, 3
  });

  it("uses Retry-After header delay instead of default backoff on 429", async () => {
    // Retry-After: 3 → 3000ms delay, vs default 500ms for attempt 0
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(429, "", { "retry-after": "3" }))
      .mockResolvedValueOnce(mockResponse(200, "<html>ok</html>"));

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const promise = fetchPage("https://example.com", opts);
    await vi.runAllTimersAsync();
    await promise;

    // Filter out the abort timer (opts.timeout = 5000ms) and other noise.
    // The sleep call should be 3000ms (Retry-After: 3).
    const sleepCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 3000);
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores Retry-After header values over 30s (uses normal backoff)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(429, "", { "retry-after": "60" })) // 60s > 30s cap
      .mockResolvedValueOnce(mockResponse(200, "<html>ok</html>"));

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const promise = fetchPage("https://example.com", opts);
    await vi.runAllTimersAsync();
    await promise;

    // Should use default backoff (500ms for attempt 0), not 60000ms
    const tooBigCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 60000);
    expect(tooBigCalls).toHaveLength(0);
    const defaultBackoffCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 500);
    expect(defaultBackoffCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("fetchText", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns text and status on success", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse(200, "User-agent: *"));
    const result = await fetchText("https://example.com/robots.txt", opts);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(200);
    expect(result?.text).toBe("User-agent: *");
  });

  it("retries on 429 and returns text on success", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(mockResponse(200, "content"));
    const promise = fetchText("https://example.com/robots.txt", opts);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result?.text).toBe("content");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns null after exhausting retries on 503", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse(503));
    const promise = fetchText("https://example.com/sitemap.xml", opts);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("returns null on network error after all retries", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("ECONNRESET"));
    const promise = fetchText("https://example.com/robots.txt", opts);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
