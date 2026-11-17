import { describe, expect, it } from "vitest";
import { generateNextjsIntegration } from "../src/adapters/nextjs/templates.js";

const files = generateNextjsIntegration("# a", "# b", undefined, "https://example.com");
const read = (name: string) => files.find((f) => f.filename === name)?.content ?? "";

describe("Next.js build script refresh runs before the build", () => {
  const script = read("nextjs/w2agent-build.mjs");
  const guide = read("nextjs/INSTALL.md");

  it("the emitted script suggests prebuild and says why", () => {
    expect(script).toContain('"prebuild": "node w2agent-build.mjs"');
    expect(script).toContain("prerendered during next build");
    expect(script).not.toContain('"postbuild"');
  });

  it("INSTALL.md uses prebuild and states the freshness limits", () => {
    expect(guide).toContain('"prebuild": "node w2agent-build.mjs"');
    expect(guide).not.toContain('"postbuild": "node');
    expect(guide).toContain("previous deploy");
    expect(guide).toContain("first deploy serves this seed");
    expect(guide).not.toContain("stays fresh automatically");
    expect(guide).not.toContain("on every deploy");
  });

  it("INSTALL.md documents the install conventions", () => {
    expect(guide).toContain("export function proxy");
    expect(guide).toContain("src/components/");
    expect(guide).toContain("route.js");
    expect(guide).toContain("cacheComponents");
    expect(guide).toContain('output: "export"');
    expect(guide).toContain(".w2agent/robots.txt");
    expect(guide).toContain("Next.js overwrites `Vary`");
  });
});
