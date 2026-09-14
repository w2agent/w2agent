import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");

import * as fs from "node:fs";
import { GET } from "../src/routes/agent-card";

const mockFs = vi.mocked(fs);
const handler = GET as unknown as () => Response;

describe("SSR /.well-known/agent-card.json route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 404 with no JSON body when no card file exists", async () => {
    // A 200 JSON error body is audited as a malformed agent card; a missing card must be absent.
    mockFs.existsSync.mockReturnValue(false);
    const res = handler();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("json");
    expect(await res.text()).not.toContain("w2agent generate");
  });

  it("serves the provided card as JSON", async () => {
    mockFs.existsSync.mockImplementation((p) =>
      String(p).endsWith("public/.well-known/agent-card.json"),
    );
    mockFs.readFileSync.mockReturnValue('{"name":"Agent"}' as never);
    const res = handler();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ name: "Agent" });
  });
});
