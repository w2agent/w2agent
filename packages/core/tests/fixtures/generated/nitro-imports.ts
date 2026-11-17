import { defineEventHandler, type EventHandler } from "h3";

export * from "h3";

// Nitro 2.x defineCachedEventHandler replays only the headers the handler set on the
// response; options it doesn't know (such as `headers`) are ignored. Caching is out of scope.
export function defineCachedEventHandler(handler: EventHandler, _options?: unknown) {
  return defineEventHandler(handler);
}

// Stand-in for the "w2agent" server assets the emitted modules/w2agent.ts mounts at build time.
const ASSETS: Record<string, string> = {
  "llms.txt":
    "# example.com\n\n> Test site index\n\n## Pages\n\n- [Home](https://example.com): Main page\n",
  "llms-full.txt": "# example.com\n\nFull content.\n",
};

export function useRuntimeConfig() {
  return { app: { baseURL: "/" } };
}

export function useStorage(_base?: string) {
  return {
    hasItem: async (key: string) => key in ASSETS,
    getItemRaw: async (key: string) => new TextEncoder().encode(ASSETS[key]),
  };
}
