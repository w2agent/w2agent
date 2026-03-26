import { defineEventHandler, readBody } from "h3";

const WEBHOOK_URL =
  process.env.W2AGENT_WEBHOOK_URL ?? "https://w2agent.dev/api/agent/webhook/YOUR_SLUG";
const WEBHOOK_TOKEN = process.env.W2AGENT_WEBHOOK_TOKEN ?? "";

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody(event);
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(WEBHOOK_TOKEN ? { Authorization: `Bearer ${WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify({ trigger: "nuxt", ...body }),
    });
    return { ok: true };
  } catch (err) {
    event.node.res.statusCode = 500;
    return { error: (err as Error).message };
  }
});
