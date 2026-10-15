import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSkillsIndex, discoveryChecks } from "../../src/audit/checks/discovery.js";
import { probeSiteMetadata } from "../../src/audit/crawler.js";
import type { CheckResult, SiteMetadata } from "../../src/audit/types.js";
import { DEFAULT_OPTIONS } from "../../src/audit/types.js";

const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const DIGEST = `sha256:${"a".repeat(64)}`;
const KEY = "agent-skills/index.json";

const entry = (over: Record<string, unknown> = {}) => ({
  name: "my-skill",
  type: "skill-md",
  description: "Does a thing",
  url: "/.well-known/agent-skills/my-skill/SKILL.md",
  digest: DIGEST,
  ...over,
});

const index = (over: Record<string, unknown> = {}) => ({
  $schema: SCHEMA,
  skills: [entry()],
  ...over,
});

const run = (raw: string | undefined, baseUrl = "https://example.com"): CheckResult => {
  const metadata: SiteMetadata = {
    baseUrl,
    wellKnown: raw === undefined ? {} : { [KEY]: raw },
  };
  return agentSkillsIndex.run([], metadata) as CheckResult;
};
const runObj = (obj: unknown) => run(JSON.stringify(obj));

const expectFail = (obj: unknown, messagePart?: string | RegExp) => {
  const r = runObj(obj);
  expect(r).toMatchObject({ status: "fail", score: 0, tracked: true });
  expect(r.fixSnippet).toContain("cloudflare/agent-skills-discovery-rfc");
  if (messagePart) expect(r.message).toMatch(messagePart);
  return r;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent-skills-index", () => {
  it("is a tracked weight-0 agent-discovery check registered in discoveryChecks", () => {
    expect(agentSkillsIndex).toMatchObject({
      id: "agent-skills-index",
      category: "agent-discovery",
      weight: 0,
      tracked: true,
      severity: "info",
    });
    expect(discoveryChecks).toContain(agentSkillsIndex);
  });

  it("passes a valid v0.2 index with details and no fixSnippet", () => {
    const r = runObj(
      index({
        skills: [
          entry(),
          entry({ name: "pdf", type: "archive", url: "https://github.com/x/y.tgz" }),
        ],
      }),
    );
    expect(r).toMatchObject({ status: "pass", score: 100, tracked: true, weight: 0 });
    expect(r.message).toBe("Agent Skills index lists 2 skill(s)");
    expect(r.details).toBe("my-skill (skill-md)\npdf (archive)");
    expect(r.fixSnippet).toBeUndefined();
  });

  it("caps details at 10 lines", () => {
    const skills = Array.from({ length: 12 }, (_, i) => entry({ name: `s${i}` }));
    expect(runObj(index({ skills })).details?.split("\n")).toHaveLength(10);
  });

  it("ignores unknown fields at top level and per entry", () => {
    const r = runObj(index({ extra: 1, skills: [entry({ files: ["a"], future: { x: 1 } })] }));
    expect(r).toMatchObject({ status: "pass", score: 100 });
  });

  it("skips when absent", () => {
    const r = run(undefined);
    expect(r).toMatchObject({ status: "skip", score: 0, tracked: true });
    expect(r.message).toContain("/.well-known/agent-skills/index.json");
    expect(r.fixSnippet).toBeUndefined();
  });

  it("fails on invalid JSON and non-objects", () => {
    expect(run("{nope")).toMatchObject({ status: "fail", score: 0 });
    expect(run("[]")).toMatchObject({ status: "fail", score: 0 });
    expect(run('"str"')).toMatchObject({ status: "fail", score: 0 });
  });

  it("fails on unknown $schema naming the URI", () => {
    const r = expectFail(index({ $schema: "https://example.com/other.json" }), /other\.json/);
    expect(r.message).toContain("SHOULD NOT process");
    expectFail(index({ $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json/" }));
  });

  it("fails on non-string $schema", () => {
    expectFail(index({ $schema: 2 }), /not a string/);
    expectFail(index({ $schema: null }), /not a string/);
  });

  it("fails on missing, non-array, and empty skills", () => {
    expectFail({ $schema: SCHEMA }, /missing or not an array/);
    expectFail(index({ skills: {} }), /missing or not an array/);
    expectFail(index({ skills: [] }), /lists no skills/);
  });

  describe("entry validation", () => {
    const bad = (over: Record<string, unknown>, re: RegExp) =>
      expectFail(index({ skills: [entry(over)] }), re);

    it("rejects non-object entries", () => {
      expectFail(index({ skills: ["x"] }), /skills\[0\]: is not an object/);
      expectFail(index({ skills: [null] }), /skills\[0\]/);
      expectFail(index({ skills: [[]] }), /skills\[0\]/);
    });

    it("validates name boundaries and pattern", () => {
      expect(runObj(index({ skills: [entry({ name: "a".repeat(64) })] })).status).toBe("pass");
      expect(runObj(index({ skills: [entry({ name: "a" })] })).status).toBe("pass");
      expect(runObj(index({ skills: [entry({ name: "a-b-1" })] })).status).toBe("pass");
      bad({ name: "a".repeat(65) }, /`name`/);
      bad({ name: "" }, /`name`/);
      bad({ name: undefined }, /`name`/);
      bad({ name: 5 }, /`name`/);
      bad({ name: "MySkill" }, /`name`/);
      bad({ name: "a--b" }, /`name`/);
      bad({ name: "-a" }, /`name`/);
      bad({ name: "a-" }, /`name`/);
      bad({ name: "a_b" }, /`name`/);
    });

    it("validates type", () => {
      expect(runObj(index({ skills: [entry({ type: "archive" })] })).status).toBe("pass");
      bad({ type: "zip" }, /`type`/);
      bad({ type: undefined }, /`type`/);
      bad({ type: "SKILL-MD" }, /`type`/);
    });

    it("validates description boundaries", () => {
      expect(runObj(index({ skills: [entry({ description: "d".repeat(1024) })] })).status).toBe(
        "pass",
      );
      bad({ description: "d".repeat(1025) }, /`description`/);
      expect(runObj(index({ skills: [entry({ description: "😀".repeat(600) })] })).status).toBe(
        "pass",
      );
      bad({ description: "😀".repeat(1025) }, /`description`/);
      bad({ description: "" }, /`description`/);
      bad({ description: "   " }, /`description`/);
      bad({ description: undefined }, /`description`/);
      bad({ description: 3 }, /`description`/);
    });

    it("validates url", () => {
      for (const url of [
        "https://github.com/x/y.tgz",
        "/.well-known/agent-skills/x.tar.gz",
        "x/SKILL.md",
      ]) {
        expect(runObj(index({ skills: [entry({ url })] })).status, url).toBe("pass");
      }
      bad({ url: undefined }, /`url`/);
      bad({ url: "" }, /`url`/);
      bad({ url: 7 }, /`url`/);
      bad({ url: "   " }, /non-empty string/);
      bad({ url: "#frag" }, /index itself/);
      for (const url of ["?a", "?artifact=my-skill"]) {
        expect(runObj(index({ skills: [entry({ url })] })).status, url).toBe("pass");
      }
      bad({ url: "" + "/.well-known/agent-skills/index.json#x" }, /index itself/);
      expect(runObj(index({ skills: [entry({ url: "//cdn.example.com/x.tar.gz" })] })).status).toBe(
        "pass",
      );
      bad({ url: "ftp://example.com/x" }, /http\(s\)/);
      bad({ url: "javascript:alert(1)" }, /http\(s\)/);
      bad({ url: "http://" }, /cannot be resolved/);
    });

    it("validates digest", () => {
      bad({ digest: `sha256:${"A".repeat(64)}` }, /`digest`/);
      bad({ digest: `sha256:${"a".repeat(63)}` }, /`digest`/);
      bad({ digest: `sha256:${"a".repeat(65)}` }, /`digest`/);
      bad({ digest: "a".repeat(64) }, /`digest`/);
      bad({ digest: `sha1:${"a".repeat(64)}` }, /`digest`/);
      bad({ digest: undefined }, /`digest`/);
      bad({ digest: 1 }, /`digest`/);
    });

    it("names the skill and index in each problem", () => {
      const r = bad({ type: "zip" }, /skills\[0\] \(my-skill\): `type`/);
      expect(r.message).toContain("Agent Skills index invalid");
    });

    it("lists at most 3 problems and counts the rest", () => {
      const r = expectFail(
        index({
          skills: [
            entry({ name: "A", type: "x", description: "", url: "", digest: "x" }),
            entry({ name: "B" }),
          ],
        }),
      );
      expect(r.message.split("; ")).toHaveLength(3);
      expect(r.message).toContain("(+3 more)");
      expect(r.message).toContain("skills[0] (A)");
    });

    it("does not add a suffix at exactly 3 problems", () => {
      const r = expectFail(index({ skills: [entry({ type: "x", description: "", digest: "x" })] }));
      expect(r.message).not.toContain("more)");
    });

    it("reports problems from later entries by index", () => {
      const r = expectFail(
        index({ skills: [entry(), entry({ name: "ok" }), entry({ type: "x" })] }),
      );
      expect(r.message).toContain("skills[2] (my-skill)");
      expect(r.message).not.toContain("skills[0]");
    });
  });

  describe("$schema absent", () => {
    it("is partial 50 when every entry is valid", () => {
      const { $schema: _omit, ...rest } = index();
      const r = runObj(rest);
      expect(r).toMatchObject({ status: "partial", score: 50, tracked: true });
      expect(r.message).toContain("v0.2.0 requires");
      expect(r.message).toContain("v0.1.0");
      expect(r.details).toBe("my-skill (skill-md)");
      expect(r.fixSnippet).toBeDefined();
    });

    it("fails with $schema missing first when entries are invalid", () => {
      const r = expectFail({ skills: [entry({ type: "zip" })] });
      expect(r.message).toContain("invalid: $schema missing; skills[0]");
    });

    it("still fails on empty or missing skills", () => {
      expectFail({ skills: [] }, /lists no skills/);
      expectFail({}, /missing or not an array/);
    });
  });

  describe("size cap", () => {
    it("fails a valid 300 KB body with an exceeds-256 KB message", () => {
      const raw = JSON.stringify(index({ pad: "x".repeat(300 * 1024) }));
      const r = run(raw);
      expect(r).toMatchObject({ status: "fail", score: 0 });
      expect(r.message).toContain("exceeds 256 KB");
    });

    it("passes a body just under the cap", () => {
      const base = JSON.stringify(index({ pad: "" }));
      const pad = "x".repeat(256 * 1024 - Buffer.byteLength(base));
      const raw = JSON.stringify(index({ pad }));
      expect(Buffer.byteLength(raw)).toBe(256 * 1024);
      expect(run(raw).status).toBe("pass");
    });

    it("counts bytes, not characters", () => {
      const raw = JSON.stringify(index({ pad: "é".repeat(130 * 1024) }));
      expect(raw.length).toBeLessThan(256 * 1024);
      expect(run(raw).message).toContain("exceeds 256 KB");
    });

    it("fails via probeSiteMetadata when the server sends a >1 MB JSON body", async () => {
      const big = JSON.stringify(index({ pad: "x".repeat(1.5 * 1024 * 1024) }));
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/.well-known/agent-skills/index.json") {
          return new Response(big, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
      });
      const metadata = await probeSiteMetadata("https://example.com", {
        ...DEFAULT_OPTIONS,
        maxPages: 1,
        requestDelay: 0,
        timeout: 5000,
      });
      expect(metadata.wellKnown[KEY]).toBeDefined();
      const r = agentSkillsIndex.run([], metadata) as CheckResult;
      expect(r).toMatchObject({ status: "fail", score: 0 });
      expect(r.message).toContain("exceeds 256 KB");
    });
  });
});
