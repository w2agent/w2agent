import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import { resolveNextjsInstall } from "../src/adapters/nextjs/install.js";
import { generateNextjsIntegration } from "../src/adapters/nextjs/templates.js";
import type { GenerateContext, GeneratedFile, PageMarkdown } from "../src/generate/types.js";

const LINK_LIST = "# acme\n\n## Pages\n\n- [Home](https://acme.example/): Main page\n";
const HOME_BODY =
  "Emergency plumbing in Springfield, open 24 hours.\n\n## Services\n\n- Drain repair";

function page(url: string, title: string, markdown: string): PageMarkdown {
  return { url, title, description: "", markdown };
}

function ctxWith(pages: PageMarkdown[]): GenerateContext {
  return {
    pages,
    rawPages: [],
    metadata: { baseUrl: "https://acme.example", wellKnown: {} },
    baseUrl: "https://acme.example",
  };
}

const coreFiles: GeneratedFile[] = [
  { filename: "llms.txt", content: LINK_LIST, size: LINK_LIST.length },
  { filename: "llms-full.txt", content: "# full\n", size: 7 },
];

const seedOf = (files: GeneratedFile[]) =>
  files.find((f) => f.filename === "nextjs/.w2agent/index.md")?.content;

describe("Next.js home markdown seed", () => {
  it("is the home page's own content under its title, not the llms.txt link list", () => {
    const files = nextjsAdapter.generateIntegration(
      ctxWith([
        page("https://acme.example/about", "About", "About us"),
        page("https://acme.example/", "Acme Plumbing", HOME_BODY),
      ]),
      coreFiles,
    );
    const seed = seedOf(files);
    expect(seed).toBe(`# Acme Plumbing\n\n${HOME_BODY}\n`);
    expect(seed).not.toContain("## Pages");
    expect(seed).not.toMatch(/^---/);
  });

  it("does not repeat an H1 the body already starts with", () => {
    const files = nextjsAdapter.generateIntegration(
      ctxWith([page("https://acme.example/", "Acme | Home", "# Acme Plumbing\n\nHello")]),
      coreFiles,
    );
    expect(seedOf(files)).toBe("# Acme Plumbing\n\nHello\n");
  });

  it("under a base path, is the crawled start page, not the origin root", () => {
    const files = nextjsAdapter.generateIntegration(
      {
        ...ctxWith([
          page("https://acme.example/docs/guide", "Guide", "Guide body"),
          page("https://acme.example/docs", "Docs Home", HOME_BODY),
        ]),
        startUrl: "https://acme.example/docs/",
      },
      coreFiles,
    );
    expect(seedOf(files)).toBe(`# Docs Home\n\n${HOME_BODY}\n`);
  });

  it("is omitted when the home page has no body, even with a title", () => {
    const files = nextjsAdapter.generateIntegration(
      ctxWith([page("https://acme.example/", "Acme", "  \n")]),
      coreFiles,
    );
    expect(seedOf(files)).toBeUndefined();
  });

  it("is omitted when the crawl has no home page", () => {
    const files = nextjsAdapter.generateIntegration(
      ctxWith([page("https://acme.example/about", "About", "About us")]),
      coreFiles,
    );
    expect(seedOf(files)).toBeUndefined();
  });
});

describe("Next.js /index.md route", () => {
  let dir: string;
  const route = generateNextjsIntegration(LINK_LIST, "", undefined, "https://acme.example").find(
    (f) => f.filename === "nextjs/app/index.md/route.ts",
  )?.content as string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-indexmd-"));
    mkdirSync(join(dir, ".w2agent"));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  async function get(): Promise<{ body: string; type: string }> {
    const source = route
      .replace(/^import .*$/gm, "")
      .replace("export const revalidate", "const revalidate")
      .replace("export async function GET", "async function GET");
    const NextResponse = class {
      headers: Record<string, string>;
      constructor(
        public body: string,
        init: { headers: Record<string, string> },
      ) {
        this.headers = init.headers;
      }
    };
    const fs = await import("node:fs");
    const path = await import("node:path");
    const run = new Function("NextResponse", "fs", "path", "process", `${source}\nreturn GET();`);
    const res = await run(NextResponse, fs, path, process);
    return { body: res.body, type: res.headers["Content-Type"] };
  }

  it("serves .w2agent/index.md when present", async () => {
    writeFileSync(join(dir, ".w2agent", "index.md"), "# Home\n\nown content\n");
    writeFileSync(join(dir, ".w2agent", "llms.txt"), LINK_LIST);
    const res = await get();
    expect(res.body).toBe("# Home\n\nown content\n");
    expect(res.type).toBe("text/markdown; charset=utf-8");
  });

  it("falls back to llms.txt, then to a minimal index", async () => {
    writeFileSync(join(dir, ".w2agent", "llms.txt"), LINK_LIST);
    expect((await get()).body).toBe(LINK_LIST);
    rmSync(join(dir, ".w2agent", "llms.txt"));
    expect((await get()).body).toContain("# acme.example");
  });
});

describe("Next.js build script refreshes the home markdown", () => {
  const script = generateNextjsIntegration("", "", undefined, "https://acme.example").find(
    (f) => f.filename === "nextjs/w2agent-build.mjs",
  )?.content as string;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-build-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "w2agent-build.mjs"), script);
    // Stand-in for `npx --no -- w2agent generate ...`: writes what the markdown format writes.
    const fake = [
      "#!/bin/sh",
      'case "$*" in *llms-txt,full,markdown*) ;; *) exit 3 ;; esac',
      "mkdir -p .w2agent/markdown",
      "printf 'llms' > .w2agent/llms.txt",
      `printf -- '---\\nurl: "https://acme.example/"\\ntitle: "Acme Plumbing"\\n---\\n\\nFresh home body\\n' > .w2agent/markdown/index.md`,
      "printf 'other' > .w2agent/markdown/about.md",
    ].join("\n");
    writeFileSync(join(dir, "bin", "npx"), fake);
    chmodSync(join(dir, "bin", "npx"), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform === "win32")(
    "writes .w2agent/index.md without front matter and drops the per-page files",
    () => {
      mkdirSync(join(dir, ".w2agent"));
      writeFileSync(join(dir, ".w2agent", "index.md"), "stale");
      execFileSync("node", ["w2agent-build.mjs"], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
        stdio: "pipe",
      });
      expect(readFileSync(join(dir, ".w2agent", "index.md"), "utf-8")).toBe(
        "# Acme Plumbing\n\nFresh home body\n",
      );
      expect(existsSync(join(dir, ".w2agent", "markdown"))).toBe(false);
    },
  );
});

describe("Next.js build script start page selection", () => {
  const script = generateNextjsIntegration("", "", undefined, "https://acme.example").find(
    (f) => f.filename === "nextjs/w2agent-build.mjs",
  )?.content as string;
  let dir: string;

  const front = (url: string, title: string) => `---\nurl: "${url}"\ntitle: "${title}"\n---\n\n`;
  function build(siteUrl: string, pages: Record<string, string>) {
    writeFileSync(join(dir, "w2agent-build.mjs"), script);
    const lines = ["#!/bin/sh", "mkdir -p .w2agent/markdown"];
    for (const [name, content] of Object.entries(pages)) {
      lines.push(`printf '%s' '${content.replace(/'/g, "'\\''")}' > .w2agent/markdown/${name}`);
    }
    writeFileSync(join(dir, "bin", "npx"), lines.join("\n"));
    chmodSync(join(dir, "bin", "npx"), 0o755);
    execFileSync("node", ["w2agent-build.mjs"], {
      cwd: dir,
      env: { ...process.env, SITE_URL: siteUrl, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
      stdio: "pipe",
    });
  }
  const indexPath = () => join(dir, ".w2agent", "index.md");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-build-start-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, ".w2agent"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform === "win32")(
    "picks the start page by its front matter url under a base path",
    () => {
      build("https://acme.example/docs/", {
        "docs.md": `${front("https://acme.example/docs", "Docs Home")}Docs home body\n`,
        "docs-guide.md": `${front("https://acme.example/docs/guide", "Guide")}Guide body\n`,
        "index.md": `${front("https://acme.example/", "Root")}Root body\n`,
      });
      expect(readFileSync(indexPath(), "utf-8")).toBe("# Docs Home\n\nDocs home body\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "matches the home page when SITE_URL has no scheme, as generate does",
    () => {
      build("acme.example", {
        "index.md": `${front("https://acme.example/", "Acme")}Home body\n`,
        "about.md": `${front("https://acme.example/about", "About")}About body\n`,
      });
      expect(readFileSync(indexPath(), "utf-8")).toBe("# Acme\n\nHome body\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "writes nothing when the start page has no body, leaving an existing seed",
    () => {
      writeFileSync(indexPath(), "seed");
      build("https://acme.example", {
        "index.md": `${front("https://acme.example/", "Acme")}\n`,
      });
      expect(readFileSync(indexPath(), "utf-8")).toBe("seed");
      rmSync(indexPath());
      build("https://acme.example", {
        "index.md": `${front("https://acme.example/", "Acme")}\n`,
      });
      expect(existsSync(indexPath())).toBe(false);
    },
  );
});

describe("Next.js install of the home markdown seed", () => {
  let dir: string;
  const files = (): GeneratedFile[] =>
    generateNextjsIntegration(LINK_LIST, "# full", undefined, "https://acme.example", "# Home\n");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "w2agent-install-"));
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("plans a write for a new project", () => {
    const plan = resolveNextjsInstall(files(), dir);
    expect(plan.actions).toContainEqual({
      type: "write",
      dest: ".w2agent/index.md",
      content: "# Home\n",
    });
  });

  it("never overwrites an existing .w2agent/index.md", () => {
    mkdirSync(join(dir, ".w2agent"));
    writeFileSync(join(dir, ".w2agent", "index.md"), "mine");
    const plan = resolveNextjsInstall(files(), dir);
    expect(plan.actions.find((a) => a.dest === ".w2agent/index.md")?.type).toBe("skip");
  });

  it("static export still installs the seed and the route", () => {
    writeFileSync(join(dir, "next.config.js"), 'module.exports = { output: "export" };\n');
    const plan = resolveNextjsInstall(files(), dir);
    const dests = plan.actions.filter((a) => a.type === "write").map((a) => a.dest);
    expect(dests).toContain(".w2agent/index.md");
    expect(dests).toContain("app/index.md/route.ts");
  });
});
