import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAstroInstall } from "../src/adapters/astro/install.js";
import type { GeneratedFile } from "../src/generate/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeAstroFiles(): GeneratedFile[] {
  return [
    makeFile("astro/public/llms.txt", "# Seed"),
    makeFile("astro/public/llms-full.txt", "# Seed Full"),
    makeFile("astro/public/.well-known/agent-card.json", "{}"),
    makeFile("astro/src/pages/llms.txt.ts", "export const GET = () => {}"),
    makeFile("astro/src/pages/.well-known/agent-card.json.ts", "export const GET = () => {}"),
    makeFile("astro/w2agent-integration.mjs", "// integration"),
    makeFile("astro/w2agent-build.mjs", "// build"),
    makeFile("astro/INSTALL.md", "# Install"),
  ];
}

describe("Astro install resolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "w2agent-astro-install-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("installs only public files for static mode", () => {
    writeFileSync(
      join(tempDir, "astro.config.mjs"),
      'import { defineConfig } from "astro/config";\nexport default defineConfig({});',
      "utf-8",
    );

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const writes = plan.actions.filter((a) => a.type === "write");
    const dests = writes.map((a) => a.dest);

    expect(dests).toContain("public/llms.txt");
    expect(dests).toContain("public/llms-full.txt");
    expect(dests).toContain("public/.well-known/agent-card.json");
    expect(dests).not.toContain("src/pages/llms.txt.ts");

    const skipped = plan.actions.filter((a) => a.type === "skip");
    expect(skipped.some((a) => a.dest.startsWith("src/pages/"))).toBe(true);
  });

  it("installs all files for SSR/hybrid mode", () => {
    writeFileSync(
      join(tempDir, "astro.config.mjs"),
      'export default defineConfig({ output: "server" });',
      "utf-8",
    );

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests).toContain("src/pages/llms.txt.ts");
    expect(dests).toContain("src/pages/.well-known/agent-card.json.ts");
    expect(dests).toContain("public/llms.txt");
  });

  it("handles hybrid output mode", () => {
    writeFileSync(
      join(tempDir, "astro.config.mjs"),
      "export default defineConfig({ output: 'hybrid' });",
      "utf-8",
    );

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);

    expect(dests).toContain("src/pages/llms.txt.ts");
  });

  it("warns when no astro config found", () => {
    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    expect(plan.warnings.some((w) => w.includes("Could not detect astro.config"))).toBe(true);
  });

  it("skips existing public/llms.txt", () => {
    writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
    mkdirSync(join(tempDir, "public"), { recursive: true });
    writeFileSync(join(tempDir, "public", "llms.txt"), "# existing", "utf-8");

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const skipped = plan.actions.find((a) => a.type === "skip" && a.dest === "public/llms.txt");
    expect(skipped).toBeDefined();
  });

  it("suggests adding integration to config", () => {
    writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    expect(plan.postInstallSteps.some((s) => s.includes("integration"))).toBe(true);
  });

  describe("seed steps follow the files this install writes", () => {
    const seedSteps = (existing: string[]) => {
      writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
      mkdirSync(join(tempDir, "public"), { recursive: true });
      for (const name of existing) writeFileSync(join(tempDir, "public", name), "# existing");
      const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
      return {
        plan,
        integration: plan.postInstallSteps.find((s) => s.includes("integrations: [")) ?? "",
        prebuild: plan.postInstallSteps.find((s) => s.includes('"prebuild"')) ?? "",
      };
    };

    it("both seeds written: overwrite: true and --overwrite", () => {
      const { plan, integration, prebuild } = seedSteps([]);
      const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
      expect(dests).toContain("public/llms.txt");
      expect(dests).toContain("public/llms-full.txt");
      expect(integration).toContain("integrations: [w2agentIntegration({ overwrite: true })]");
      expect(prebuild).toContain('"prebuild": "node w2agent-build.mjs --overwrite"');
    });

    it("only llms-full.txt written (owner llms.txt kept): overwrite list names llms-full.txt only", () => {
      const { integration, prebuild } = seedSteps(["llms.txt"]);
      expect(integration).toContain(
        'integrations: [w2agentIntegration({ overwrite: ["llms-full.txt"] })]',
      );
      expect(integration).not.toContain("overwrite: true");
      expect(prebuild).toContain('"prebuild": "node w2agent-build.mjs --overwrite=llms-full.txt"');
    });

    it("only llms.txt written (owner llms-full.txt kept): overwrite list names llms.txt only", () => {
      const { integration, prebuild } = seedSteps(["llms-full.txt"]);
      expect(integration).toContain(
        'integrations: [w2agentIntegration({ overwrite: ["llms.txt"] })]',
      );
      expect(prebuild).toContain('"prebuild": "node w2agent-build.mjs --overwrite=llms.txt"');
    });

    const SEEDS = { "llms.txt": "# Seed", "llms-full.txt": "# Seed Full" };

    it("a re-install over identical seeds still passes overwrite: true and --overwrite", () => {
      writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
      mkdirSync(join(tempDir, "public"), { recursive: true });
      for (const [name, content] of Object.entries(SEEDS)) {
        writeFileSync(join(tempDir, "public", name), content);
      }
      const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
      expect(plan.actions.some((a) => a.type === "write" && a.dest.startsWith("public/llms"))).toBe(
        false,
      );
      const integration = plan.postInstallSteps.find((s) => s.includes("integrations: [")) ?? "";
      const prebuild = plan.postInstallSteps.find((s) => s.includes('"prebuild"')) ?? "";
      expect(integration).toContain("integrations: [w2agentIntegration({ overwrite: true })]");
      expect(prebuild).toContain('"prebuild": "node w2agent-build.mjs --overwrite"');
      expect(prebuild).toContain("w2agent seeds in public/");
    });

    it.each([
      ["llms.txt", "llms-full.txt"],
      ["llms-full.txt", "llms.txt"],
    ])("identical %s seed plus an owner %s: only the seed is listed", (seed, owner) => {
      writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
      mkdirSync(join(tempDir, "public"), { recursive: true });
      writeFileSync(join(tempDir, "public", seed), SEEDS[seed as keyof typeof SEEDS]);
      writeFileSync(join(tempDir, "public", owner), "# hand-written");
      const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
      const integration = plan.postInstallSteps.find((s) => s.includes("integrations: [")) ?? "";
      const prebuild = plan.postInstallSteps.find((s) => s.includes('"prebuild"')) ?? "";
      expect(integration).toContain(`w2agentIntegration({ overwrite: ["${seed}"] })`);
      expect(prebuild).toContain(`"prebuild": "node w2agent-build.mjs --overwrite=${seed}"`);
    });

    it.each([
      "llms.txt",
      "llms-full.txt",
    ])("a directory at public/%s is no seed and no throw", (name) => {
      writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
      mkdirSync(join(tempDir, "public", name), { recursive: true });
      const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
      expect(plan.platform).toBe("astro");
      const integration = plan.postInstallSteps.find((s) => s.includes("integrations: [")) ?? "";
      const other = name === "llms.txt" ? "llms-full.txt" : "llms.txt";
      expect(integration).not.toContain("overwrite: true");
      expect(integration).toContain(`overwrite: ["${other}"]`);
    });

    it("an edited seed is the owner's file: plain steps", () => {
      writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
      mkdirSync(join(tempDir, "public"), { recursive: true });
      writeFileSync(join(tempDir, "public", "llms.txt"), "# Seed edited");
      writeFileSync(join(tempDir, "public", "llms-full.txt"), "# Seed Full edited");
      const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
      const integration = plan.postInstallSteps.find((s) => s.includes("integrations: [")) ?? "";
      expect(integration).toContain("integrations: [w2agentIntegration()]");
    });

    it("the prebuild wording agrees with the number of seeds", () => {
      writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
      const both = resolveAstroInstall(makeAstroFiles(), tempDir);
      const bothStep = both.postInstallSteps.find((s) => s.includes('"prebuild"')) ?? "";
      expect(bothStep).toContain("w2agent seeds in public/");
      mkdirSync(join(tempDir, "public"), { recursive: true });
      writeFileSync(join(tempDir, "public", "llms.txt"), "# hand-written");
      const one = resolveAstroInstall(makeAstroFiles(), tempDir);
      const oneStep = one.postInstallSteps.find((s) => s.includes('"prebuild"')) ?? "";
      expect(oneStep).toContain("w2agent seed in public/");
      expect(oneStep).not.toContain("seeds");
    });

    it("no seed written: plain integration and plain prebuild script", () => {
      const { integration, prebuild } = seedSteps(["llms.txt", "llms-full.txt"]);
      expect(integration).toContain("integrations: [w2agentIntegration()]");
      expect(integration).not.toContain("overwrite");
      expect(prebuild).toContain('"prebuild": "node w2agent-build.mjs"');
      expect(prebuild).not.toContain("--overwrite");
    });
  });

  it("skips existing build script", () => {
    writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
    writeFileSync(join(tempDir, "w2agent-build.mjs"), "// existing", "utf-8");

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const skipped = plan.actions.find((a) => a.type === "skip" && a.dest === "w2agent-build.mjs");
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toBe("already exists");
  });

  it("tells the user the prebuild script and the integration plugin are alternatives", () => {
    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const step = plan.postInstallSteps.find((s) => s.includes('"prebuild"')) ?? "";
    expect(step).toContain("use one, not both");
  });

  it("skips existing integration plugin", () => {
    writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
    writeFileSync(join(tempDir, "w2agent-integration.mjs"), "// existing", "utf-8");

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const skipped = plan.actions.find(
      (a) => a.type === "skip" && a.dest === "w2agent-integration.mjs",
    );
    expect(skipped).toBeDefined();
    // Should NOT suggest adding integration since it already exists
    expect(plan.postInstallSteps.some((s) => s.includes("integration"))).toBe(false);
  });

  it("writes unknown file types through catch-all", () => {
    writeFileSync(join(tempDir, "astro.config.mjs"), "export default defineConfig({});", "utf-8");
    const files = [...makeAstroFiles(), makeFile("astro/some-extra-file.json", "{}")];

    const plan = resolveAstroInstall(files, tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
    expect(dests).toContain("some-extra-file.json");
  });

  it("detects astro.config.ts", () => {
    writeFileSync(
      join(tempDir, "astro.config.ts"),
      'export default defineConfig({ output: "server" });',
      "utf-8",
    );

    const plan = resolveAstroInstall(makeAstroFiles(), tempDir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
    expect(dests).toContain("src/pages/llms.txt.ts");
  });
});
