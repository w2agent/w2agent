import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const NEXT_HEADING = "## Next.js (App Router)";
const GENERIC = [
  "## Passes when",
  "## Who fixes it",
  "## Fix (any framework)",
  "## Pitfalls",
  "## Verify",
];

function run(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("w2agent guide", () => {
  it("prints the whole file without --platform", () => {
    const r = run(["guide", "sitemap"]);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("---\nid: sitemap\n")).toBe(true);
    expect(r.stdout).toContain(NEXT_HEADING);
    for (const h of GENERIC) expect(r.stdout).toContain(h);
  });

  it("adds only the matching framework section with --platform", () => {
    const r = run(["guide", "sitemap", "--platform", "nextjs"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(NEXT_HEADING);
    for (const h of GENERIC) expect(r.stdout).toContain(h);
    expect(r.stdout).not.toMatch(/No \w+ section exists/);
  });

  it("gives the generic sections and a note when the platform has no section", () => {
    const r = run(["guide", "sitemap", "--platform", "astro"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(NEXT_HEADING);
    for (const h of GENERIC) expect(r.stdout).toContain(h);
    expect(r.stdout).toContain("No astro section exists in this guide.");
  });

  it("never delivers a framework section for another framework", () => {
    for (const platform of ["wordpress", "shopify", "docusaurus", "nuxt", "astro"]) {
      expect(run(["guide", "canonical", "--platform", platform]).stdout).not.toContain(
        NEXT_HEADING,
      );
    }
  });

  it("emits the JSON document", () => {
    const r = run(["guide", "schema-org", "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({
      ok: true,
      id: "schema-org",
      checks: [
        "schema-org-present",
        "schema-org-type",
        "schema-org-completeness",
        "schema-org-valid",
      ],
      fixBy: "agent",
      platform: null,
    });
    expect(doc.markdown).toContain(NEXT_HEADING);
    const scoped = JSON.parse(
      run(["guide", "markdown-alternate", "--platform", "astro", "--json"]).stdout,
    );
    expect(scoped.platform).toBe("astro");
    expect(scoped.fixBy).toBe("integrate");
    expect(scoped.markdown).not.toContain(NEXT_HEADING);
  });

  it("rejects an unknown guide id with exit 2 and the unknown_guide envelope", () => {
    const r = run(["guide", "nope", "--json"]);
    expect(r.code).toBe(2);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.error.reason).toBe("unknown_guide");
    expect(doc.error.next).toEqual([["w2agent", "schema"]]);
    expect(doc.error.message).toContain("sitemap");
  });

  it("reports an unknown guide id on stderr in text mode", () => {
    const r = run(["guide", "nope"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Unknown guide: nope");
  });

  it("rejects an unknown platform as invalid_argument", () => {
    const r = run(["guide", "sitemap", "--platform", "rails", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.reason).toBe("invalid_argument");
  });

  it("is listed by schema with the valid guide ids", () => {
    const schema = JSON.parse(run(["schema"]).stdout);
    const guide = schema.commands.find((c: { name: string }) => c.name === "guide");
    expect(guide).toBeDefined();
    expect(guide.arguments[0].choices).toEqual([
      "canonical",
      "content-negotiation",
      "forms-structured",
      "llms-txt",
      "local-business",
      "markdown-alternate",
      "og-meta-tags",
      "robots-access",
      "robots",
      "schema-org",
      "security-headers",
      "semantic-html",
      "sitemap",
    ]);
    expect(guide.options.map((o: { long: string }) => o.long)).toEqual(["--platform", "--json"]);
  });
});
