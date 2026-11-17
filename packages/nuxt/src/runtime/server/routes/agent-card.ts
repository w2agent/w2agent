import { createError, defineEventHandler, setResponseHeader } from "h3";
import { readAsset } from "../utils/read-asset";

export default defineEventHandler(async (event) => {
  const body =
    (await readAsset(".well-known/agent-card.json")) ?? (await readAsset("agent-card.json"));
  if (body === null) throw createError({ statusCode: 404, statusMessage: "Not Found" });
  setResponseHeader(event, "Content-Type", "application/json");
  setResponseHeader(event, "Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  return JSON.parse(body);
});
