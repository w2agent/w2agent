import { createError, defineEventHandler, getHeader, readBody } from "h3";

export default defineEventHandler(async (event) => {
  const expected = process.env.W2AGENT_INBOUND_TOKEN;
  if (!expected) {
    throw createError({ statusCode: 401, statusMessage: "W2AGENT_INBOUND_TOKEN not configured" });
  }
  const header = getHeader(event, "authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented !== expected) {
    throw createError({ statusCode: 401, statusMessage: "unauthorized" });
  }

  const webhookUrl =
    process.env.W2AGENT_WEBHOOK_URL ?? "https://w2agent.dev/api/agent/webhook/YOUR_SLUG";
  const webhookToken = process.env.W2AGENT_WEBHOOK_TOKEN ?? "";

  try {
    const body = await readBody(event);
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(webhookToken ? { Authorization: `Bearer ${webhookToken}` } : {}),
      },
      body: JSON.stringify({ trigger: "nuxt", ...body }),
    });
    return { ok: true };
  } catch (err) {
    event.node.res.statusCode = 500;
    return { error: (err as Error).message };
  }
});
