import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createError, defineEventHandler, setResponseHeader } from "h3";

export default defineEventHandler((event) => {
  const candidates = [
    join(process.cwd(), "public", ".well-known", "agent-card.json"),
    join(process.cwd(), "public", "agent-card.json"),
  ];
  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      setResponseHeader(event, "Content-Type", "application/json");
      setResponseHeader(
        event,
        "Cache-Control",
        "public, max-age=3600, stale-while-revalidate=86400",
      );
      return JSON.parse(readFileSync(filePath, "utf-8"));
    }
  }
  throw createError({ statusCode: 404, statusMessage: "Not Found" });
});
