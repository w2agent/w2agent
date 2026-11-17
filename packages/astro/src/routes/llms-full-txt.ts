import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";

export const GET: APIRoute = () => {
  const filePath = join(process.cwd(), "public", "llms-full.txt");
  if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
  return new Response(readFileSync(filePath, "utf-8"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
};
