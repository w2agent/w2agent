import { beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../src/runtime/server/routes/agent-card";
import { setAssets } from "./stubs/imports";

function makeEvent() {
  const setHeader = vi.fn();
  return { event: { node: { res: { setHeader } } } as never, setHeader };
}

describe("Nitro /.well-known/agent-card.json handler", () => {
  beforeEach(() => setAssets({}));

  it("responds 404 when no card file exists, instead of a 200 JSON error body", async () => {
    // A 200 JSON error body is audited as a malformed agent card; a missing card must be absent.
    const { event, setHeader } = makeEvent();
    let thrown: unknown;
    try {
      await handler(event);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ statusCode: 404 });
    expect(setHeader).not.toHaveBeenCalledWith("Content-Type", "application/json");
    expect(setHeader).not.toHaveBeenCalledWith("Cache-Control", expect.anything());
  });

  it("serves the provided card as JSON with the cache header", async () => {
    setAssets({ ".well-known/agent-card.json": '{"name":"Agent"}' });
    const { event, setHeader } = makeEvent();
    expect(await handler(event)).toEqual({ name: "Agent" });
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
    expect(setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      expect.stringContaining("max-age=3600"),
    );
  });

  it("falls back to a root agent-card.json", async () => {
    setAssets({ "agent-card.json": '{"name":"Root"}' });
    const { event } = makeEvent();
    expect(await handler(event)).toEqual({ name: "Root" });
  });
});
