import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSET_BASE_NAME as RUNTIME_BASE_NAME } from "../src/runtime/server/utils/read-asset";

describe("@w2agent/nuxt module", () => {
  it("exports a callable default (Nuxt module installer)", async () => {
    const mod = await import("../src/module");
    expect(typeof mod.default).toBe("function");
  });

  it("scopes the registered serverAssets entry to the w2agent files", async () => {
    const { registerServerAssets, ASSET_BASE_NAME, ASSET_PATTERN } = await import("../src/module");
    const hooks: Record<string, (config: Record<string, unknown>) => void> = {};
    registerServerAssets({
      options: { dir: { public: "/proj/public" }, srcDir: "/proj/app" },
      hook: ((name: string, fn: (config: Record<string, unknown>) => void) => {
        hooks[name] = fn;
      }) as never,
    });
    const config: { serverAssets?: { baseName: string; dir: string; pattern?: string }[] } = {
      serverAssets: [{ baseName: "other", dir: "/x" }],
    };
    hooks["nitro:config"](config);

    expect(config.serverAssets).toHaveLength(2);
    const entry = config.serverAssets?.[1];
    expect(entry).toEqual({
      baseName: ASSET_BASE_NAME,
      dir: "/proj/public",
      pattern: ASSET_PATTERN,
    });
    expect(ASSET_BASE_NAME).toBe(RUNTIME_BASE_NAME);

    // Same call Nitro makes when bundling server assets (globby, default options).
    const dir = mkdtempSync(join(tmpdir(), "w2agent-nuxt-"));
    const files = [
      "llms.txt",
      "llms-full.txt",
      "agent-card.json",
      ".well-known/agent-card.json",
      "secret.txt",
      "unrelated-marker.txt",
      "robots.txt",
      "nested/llms.txt",
      ".well-known/other.json",
      ".env",
    ];
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), "x");
    }
    const { globby } = await import("globby");
    const matched = (await globby(ASSET_PATTERN, { cwd: dir })).sort();
    expect(matched).toEqual([
      ".well-known/agent-card.json",
      "agent-card.json",
      "llms-full.txt",
      "llms.txt",
    ]);
  });

  it("resolves a relative dir.public against srcDir", async () => {
    const { registerServerAssets } = await import("../src/module");
    let hook: ((config: Record<string, unknown>) => void) | undefined;
    registerServerAssets({
      options: { dir: { public: "static" }, srcDir: "/proj" },
      hook: ((_: string, fn: never) => {
        hook = fn;
      }) as never,
    });
    const config: { serverAssets?: { dir: string }[] } = {};
    hook?.(config);
    expect(config.serverAssets?.[0].dir).toBe(resolve("/proj", "static"));
  });

  it("declares Nuxt 3 and 4 (not 5) in the module meta and package ranges", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    expect(pkg.peerDependencies.nuxt).toBe("^3.0.0 || ^4.0.0");
    expect(pkg.dependencies["@nuxt/kit"]).toBe("^3.0.0 || ^4.0.0");
    const src = readFileSync(new URL("../src/module.ts", import.meta.url), "utf-8");
    expect(src).toContain('compatibility: { nuxt: "^3.0.0 || ^4.0.0" }');
  });
});
