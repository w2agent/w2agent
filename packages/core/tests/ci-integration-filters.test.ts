import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const run = promisify(execFile);
const CORE_DIR = resolve(__dirname, "..");
const WORKFLOW = resolve(CORE_DIR, "../../.github/workflows/integration-tests.yml");
const VITEST = resolve(CORE_DIR, "node_modules/.bin/vitest");

interface Step {
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  strategy?: {
    matrix?: { platform?: string[]; include?: { platform: string; pattern: string }[] };
  };
  steps: Step[];
}

const workflow = parse(readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, Job> };

function integrationRuns(job: Job): Step[] {
  return job.steps.filter((s) => s.run?.includes("test:integration"));
}

function literalPattern(step: Step): string | undefined {
  const m = step.run?.match(/-t\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function jobPatterns(): { label: string; pattern: string }[] {
  const out: { label: string; pattern: string }[] = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const matrix = job.strategy?.matrix;
    if (matrix?.include) {
      for (const inc of matrix.include)
        out.push({ label: `${id}:${inc.platform}`, pattern: inc.pattern });
    } else {
      for (const step of integrationRuns(job)) {
        const pattern = literalPattern(step);
        if (pattern !== undefined) out.push({ label: id, pattern });
      }
    }
  }
  return out;
}

async function list(args: string[]): Promise<string[]> {
  const { stdout } = await run(
    VITEST,
    ["list", "--config", "vitest.integration.config.ts", "--json", ...args],
    { cwd: CORE_DIR, maxBuffer: 16 * 1024 * 1024 },
  );
  return (JSON.parse(stdout) as { name: string }[]).map((t) => t.name);
}

describe("integration CI filters", () => {
  const patterns = jobPatterns();
  let all: string[] = [];
  let selected: Map<string, string[]> = new Map();

  beforeAll(async () => {
    all = await list([]);
    const entries = await Promise.all(
      patterns.map(async (p) => [p.label, await list(["-t", p.pattern])] as const),
    );
    selected = new Map(entries);
  }, 240_000);

  it("never passes a bare -- before vitest flags", () => {
    const runs = Object.values(workflow.jobs).flatMap(integrationRuns);
    expect(runs.length).toBeGreaterThan(0);
    for (const step of runs) {
      expect(step.run).not.toMatch(/\s--(\s|$)/);
    }
  });

  it("gives every matrix platform exactly one pattern", () => {
    const matrix = workflow.jobs.integration.strategy?.matrix;
    expect(matrix?.platform?.length).toBeGreaterThan(0);
    for (const platform of matrix?.platform ?? []) {
      const found = (matrix?.include ?? []).filter((i) => i.platform === platform && i.pattern);
      expect(found, platform).toHaveLength(1);
    }
    for (const inc of matrix?.include ?? []) {
      expect(matrix?.platform, inc.platform).toContain(inc.platform);
    }
  });

  it("runs the matrix pattern from the include entry through PATTERN", () => {
    const step = integrationRuns(workflow.jobs.integration)[0];
    expect(step.env?.PATTERN).toBe(`\${{ matrix.pattern }}`);
    expect(step.run).toMatch(/-t "\$PATTERN"/);
  });

  it("has a pattern for the conformance job", () => {
    expect(patterns.some((p) => p.label === "integration-conformance")).toBe(true);
  });

  it("selects at least one test per pattern", () => {
    expect(all.length).toBeGreaterThan(0);
    for (const p of patterns) {
      expect(selected.get(p.label)?.length, `${p.label} (${p.pattern})`).toBeGreaterThan(0);
    }
  });

  it("selects disjoint tests across patterns", () => {
    const owner = new Map<string, string>();
    for (const p of patterns) {
      for (const name of selected.get(p.label) ?? []) {
        expect(
          owner.get(name),
          `"${name}" is run by ${owner.get(name)} and ${p.label}`,
        ).toBeUndefined();
        owner.set(name, p.label);
      }
    }
  });

  it("covers every integration test", () => {
    const covered = new Set(patterns.flatMap((p) => selected.get(p.label) ?? []));
    const missing = all.filter((name) => !covered.has(name));
    expect(missing, "tests no CI job runs").toEqual([]);
  });
});
