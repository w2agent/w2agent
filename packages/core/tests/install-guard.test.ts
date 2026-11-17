import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlatformAdapter } from "../src/adapters/types.js";
import type { GeneratedFile } from "../src/generate/types.js";
import { executeInstallPlan } from "../src/install/executor.js";
import { guardInstallActions } from "../src/install/guard.js";
import { planInstall } from "../src/install/planner.js";
import type { InstallAction } from "../src/install/types.js";

function makeFile(filename: string, content = "test content"): GeneratedFile {
  return { filename, content, size: Buffer.byteLength(content) };
}

function makeAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id: "nextjs",
    name: "Next.js",
    description: "test",
    detect: () => null,
    checks: [],
    generateIntegration: () => [],
    ...overrides,
  };
}

function write(dest: string, content = "new content"): InstallAction {
  return { type: "write", dest, content };
}

describe("install guard", () => {
  let root: string;
  let project: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "w2agent-guard-"));
    project = join(root, "proj");
    outside = join(root, "outside");
    mkdirSync(project);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function expectNothingOutside() {
    expect(readdirSync(root).sort()).toEqual(["outside", "proj"]);
    expect(readdirSync(outside)).toEqual([]);
  }

  describe("guardInstallActions", () => {
    it("keeps a write when the destination is free", () => {
      const { actions, warnings } = guardInstallActions([write("public/llms.txt")], project);
      expect(actions).toEqual([write("public/llms.txt")]);
      expect(warnings).toEqual([]);
    });

    it("skips an existing file with different content and warns", () => {
      writeFileSync(join(project, "llms.txt"), "mine");
      const { actions, warnings } = guardInstallActions([write("llms.txt")], project);
      expect(actions[0].type).toBe("skip");
      expect(actions[0].reason).toContain("already exists");
      expect(actions[0].reason).toContain("not overwritten");
      expect(actions[0].reason).toContain("re-run");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("llms.txt");
    });

    it("skips an identical file as already up to date without a warning", () => {
      writeFileSync(join(project, "llms.txt"), "same");
      const { actions, warnings } = guardInstallActions([write("llms.txt", "same")], project);
      expect(actions[0]).toMatchObject({ type: "skip", reason: "already up to date" });
      expect(warnings).toEqual([]);
    });

    it("skips when a code file with the same stem and another extension exists", () => {
      mkdirSync(join(project, "app", "llms.txt"), { recursive: true });
      writeFileSync(join(project, "app", "llms.txt", "route.js"), "mine");
      const { actions, warnings } = guardInstallActions([write("app/llms.txt/route.ts")], project);
      expect(actions[0].type).toBe("skip");
      expect(actions[0].reason).toContain("route.js");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("route.js");
    });

    it("does not treat a different stem or a non-code extension as a sibling", () => {
      writeFileSync(join(project, "other.js"), "x");
      writeFileSync(join(project, "route.json"), "x");
      const { actions } = guardInstallActions([write("route.ts")], project);
      expect(actions[0].type).toBe("write");
    });

    it("skips a ../ destination", () => {
      const { actions, warnings } = guardInstallActions([write("../outside/x.txt")], project);
      expect(actions[0].type).toBe("skip");
      expect(actions[0].reason).toContain("outside the project directory");
      expect(actions[0].reason).toContain("not written");
      expect(warnings).toHaveLength(1);
    });

    it("skips an absolute destination, even one inside the project", () => {
      const { actions } = guardInstallActions(
        [write(join(outside, "x.txt")), write(join(project, "y.txt"))],
        project,
      );
      expect(actions.map((a) => a.type)).toEqual(["skip", "skip"]);
      expect(actions[0].reason).toContain("outside the project directory");
    });

    it("skips a destination reached through a symlinked directory that points outside", () => {
      symlinkSync(outside, join(project, "link"));
      const { actions } = guardInstallActions(
        [write("link/x.txt"), write("link/deeper/y.txt")],
        project,
      );
      expect(actions.map((a) => a.type)).toEqual(["skip", "skip"]);
      expect(actions[0].reason).toContain("outside the project directory");
    });

    it("allows a symlinked directory that stays inside the project", () => {
      mkdirSync(join(project, "real"));
      symlinkSync(join(project, "real"), join(project, "alias"));
      const { actions } = guardInstallActions([write("alias/x.txt")], project);
      expect(actions[0].type).toBe("write");
    });

    it("treats a dangling symlink at the destination as existing", () => {
      symlinkSync(join(outside, "missing.txt"), join(project, "llms.txt"));
      const { actions, warnings } = guardInstallActions([write("llms.txt")], project);
      expect(actions[0].type).toBe("skip");
      expect(actions[0].reason).toContain("already exists");
      expect(warnings).toHaveLength(1);
    });

    it("leaves skip and manual actions untouched", () => {
      const input: InstallAction[] = [
        { type: "skip", dest: "../a", reason: "r" },
        { type: "manual", dest: "/abs", reason: "r" },
      ];
      const { actions, warnings } = guardInstallActions(input, project);
      expect(actions).toEqual(input);
      expect(warnings).toEqual([]);
    });
  });

  describe("executeInstallPlan", () => {
    const plan = (actions: InstallAction[]) => ({
      platform: "nextjs" as const,
      actions,
      warnings: [],
      postInstallSteps: [],
    });

    it("writes a new file and creates parent directories", () => {
      const result = executeInstallPlan(plan([write("a/b/c.txt", "hello")]), project);
      expect(result.installed).toEqual(["a/b/c.txt"]);
      expect(readFileSync(join(project, "a/b/c.txt"), "utf-8")).toBe("hello");
    });

    it("keeps an existing file byte-for-byte and reports it as skipped", () => {
      const original = Buffer.from([0, 1, 2, 255, 10, 13]);
      writeFileSync(join(project, "keep.bin"), original);
      const result = executeInstallPlan(plan([write("keep.bin")]), project);
      expect(result.installed).toEqual([]);
      expect(result.skipped[0]).toContain("keep.bin");
      expect(result.skipped[0]).toContain("already exists");
      expect(readFileSync(join(project, "keep.bin")).equals(original)).toBe(true);
    });

    it("does not overwrite a file created between planning and execution", () => {
      const adapter = makeAdapter({
        resolveInstall: () => plan([write("late.txt", "ours")]),
      });
      const planned = planInstall(adapter, [], project);
      expect(planned.actions[0].type).toBe("write");
      writeFileSync(join(project, "late.txt"), "theirs");
      const result = executeInstallPlan(planned, project);
      expect(result.installed).toEqual([]);
      expect(result.skipped[0]).toContain("already exists");
      expect(readFileSync(join(project, "late.txt"), "utf-8")).toBe("theirs");
    });

    it("does not write through a dangling symlink", () => {
      symlinkSync(join(outside, "target.txt"), join(project, "llms.txt"));
      const result = executeInstallPlan(plan([write("llms.txt")]), project);
      expect(result.installed).toEqual([]);
      expectNothingOutside();
    });

    it("refuses ../ and absolute destinations without creating directories", () => {
      const result = executeInstallPlan(
        plan([
          write("../outside/sub/x.txt"),
          write("../newdir/x.txt"),
          write(join(outside, "abs.txt")),
        ]),
        project,
      );
      expect(result.installed).toEqual([]);
      expect(result.skipped).toHaveLength(3);
      for (const s of result.skipped) expect(s).toContain("outside the project directory");
      expectNothingOutside();
    });

    it("refuses a destination under a symlinked directory pointing outside", () => {
      symlinkSync(outside, join(project, "link"));
      const result = executeInstallPlan(plan([write("link/new/x.txt")]), project);
      expect(result.installed).toEqual([]);
      expect(result.skipped[0]).toContain("outside the project directory");
      expectNothingOutside();
    });
  });

  describe("unsafe or broken parent paths", () => {
    const plan = (actions: InstallAction[]) => ({
      platform: "nextjs" as const,
      actions,
      warnings: [],
      postInstallSteps: [],
    });

    it("skips a destination under a dangling symlink and the executor does not throw", () => {
      symlinkSync(join(outside, "newdir"), join(project, "app"));
      const { actions, warnings } = guardInstallActions([write("app/sub/x.txt")], project);
      expect(actions[0].type).toBe("skip");
      expect(actions[0].reason).toContain("cannot be resolved");
      expect(warnings).toHaveLength(1);

      const result = executeInstallPlan(plan([write("app/sub/x.txt")]), project);
      expect(result.installed).toEqual([]);
      expect(result.skipped[0]).toContain("cannot be resolved");
      expectNothingOutside();
    });

    it("explains a destination under a regular file as a non-directory parent", () => {
      writeFileSync(join(project, "afile"), "x");
      const { actions } = guardInstallActions([write("afile/x/y.txt")], project);
      expect(actions[0].type).toBe("skip");
      expect(actions[0].reason).toContain("not a directory");
      expect(actions[0].reason).not.toContain("outside");
      const result = executeInstallPlan(plan([write("afile/x/y.txt")]), project);
      expect(result.skipped[0]).toContain("not a directory");
    });

    it("reports a failed mkdir or write as skipped instead of throwing", () => {
      if (process.getuid?.() === 0) return;
      mkdirSync(join(project, "ro"));
      chmodSync(join(project, "ro"), 0o500);
      try {
        const result = executeInstallPlan(
          plan([write("ro/sub/x.txt"), write("after.txt")]),
          project,
        );
        expect(result.skipped[0]).toContain("could not be written");
        expect(result.installed).toEqual(["after.txt"]);
      } finally {
        chmodSync(join(project, "ro"), 0o700);
      }
    });

    it("rejects ../sibling when the project directory does not exist", () => {
      const missing = join(root, "missing");
      mkdirSync(join(root, "other"));
      const { actions } = guardInstallActions([write("../other/x.txt")], missing);
      expect(actions[0].type).toBe("skip");
      expect(actions[0].reason).toContain("outside the project directory");
      const result = executeInstallPlan(plan([write("../other/x.txt")]), missing);
      expect(result.installed).toEqual([]);
      expect(readdirSync(join(root, "other"))).toEqual([]);
    });
  });

  describe("planInstall", () => {
    it("guards the plan from a custom resolveInstall and merges warnings", () => {
      writeFileSync(join(project, "mine.txt"), "mine");
      const adapter = makeAdapter({
        resolveInstall: () => ({
          platform: "nextjs",
          actions: [write("mine.txt"), write("../outside/x.txt"), write("fresh.txt")],
          warnings: ["from resolver"],
          postInstallSteps: ["step"],
        }),
      });
      const plan = planInstall(adapter, [], project);
      expect(plan.actions.map((a) => a.type)).toEqual(["skip", "skip", "write"]);
      expect(plan.warnings[0]).toBe("from resolver");
      expect(plan.warnings).toHaveLength(3);
      expect(plan.postInstallSteps).toEqual(["step"]);
    });

    it("guards the fallback plan, including public seed files", () => {
      mkdirSync(join(project, "public"));
      writeFileSync(join(project, "public", "llms.txt"), "hand written");
      const files = [
        makeFile("llms.txt", "# generated"),
        makeFile("llms-full.txt", "# full"),
        makeFile("nextjs/middleware.ts", "export {}"),
      ];
      const plan = planInstall(makeAdapter(), files, project);
      const byDest = Object.fromEntries(plan.actions.map((a) => [a.dest, a.type]));
      expect(byDest["public/llms.txt"]).toBe("skip");
      expect(byDest["public/llms-full.txt"]).toBe("write");
      expect(byDest["middleware.ts"]).toBe("write");
      expect(plan.warnings.some((w) => w.includes("public/llms.txt"))).toBe(true);

      const result = executeInstallPlan(plan, project);
      expect(readFileSync(join(project, "public", "llms.txt"), "utf-8")).toBe("hand written");
      expect(result.installed.sort()).toEqual(["middleware.ts", "public/llms-full.txt"]);
    });

    it("dry-run and real run agree: planned writes equal what is installed", () => {
      mkdirSync(join(project, "app", "llms.txt"), { recursive: true });
      writeFileSync(join(project, "app", "llms.txt", "route.js"), "mine");
      writeFileSync(join(project, "keep.txt"), "mine");
      const adapter = makeAdapter({
        resolveInstall: () => ({
          platform: "nextjs",
          actions: [
            write("app/llms.txt/route.ts"),
            write("keep.txt"),
            write("../outside/x.txt"),
            write("new/a.txt"),
            write("new/b.txt"),
          ],
          warnings: [],
          postInstallSteps: [],
        }),
      });
      const plan = planInstall(adapter, [], project);
      const planned = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
      const result = executeInstallPlan(plan, project);
      expect(result.installed).toEqual(planned);
      expect(planned).toEqual(["new/a.txt", "new/b.txt"]);
      expect(existsSync(join(project, "app", "llms.txt", "route.ts"))).toBe(false);
      expectNothingOutside();
    });
  });
});
