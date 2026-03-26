import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRoute } from "astro";

export const GET: APIRoute = () => {
  const filePath = join(process.cwd(), "public", "llms-full.txt");
  const body = existsSync(filePath)
    ? readFileSync(filePath, "utf-8")
    : "# Full Content Dump\n\n> Run: npx w2agent generate <your-site-url> --output ./public/\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
};
