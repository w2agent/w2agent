import type { APIRoute } from "astro";

const unauthorized = (message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

export const POST: APIRoute = async ({ request }) => {
  const expected = process.env.W2AGENT_INBOUND_TOKEN;
  if (!expected) return unauthorized("W2AGENT_INBOUND_TOKEN not configured");
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented !== expected) return unauthorized("unauthorized");

  const webhookUrl =
    process.env.W2AGENT_WEBHOOK_URL ?? "https://w2agent.dev/api/agent/webhook/YOUR_SLUG";
  const webhookToken = process.env.W2AGENT_WEBHOOK_TOKEN ?? "";

  try {
    const body = await request.json().catch(() => ({}));
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(webhookToken ? { Authorization: `Bearer ${webhookToken}` } : {}),
      },
      body: JSON.stringify({ trigger: "astro", ...body }),
    });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
