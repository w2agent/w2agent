import { describe, expect, it } from "vitest";

describe("@w2agent/nuxt module", () => {
  it("exports a callable default (Nuxt module installer)", async () => {
    const mod = await import("../src/module");
    expect(typeof mod.default).toBe("function");
  });
});
