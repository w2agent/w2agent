import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";

export const GET: APIRoute = () => {
  const candidates = [
    join(process.cwd(), "public", ".well-known", "agent-card.json"),
    join(process.cwd(), "public", "agent-card.json"),
  ];
  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      return new Response(readFileSync(filePath, "utf-8"), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        },
      });
    }
  }
  return new Response(
    JSON.stringify({ error: "agent-card.json not found — run: npx w2agent generate <url>" }),
    { headers: { "Content-Type": "application/json" } },
  );
};
