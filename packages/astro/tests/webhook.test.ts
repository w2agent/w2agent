import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/routes/webhook";

// Minimal typed call surface for the handler — the real APIContext has many
// more fields, but we only construct `request`.
type WebhookHandler = (ctx: { request: Request }) => Promise<Response>;
const handler = POST as unknown as WebhookHandler;

describe("Astro webhook relay — inbound auth", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function makePostRequest(authHeader?: string): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authHeader !== undefined) headers.authorization = authHeader;
    return new Request("https://example.com/api/w2agent-webhook", {
      method: "POST",
      headers,
      body: JSON.stringify({ trigger: "test" }),
    });
  }

  it("returns 401 when W2AGENT_INBOUND_TOKEN is not configured", async () => {
    const res = await handler({ request: makePostRequest("Bearer anything") });
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", async () => {
    vi.stubEnv("W2AGENT_INBOUND_TOKEN", "secret-123");
    const res = await handler({ request: makePostRequest() });
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 401 when bearer token does not match", async () => {
    vi.stubEnv("W2AGENT_INBOUND_TOKEN", "secret-123");
    const res = await handler({ request: makePostRequest("Bearer wrong-token") });
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forwards upstream when bearer token matches", async () => {
    vi.stubEnv("W2AGENT_INBOUND_TOKEN", "secret-123");
    vi.stubEnv("W2AGENT_WEBHOOK_URL", "https://upstream.example/hook");
    const res = await handler({ request: makePostRequest("Bearer secret-123") });
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://upstream.example/hook",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
