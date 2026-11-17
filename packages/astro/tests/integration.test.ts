import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import w2agentAstro, { type W2agentAstroOptions } from "../src/index";

type Hook = (...args: unknown[]) => unknown;

function getHook(integration: ReturnType<typeof w2agentAstro>, hookName: string): Hook {
  return (integration.hooks as Record<string, unknown>)[hookName] as Hook;
}

function html(opts: { title?: string; description?: string; head?: string } = {}): string {
  const title = opts.title === undefined ? "" : `<title>${opts.title}</title>`;
  const desc =
    opts.description === undefined ? "" : `<meta name="description" content="${opts.description}">`;
  return `<!doctype html><html><head>${title}${desc}${opts.head ?? ""}</head><body></body></html>`;
}

let root: string;
let outDir: string;
let logs: string[];

function put(rel: string, content: string, base = outDir): void {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

interface Setup {
  site?: string;
  base?: string;
  trailingSlash?: string;
  output?: string;
  format?: string;
  options?: W2agentAstroOptions;
}

async function build(
  pages: string[],
  setup: Setup = {},
): Promise<{ llms: string | null; integration: ReturnType<typeof w2agentAstro> }> {
  const integration = w2agentAstro(setup.options);
  getHook(
    integration,
    "astro:config:setup",
  )({
    config: {
      root: pathToFileURL(`${root}/`),
      publicDir: pathToFileURL(`${root}/public/`),
      site: setup.site,
      base: setup.base ?? "/",
      trailingSlash: setup.trailingSlash ?? "ignore",
      output: setup.output ?? "static",
      build: { format: setup.format ?? "directory" },
    },
    injectRoute: vi.fn(),
  });
  await getHook(
    integration,
    "astro:build:done",
  )({
    dir: pathToFileURL(`${outDir}/`),
    pages: pages.map((pathname) => ({ pathname })),
  });
  const llmsPath = join(outDir, "llms.txt");
  return { llms: existsSync(llmsPath) ? readFileSync(llmsPath, "utf-8") : null, integration };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "w2agent-astro-"));
  outDir = join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("astro:build:done — llms.txt from built pages", () => {
  it("lists built pages with site, base, and the real (slug) pathname", async () => {
    put("index.html", html({ title: "Home", description: "Welcome" }));
    put("blog/hello-renamed/index.html", html({ title: "Hello", description: "A post" }));
    const { llms } = await build(["", "blog/hello-renamed/"], {
      site: "https://example.com",
      base: "/docs",
    });
    expect(llms).toContain("# AI Content Index");
    expect(llms).toContain("## Pages\n\n- [Home](https://example.com/docs/): Welcome");
    expect(llms).toContain(
      "## Blog\n\n- [Hello](https://example.com/docs/blog/hello-renamed/): A post",
    );
    expect(llms).not.toContain("https://example.com/blog/");
  });

  it("does not list a draft that is not in the build page list", async () => {
    put("index.html", html({ title: "Home" }));
    put(
      "src/content/blog/secret.md",
      "---\ntitle: SECRET unreleased pricing\ndraft: true\n---\nx",
      root,
    );
    const { llms } = await build([""], { site: "https://example.com" });
    expect(llms).not.toContain("SECRET");
    expect(llms).toContain("[Home](https://example.com/)");
  });

  it("normalises base without leading slash and with trailing slash", async () => {
    put("a/b/index.html", html({ title: "AB" }));
    const { llms } = await build(["a/b/"], { site: "https://example.com/", base: "docs//x/" });
    expect(llms).toContain("(https://example.com/docs/x/a/b/)");
  });

  it("uses a root-relative URL that starts with the base when there is no site", async () => {
    put("a/b/index.html", html({ title: "AB" }));
    const { llms } = await build(["a/b/"], { base: "/docs" });
    expect(llms).toContain("[AB](/docs/a/b/)");
  });

  it("finds pages for build.format file", async () => {
    put("blog/hello.html", html({ title: "Hello" }));
    put("index.html", html({ title: "Home" }));
    const { llms } = await build(["", "blog/hello"], {
      site: "https://example.com",
      format: "file",
    });
    expect(llms).toContain("[Hello](https://example.com/blog/hello)");
    expect(llms).toContain("[Home](https://example.com/)");
  });

  it("finds a file-format page reported with a trailing slash", async () => {
    put("blog/hello.html", html({ title: "Hello" }));
    const { llms } = await build(["blog/hello/"], { site: "https://example.com", format: "file" });
    expect(llms).toContain("[Hello](https://example.com/blog/hello/)");
  });

  it("skips endpoints (no HTML), 404 and 500 pages, and pages without a title", async () => {
    put("index.html", html({ title: "Home" }));
    put("404.html", html({ title: "Not found" }));
    put("500/index.html", html({ title: "Error" }));
    put("untitled/index.html", html({ description: "no title" }));
    const { llms } = await build(["", "404", "500", "rss.xml", "untitled/", "api/data.json"], {
      site: "https://example.com",
    });
    expect(llms).toContain("[Home]");
    expect(llms).not.toContain("Not found");
    expect(llms).not.toContain("Error");
    expect(llms).not.toContain("rss.xml");
    expect(llms).not.toContain("no title");
  });

  it("skips pages with a robots noindex meta (either attribute order)", async () => {
    put("index.html", html({ title: "Home" }));
    put(
      "a/index.html",
      html({ title: "Hidden A", head: '<meta name="robots" content="noindex, nofollow">' }),
    );
    put(
      "b/index.html",
      html({ title: "Hidden B", head: "<meta content='NoIndex' name='robots'>" }),
    );
    put(
      "c/index.html",
      html({ title: "Visible C", head: '<meta name="robots" content="index,follow">' }),
    );
    const { llms } = await build(["", "a/", "b/", "c/"], { site: "https://example.com" });
    expect(llms).not.toContain("Hidden");
    expect(llms).toContain("Visible C");
  });

  it("decodes entities and collapses a multi-line title to one line", async () => {
    put(
      "x/y/index.html",
      html({
        title: "Tom &amp; Jerry\n   &lt;b&gt; &quot;q&quot; &#39;s&#39; &#x41;&#66;",
        description: "line one\n  line &amp; two",
      }),
    );
    const { llms } = await build(["x/y/"], { site: "https://example.com" });
    expect(llms).toContain(
      "- [Tom & Jerry <b> \"q\" 's' AB](https://example.com/x/y/): line one line & two",
    );
  });

  it("reads the description meta with content before name", async () => {
    put(
      "index.html",
      '<html><head><title>Home</title><meta content="Desc here" name="description"></head></html>',
    );
    const { llms } = await build([""], { site: "https://example.com" });
    expect(llms).toContain("[Home](https://example.com/): Desc here");
  });

  it("groups by the first path segment and title-cases dashes", async () => {
    put("getting-started/intro/index.html", html({ title: "Intro" }));
    put("about/index.html", html({ title: "About" }));
    const { llms } = await build(["getting-started/intro/", "about/"], {
      site: "https://example.com",
    });
    expect(llms).toContain("## Getting started\n\n- [Intro]");
    expect(llms).toContain("## Pages\n\n- [About]");
  });

  it("applies trailingSlash always", async () => {
    put("blog/index.html", html({ title: "Blog" }));
    put("index.html", html({ title: "Home" }));
    const { llms } = await build(["", "blog"], {
      site: "https://example.com",
      base: "/docs",
      trailingSlash: "always",
    });
    expect(llms).toContain("(https://example.com/docs/blog/)");
    expect(llms).toContain("(https://example.com/docs/)");
  });

  it("applies trailingSlash never but keeps the base root", async () => {
    put("blog/index.html", html({ title: "Blog" }));
    put("index.html", html({ title: "Home" }));
    const { llms } = await build(["", "blog/"], {
      site: "https://example.com",
      base: "/docs",
      trailingSlash: "never",
    });
    expect(llms).toContain("(https://example.com/docs/blog)");
    expect(llms).not.toContain("(https://example.com/docs/blog/)");
    expect(llms).toContain("(https://example.com/docs/)");
  });

  it("keeps the pathname as reported for trailingSlash ignore", async () => {
    put("blog/index.html", html({ title: "Blog" }));
    put("blog/post.html", html({ title: "Post" }));
    const { llms } = await build(["blog/", "blog/post"], { site: "https://example.com" });
    expect(llms).toContain("(https://example.com/blog/)");
    expect(llms).toContain("(https://example.com/blog/post)");
  });
});

describe("astro:build:done — existing public/llms.txt", () => {
  beforeEach(() => {
    put("index.html", html({ title: "Home" }));
    put("llms.txt", "# crawled marker\n");
    put("llms.txt", "# crawled marker\n", join(root, "public"));
  });

  it("keeps the crawled file and logs its path", async () => {
    const { llms } = await build([""], { site: "https://example.com" });
    expect(llms).toBe("# crawled marker\n");
    expect(logs.join("\n")).toContain("Keeping existing public/llms.txt");
  });

  it("replaces it when overwrite is true", async () => {
    const { llms } = await build([""], {
      site: "https://example.com",
      options: { overwrite: true },
    });
    expect(llms).toContain("# AI Content Index");
    expect(llms).toContain("[Home](https://example.com/)");
  });

  it("only treats boolean true as overwrite", async () => {
    const { llms } = await build([""], {
      site: "https://example.com",
      options: { overwrite: "true" as unknown as boolean },
    });
    expect(llms).toBe("# crawled marker\n");
  });
});

describe("astro:build:done — nothing to list", () => {
  it("writes no llms.txt for server output (empty page list)", async () => {
    const { llms } = await build([], { site: "https://example.com", output: "server" });
    expect(llms).toBeNull();
    expect(logs.join("\n")).not.toContain("Generated");
  });

  it("leaves a copied public/llms.txt alone when no page is listable", async () => {
    put("llms.txt", "# crawled marker\n");
    const { llms } = await build([], { site: "https://example.com" });
    expect(llms).toBe("# crawled marker\n");
    expect(logs.join("\n")).not.toContain("Keeping");
  });
});

describe("astro:build:done — agent-card.json", () => {
  it("copies agent-card.json from publicDir to .well-known/", async () => {
    put(".well-known/agent-card.json", '{"name":"A"}', join(root, "public"));
    await build([]);
    expect(readFileSync(join(outDir, ".well-known", "agent-card.json"), "utf-8")).toBe(
      '{"name":"A"}',
    );
  });

  it("uses a custom publicDir", async () => {
    put(".well-known/agent-card.json", '{"name":"C"}', join(root, "static-files"));
    const integration = w2agentAstro();
    getHook(
      integration,
      "astro:config:setup",
    )({
      config: {
        root: pathToFileURL(`${root}/`),
        publicDir: pathToFileURL(`${root}/static-files/`),
        base: "/",
        output: "static",
      },
      injectRoute: vi.fn(),
    });
    await getHook(integration, "astro:build:done")({ dir: pathToFileURL(`${outDir}/`), pages: [] });
    expect(readFileSync(join(outDir, ".well-known", "agent-card.json"), "utf-8")).toBe(
      '{"name":"C"}',
    );
  });

  it("skips the copy when the source does not exist", async () => {
    await build([]);
    expect(existsSync(join(outDir, ".well-known", "agent-card.json"))).toBe(false);
  });
});

describe("astro:build:done — webhook", () => {
  it("fires webhook when W2AGENT_WEBHOOK_URL is set", async () => {
    vi.stubEnv("W2AGENT_WEBHOOK_URL", "https://hook.example.com");
    const mockFetch = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", mockFetch);
    await build([]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hook.example.com",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not fire webhook when W2AGENT_WEBHOOK_URL is not set", async () => {
    vi.stubEnv("W2AGENT_WEBHOOK_URL", "");
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    await build([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("astro:config:setup — SSR route injection", () => {
  it("injects routes when output is server", () => {
    const injectRoute = vi.fn();
    const integration = w2agentAstro();
    getHook(
      integration,
      "astro:config:setup",
    )({
      config: { output: "server", root: new URL("file:///site/"), site: "https://example.com" },
      injectRoute,
    });
    expect(injectRoute).toHaveBeenCalledWith(expect.objectContaining({ pattern: "/llms.txt" }));
    expect(injectRoute).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: "/.well-known/agent-card.json" }),
    );
    expect(injectRoute).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: "/api/w2agent-webhook" }),
    );
  });

  it("does not inject routes when output is static", () => {
    const injectRoute = vi.fn();
    const integration = w2agentAstro();
    getHook(
      integration,
      "astro:config:setup",
    )({
      config: { output: "static", root: new URL("file:///site/") },
      injectRoute,
    });
    expect(injectRoute).not.toHaveBeenCalled();
  });

  it("skips webhook route when webhookEnabled is false", () => {
    const injectRoute = vi.fn();
    const integration = w2agentAstro({ webhookEnabled: false });
    getHook(
      integration,
      "astro:config:setup",
    )({
      config: { output: "server", root: new URL("file:///site/") },
      injectRoute,
    });
    const patterns = injectRoute.mock.calls.map((c) => c[0].pattern);
    expect(patterns).not.toContain("/api/w2agent-webhook");
  });
});
