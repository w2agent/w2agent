import type { LoaderFunctionArgs } from "@remix-run/node";
import { generateLlmsTxt } from "../lib/generate";
import { getLlmsTxt, getStale } from "../lib/llms-cache";
import { authenticate } from "../shopify.server";

const TEXT = "text/plain; charset=utf-8";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const path = url.pathname;

  if (path.endsWith("/llms.txt")) {
    if (!admin || !session) {
      return new Response("App not installed", { status: 401 });
    }

    try {
      const content = await getLlmsTxt(session.shop, () => generateLlmsTxt(admin));
      return new Response(content, {
        headers: {
          "Content-Type": TEXT,
          "Cache-Control": "public, max-age=900",
        },
      });
    } catch (error) {
      console.error(`llms.txt generation failed for ${session.shop}:`, error);
      const stale = getStale(session.shop);
      if (stale !== undefined) {
        return new Response(stale, {
          headers: { "Content-Type": TEXT, "Cache-Control": "no-store" },
        });
      }
      return new Response("llms.txt is temporarily unavailable", {
        status: 503,
        headers: { "Content-Type": TEXT, "Retry-After": "60", "Cache-Control": "no-store" },
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}
