import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import * as fs from "node:fs";
import handler from "../src/runtime/server/routes/agent-card";

const mockFs = vi.mocked(fs);

function makeEvent() {
  const setHeader = vi.fn();
  return { event: { node: { res: { setHeader } } } as never, setHeader };
}

describe("Nitro /.well-known/agent-card.json handler", () => {
  beforeEach(() => vi.resetAllMocks());

  it("responds 404 when no card file exists, instead of a 200 JSON error body", async () => {
    // A 200 JSON error body is audited as a malformed agent card; a missing card must be absent.
    mockFs.existsSync.mockReturnValue(false);
    const { event, setHeader } = makeEvent();
    let thrown: unknown;
    try {
      await handler(event);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ statusCode: 404 });
    expect(setHeader).not.toHaveBeenCalledWith("Content-Type", "application/json");
  });

  it("serves the provided card as JSON", async () => {
    mockFs.existsSync.mockImplementation((p) =>
      String(p).endsWith("public/.well-known/agent-card.json"),
    );
    mockFs.readFileSync.mockReturnValue('{"name":"Agent"}' as never);
    const { event, setHeader } = makeEvent();
    expect(await handler(event)).toEqual({ name: "Agent" });
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
  });
});
