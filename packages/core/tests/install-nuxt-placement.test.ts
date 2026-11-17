import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNuxtInstall } from "../src/adapters/nuxt/install.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "x"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

const FILES = [
  makeFile("nuxt/modules/w2agent.ts", "// module"),
  makeFile("nuxt/server/routes/llms.txt.ts"),
  makeFile("nuxt/public/llms.txt", "# Seed"),
  makeFile("nuxt/plugins/w2agent-webmcp.client.ts", "// plugin"),
  makeFile("nuxt/w2agent-build.mjs"),
  makeFile("nuxt/INSTALL.md"),
];

describe("Nuxt install: module and plugin placement (NU-2, NU-3)", () => {
  let dir: string;

  const put = (rel: string, content = "") => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content, "utf-8");
  };
  const setup = (nuxt: string, config?: string) => {
    put("package.json", JSON.stringify({ dependencies: { nuxt } }));
    if (config !== undefined) put("nuxt.config.ts", config);
  };
  const plan = () => resolveNuxtInstall(FILES, dir);
  const writes = () =>
    plan()
      .actions.filter((a) => a.type === "write")
      .map((a) => a.dest);
  const pluginDest = () => writes().find((d) => d.endsWith("w2agent-webmcp.client.ts"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-nuxt-place-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs the module at modules/w2agent.ts; server, public and build script stay at root", () => {
    setup("^3.8.0");
    put("app/app.vue");
    const dests = writes();
    expect(dests).toContain("modules/w2agent.ts");
    expect(dests).toContain("server/routes/llms.txt.ts");
    expect(dests).toContain("public/llms.txt");
    expect(dests).toContain("w2agent-build.mjs");
  });

  it("Nuxt 3 root layout: plugin in root plugins/", () => {
    setup("^3.8.0", "export default defineNuxtConfig({})");
    put("app.vue");
    expect(pluginDest()).toBe("plugins/w2agent-webmcp.client.ts");
  });

  it("Nuxt 3 with app/ but no compatibilityVersion: root plugins/", () => {
    setup("^3.8.0", "export default defineNuxtConfig({})");
    put("app/app.vue");
    expect(pluginDest()).toBe("plugins/w2agent-webmcp.client.ts");
  });

  it("Nuxt 3 with compatibilityVersion 4 and app/app.vue: app/plugins", () => {
    setup("^3.15.0", "export default defineNuxtConfig({ future: { compatibilityVersion: 4 } })");
    put("app/app.vue");
    expect(pluginDest()).toBe("app/plugins/w2agent-webmcp.client.ts");
  });

  it("Nuxt 4 with app/app.vue: app/plugins", () => {
    setup("^4.0.0", "export default defineNuxtConfig({})");
    put("app/app.vue");
    expect(pluginDest()).toBe("app/plugins/w2agent-webmcp.client.ts");
  });

  it("Nuxt 4 with root app.vue and no app/: root plugins/", () => {
    setup("^4.0.0", "export default defineNuxtConfig({})");
    put("app.vue");
    expect(pluginDest()).toBe("plugins/w2agent-webmcp.client.ts");
  });

  it("Nuxt 4 with only app/router.options.ts and root pages/: root plugins/", () => {
    setup("^4.0.0", "export default defineNuxtConfig({})");
    put("app/router.options.ts");
    put("pages/index.vue");
    expect(pluginDest()).toBe("plugins/w2agent-webmcp.client.ts");
  });

  it("Nuxt 4 with only app/spa-loading-template.html and no root markers: app/plugins", () => {
    setup("^4.0.0");
    put("app/spa-loading-template.html");
    expect(pluginDest()).toBe("app/plugins/w2agent-webmcp.client.ts");
  });

  it("Nuxt 4 with app/ holding any other entry wins over root markers", () => {
    setup("^4.0.0");
    put("app/components/a.vue");
    put("app.vue");
    expect(pluginDest()).toBe("app/plugins/w2agent-webmcp.client.ts");
  });

  it("explicit literal srcDir wins, in any quote style and on Nuxt 3", () => {
    for (const literal of ['"src"', "'src'", "`src`"]) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "w2agent-nuxt-place-"));
      setup("^3.8.0", `export default defineNuxtConfig({ srcDir: ${literal} })`);
      expect(pluginDest(), literal).toBe("src/plugins/w2agent-webmcp.client.ts");
    }
  });

  it("explicit srcDir beats the Nuxt 4 app/ rule", () => {
    setup("^4.0.0", 'export default defineNuxtConfig({ srcDir: "src/" })');
    put("app/app.vue");
    expect(pluginDest()).toBe("src/plugins/w2agent-webmcp.client.ts");
  });

  it("a commented-out srcDir is ignored", () => {
    setup("^4.0.0", '// srcDir: "src",\nexport default defineNuxtConfig({ /* srcDir: "x" */ })');
    put("app/app.vue");
    expect(pluginDest()).toBe("app/plugins/w2agent-webmcp.client.ts");
    expect(plan().warnings.some((w) => w.includes("srcDir"))).toBe(false);
  });

  it("a non-literal srcDir warns and falls back to the default rule", () => {
    setup("^4.0.0", "const d = 'x'\nexport default defineNuxtConfig({ srcDir: d })");
    put("app/app.vue");
    const p = plan();
    expect(p.warnings.some((w) => w.includes("srcDir"))).toBe(true);
    expect(p.actions.find((a) => a.dest.endsWith("w2agent-webmcp.client.ts"))?.dest).toBe(
      "app/plugins/w2agent-webmcp.client.ts",
    );
  });

  it("a srcDir that escapes the project is refused by the guard", () => {
    setup("^3.8.0", 'export default defineNuxtConfig({ srcDir: "../elsewhere" })');
    const p = plan();
    expect(pluginDest()).toBeUndefined();
    expect(p.warnings.some((w) => w.includes("outside the project"))).toBe(true);
  });

  it("reads nuxt.config.js too", () => {
    setup("^3.8.0");
    put("nuxt.config.js", 'export default { srcDir: "src" }');
    expect(pluginDest()).toBe("src/plugins/w2agent-webmcp.client.ts");
  });

  it("an unpinned nuxt version uses the installed major", () => {
    setup("latest");
    put("node_modules/nuxt/package.json", JSON.stringify({ version: "4.6.4" }));
    put("app/app.vue");
    expect(pluginDest()).toBe("app/plugins/w2agent-webmcp.client.ts");
  });

  it("an existing modules/w2agent.ts is not overwritten and the routes warn", () => {
    setup("^3.8.0");
    put("modules/w2agent.ts", "// mine");
    const p = plan();
    expect(p.actions.find((a) => a.dest === "modules/w2agent.ts")?.type).toBe("skip");
    expect(p.warnings.some((w) => w.includes("modules/w2agent.ts") && w.includes("404"))).toBe(
      true,
    );
  });

  it("re-running with an identical module is up to date and does not warn", () => {
    setup("^3.8.0");
    put("modules/w2agent.ts", "// module");
    const p = plan();
    expect(p.actions.find((a) => a.dest === "modules/w2agent.ts")?.reason).toBe(
      "already up to date",
    );
    expect(p.warnings.some((w) => w.includes("404"))).toBe(false);
  });
});
