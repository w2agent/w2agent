import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_PLUGINS,
  EXPECTED_LLMS_TXT,
  FORBIDDEN_FRAGMENTS,
  PLUGINS,
  SITE_CONFIG,
  TRAILING_PLUGINS,
  TRAILING_SLASH_CASES,
} from "../../core/tests/helpers/docusaurus-cases";
import w2agentPlugin from "../src/index";

let dir: string;
let siteDir: string;
let outDir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "w2agent-docu-pkg-"));
  siteDir = join(dir, "site");
  outDir = join(dir, "build");
  mkdirSync(siteDir);
  mkdirSync(outDir);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a) => {
    logs.push(a.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function load(options?: { overwrite?: boolean; verbose?: boolean }, siteConfig = SITE_CONFIG) {
  const plugin = w2agentPlugin({ siteDir, siteConfig }, options);
  return {
    postBuild: (plugins: unknown[]) => plugin.postBuild({ siteConfig, outDir, plugins } as never),
  };
}

const llms = () => readFileSync(join(outDir, "llms.txt"), "utf-8");

describe("postBuild — llms.txt from the loaded docs content", () => {
  it("builds llms.txt with permalinks that carry baseUrl", async () => {
    await load().postBuild(PLUGINS);
    expect(llms()).toBe(EXPECTED_LLMS_TXT);
  });

  it("lists no unlisted, draft, old-version or non-docs entries", async () => {
    await load().postBuild(PLUGINS);
    for (const fragment of FORBIDDEN_FRAGMENTS) expect(llms()).not.toContain(fragment);
  });

  it("keeps an existing static/llms.txt and logs one line", async () => {
    mkdirSync(join(siteDir, "static"));
    writeFileSync(join(siteDir, "static", "llms.txt"), "# crawled\n");
    await load().postBuild(PLUGINS);
    expect(() => readFileSync(join(outDir, "llms.txt"))).toThrow();
    expect(logs.filter((l) => l.includes("Keeping existing static/llms.txt"))).toHaveLength(1);
  });

  it("keeps a static llms.txt found in a custom staticDirectories entry", async () => {
    mkdirSync(join(siteDir, "assets"));
    writeFileSync(join(siteDir, "assets", "llms.txt"), "# crawled\n");
    await load({}, { ...SITE_CONFIG, staticDirectories: ["assets"] } as never).postBuild(PLUGINS);
    expect(() => readFileSync(join(outDir, "llms.txt"))).toThrow();
  });

  it("overwrite: true replaces the static file with the generated one", async () => {
    mkdirSync(join(siteDir, "static"));
    writeFileSync(join(siteDir, "static", "llms.txt"), "# crawled\n");
    await load({ overwrite: true }).postBuild(PLUGINS);
    expect(llms()).toBe(EXPECTED_LLMS_TXT);
  });

  it('overwrite: "true" (not boolean true) keeps the static file', async () => {
    mkdirSync(join(siteDir, "static"));
    writeFileSync(join(siteDir, "static", "llms.txt"), "# crawled\n");
    await load({ overwrite: "true" as never }).postBuild(PLUGINS);
    expect(() => readFileSync(join(outDir, "llms.txt"))).toThrow();
  });

  it("names the kept file relative to the site dir in the log", async () => {
    mkdirSync(join(siteDir, "assets"));
    writeFileSync(join(siteDir, "assets", "llms.txt"), "# crawled\n");
    await load({}, { ...SITE_CONFIG, staticDirectories: ["assets"] } as never).postBuild(PLUGINS);
    expect(logs.some((l) => l.includes("Keeping existing assets/llms.txt"))).toBe(true);
  });

  it.each(TRAILING_SLASH_CASES)("follows trailingSlash: $trailingSlash", async (c) => {
    await load({}, { ...SITE_CONFIG, trailingSlash: c.trailingSlash } as never).postBuild(
      TRAILING_PLUGINS,
    );
    const links = [...llms().matchAll(/\]\(https:\/\/docs\.example\.com([^)]*)\)/g)].map(
      (m) => m[1],
    );
    expect(links).toEqual(c.links);
  });

  it("writes nothing when there are no listable docs", async () => {
    await load().postBuild(EMPTY_PLUGINS);
    expect(() => readFileSync(join(outDir, "llms.txt"))).toThrow();
    await load().postBuild([]);
    expect(() => readFileSync(join(outDir, "llms.txt"))).toThrow();
  });

  it("keeps each title and description on one line", async () => {
    await load().postBuild(PLUGINS);
    const lines = llms().split("\n");
    expect(lines).toContain(
      "- [Setup Guide](https://docs.example.com/proj/guides/setup): Install the thing.",
    );
    expect(lines.filter((l) => l.startsWith("- ["))).toHaveLength(4);
  });
});

describe("postBuild — agent-card.json", () => {
  it("copies agent-card.json to .well-known/ when source exists", async () => {
    mkdirSync(join(siteDir, "static", ".well-known"), { recursive: true });
    writeFileSync(join(siteDir, "static", ".well-known", "agent-card.json"), '{"name":"card"}');
    await load().postBuild(PLUGINS);
    expect(readFileSync(join(outDir, ".well-known", "agent-card.json"), "utf-8")).toBe(
      '{"name":"card"}',
    );
  });

  it("skips agent-card copy when source does not exist", async () => {
    await load().postBuild(PLUGINS);
    expect(() => readFileSync(join(outDir, ".well-known", "agent-card.json"))).toThrow();
  });
});

describe("postBuild — webhook", () => {
  it("fires webhook when W2AGENT_WEBHOOK_URL is set", async () => {
    vi.stubEnv("W2AGENT_WEBHOOK_URL", "https://hook.example.com");
    const mockFetch = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", mockFetch);
    await load().postBuild(PLUGINS);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hook.example.com",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not fire webhook when W2AGENT_WEBHOOK_URL is not set", async () => {
    vi.stubEnv("W2AGENT_WEBHOOK_URL", "");
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    await load().postBuild(PLUGINS);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
