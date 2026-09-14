import { addServerHandler, createResolver, defineNuxtModule } from "@nuxt/kit";

export interface ModuleOptions {
  /** Base URL of your site — used in fallback content when static files are missing */
  siteUrl?: string;
  /** Enable the /api/w2agent-webhook POST route (default: true) */
  webhookEnabled?: boolean;
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: "@w2agent/nuxt",
    configKey: "w2agent",
    compatibility: { nuxt: "^3.0.0" },
  },
  defaults: {
    webhookEnabled: true,
  },
  setup(options, _nuxt) {
    const resolver = createResolver(import.meta.url);

    // llms.txt — AI content index
    addServerHandler({
      route: "/llms.txt",
      handler: resolver.resolve("./runtime/server/routes/llms-txt"),
    });

    // llms-full.txt — full content dump
    addServerHandler({
      route: "/llms-full.txt",
      handler: resolver.resolve("./runtime/server/routes/llms-full-txt"),
    });

    // index.md — llms.txt as text/markdown (homepage markdown twin)
    addServerHandler({
      route: "/index.md",
      handler: resolver.resolve("./runtime/server/routes/index-md"),
    });

    // /.well-known/agent-card.json — agent metadata
    addServerHandler({
      route: "/.well-known/agent-card.json",
      handler: resolver.resolve("./runtime/server/routes/agent-card"),
    });

    // Content negotiation middleware — redirects AI agents at / to /index.md (markdown) or /llms.txt
    addServerHandler({
      middleware: true,
      handler: resolver.resolve("./runtime/server/middleware/content-negotiation"),
    });

    // Optional webhook route for re-crawl triggers
    if (options.webhookEnabled !== false) {
      addServerHandler({
        route: "/api/w2agent-webhook",
        method: "post",
        handler: resolver.resolve("./runtime/server/routes/webhook"),
      });
    }
  },
});
