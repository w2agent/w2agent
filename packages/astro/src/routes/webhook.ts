import type { APIRoute } from "astro";

const WEBHOOK_URL =
  process.env.W2AGENT_WEBHOOK_URL ?? "https://w2agent.dev/api/agent/webhook/YOUR_SLUG";
const WEBHOOK_TOKEN = process.env.W2AGENT_WEBHOOK_TOKEN ?? "";

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(WEBHOOK_TOKEN ? { Authorization: `Bearer ${WEBHOOK_TOKEN}` } : {}),
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
