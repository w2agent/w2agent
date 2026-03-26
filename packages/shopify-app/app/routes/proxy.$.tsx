import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { generateLlmsTxt } from "../lib/generate";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const path = url.pathname;

  if (path.endsWith("/llms.txt")) {
    if (!admin) {
      return new Response("App not installed", { status: 401 });
    }

    const content = await generateLlmsTxt(admin);
    return new Response(content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  return new Response("Not Found", { status: 404 });
}
