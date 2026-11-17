import { isAbsolute, resolve } from "node:path";
import { addServerHandler, createResolver, defineNuxtModule } from "@nuxt/kit";

export const ASSET_BASE_NAME = "w2agent";
export const ASSET_PATTERN = "{llms.txt,llms-full.txt,agent-card.json,.well-known/agent-card.json}";

interface NitroConfigLike {
  serverAssets?: { baseName: string; dir: string; pattern?: string }[];
}

interface NuxtLike {
  options: { dir: { public: string }; srcDir: string };
  hook: (name: never, fn: never) => unknown;
}

export function registerServerAssets(nuxt: NuxtLike) {
  const onNitroConfig = (nitroConfig: NitroConfigLike) => {
    const configured = nuxt.options.dir.public;
    const dir = isAbsolute(configured) ? configured : resolve(nuxt.options.srcDir, configured);
    nitroConfig.serverAssets ||= [];
    if (nitroConfig.serverAssets.some((a) => a.baseName === ASSET_BASE_NAME)) return;
    nitroConfig.serverAssets.push({ baseName: ASSET_BASE_NAME, dir, pattern: ASSET_PATTERN });
  };
  nuxt.hook("nitro:config" as never, onNitroConfig as never);
}

export interface ModuleOptions {
  /** Unused. Kept so existing configs still type-check; the routes no longer build fallback content. */
  siteUrl?: string;
  /** Enable the /api/w2agent-webhook POST route (default: true) */
  webhookEnabled?: boolean;
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: "@w2agent/nuxt",
    configKey: "w2agent",
    compatibility: { nuxt: "^3.0.0 || ^4.0.0" },
  },
  defaults: {
    webhookEnabled: true,
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url);

    // Inline only the w2agent files from public/ into the server bundle (never the whole dir),
    // so the routes serve the build-time content regardless of the runtime working directory.
    registerServerAssets(nuxt);

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
