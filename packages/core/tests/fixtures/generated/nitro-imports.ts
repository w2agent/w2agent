import { defineEventHandler, type EventHandler } from "h3";

export * from "h3";

// Nitro 2.x defineCachedEventHandler replays only the headers the handler set on the
// response; options it doesn't know (such as `headers`) are ignored. Caching is out of scope.
export function defineCachedEventHandler(handler: EventHandler, _options?: unknown) {
  return defineEventHandler(handler);
}
