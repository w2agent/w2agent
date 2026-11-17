import { createError, defineEventHandler, setResponseHeader } from "h3";
import { readAsset } from "../utils/read-asset";

export default defineEventHandler(async (event) => {
  const body = await readAsset("llms-full.txt");
  if (body === null) throw createError({ statusCode: 404, statusMessage: "Not Found" });
  setResponseHeader(event, "Content-Type", "text/plain; charset=utf-8");
  setResponseHeader(event, "Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  return body;
});
