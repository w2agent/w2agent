import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineEventHandler, setResponseHeader } from "h3";

export default defineEventHandler((event) => {
  setResponseHeader(event, "Content-Type", "text/plain; charset=utf-8");
  setResponseHeader(event, "Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  const filePath = join(process.cwd(), "public", "llms-full.txt");
  if (existsSync(filePath)) {
    return readFileSync(filePath, "utf-8");
  }
  return "# Full Content Dump\n\n> Run: npx w2agent generate <your-site-url> --format llms-txt,full --no-platform --output ./public/\n";
});
