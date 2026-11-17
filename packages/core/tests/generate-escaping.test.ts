import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { runGenerate } from "../src/generate/engine.js";
import { generateLlmsFullTxt } from "../src/generate/llms-full-txt.js";
import { generateLlmsTxt } from "../src/generate/llms-txt.js";
import { matchesSections } from "../src/generate/markdown-text.js";
import type { PageMarkdown } from "../src/generate/types.js";

const C = {
  nel: String.fromCharCode(0x85),
  ls: String.fromCharCode(0x2028),
  ps: String.fromCharCode(0x2029),
  del: String.fromCharCode(0x7f),
  bom: String.fromCharCode(0xfeff),
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

const HOSTILE_TITLES = [
  "Line one\n## Injected heading\n- [fake](https://evil.test/x): item",
  "Break\r\n---\r\nurl: https://evil.test/\r\nextra: 1",
  "Why: a title with colon and \"quotes\" and 'single'",
  "Array [1] and ] stray \\ backslash and `tick` *star* _under_ <tag> | pipe & amp &amp; ent",
  "# hash first",
  `NEL${C.nel} LS${C.ls} PS${C.ps} DEL${C.del} BOM${C.bom} end`,
  "- dash start",
  "> quote start",
  "Trailing ](https://evil.test/inject)",
];

const FRONTMATTER_URL_TITLES = [...HOSTILE_TITLES, "key: value\n\ttabbed", '"', "\\"];

function page(url: string, title: string, description = ""): PageMarkdown {
  return { url, title, description, markdown: "Body text of the page here." };
}

const LINK_LINE = /^- \[((?:[^\\[\]]|\\.)*)\]\(([^\s()<>]*)\)(?:: .*)?$/;
const unescapeMd = (s: string) => s.replace(/\\(.)/g, "$1");

function frontmatterBlocks(text: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const re = /(?:^|\n)---\n([\s\S]*?)\n---\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) blocks.push(parse(m[1]));
  return blocks;
}

describe("llms.txt escaping (GEN-7)", () => {
  const pages = HOSTILE_TITLES.map((t, i) => page(`https://example.com/docs/p${i}`, t, `d${i}`));

  it("keeps every line to a known shape and the link text equal to the collapsed title", () => {
    const out = generateLlmsTxt(pages, {
      siteName: "Site\n## Fake",
      siteDescription: "A\n- [x](y)",
    });
    const lines = out.trimEnd().split("\n");
    const links: string[] = [];
    for (const line of lines) {
      if (line === "" || line.startsWith("# ") || line.startsWith("> ") || line === "## Docs") {
        continue;
      }
      const m = LINK_LINE.exec(line);
      expect(m, `bad line: ${JSON.stringify(line)}`).not.toBeNull();
      links.push(unescapeMd(m?.[1] ?? ""));
    }
    expect(lines.filter((l) => l.startsWith("# "))).toEqual(["# Site ## Fake"]);
    expect(lines.filter((l) => l.startsWith("> "))).toEqual(["> A - \\[x\\](y)"]);
    expect(lines.filter((l) => l.startsWith("## "))).toEqual(["## Docs"]);
    expect(links).toEqual(HOSTILE_TITLES.map(collapse));
  });

  it("percent-encodes a URL that would break the link destination", () => {
    const out = generateLlmsTxt([page("https://example.com/a b/(x)<y>", "T")], {
      siteName: "S",
      siteDescription: "",
    });
    const line = out.split("\n").find((l) => l.startsWith("- ")) ?? "";
    const m = LINK_LINE.exec(line);
    expect(m?.[2]).toBe("https://example.com/a%20b/%28x%29%3Cy%3E");
  });

  it("collapses a multi-line description onto one line", () => {
    const out = generateLlmsTxt([page("https://example.com/docs/a", "T", `x\n## H\n${C.ls}y`)], {
      siteName: "S",
      siteDescription: "",
    });
    expect(out).toContain("- [T](https://example.com/docs/a): x ## H y\n");
  });

  it("escapes link, image, autolink and HTML openers in descriptions and the site line", () => {
    const hostile =
      "Line one\n## Injected heading\n- [fake](http://evil.example/) <a href=x> ![i](u)";
    const out = generateLlmsTxt([page("https://example.com/docs/a", "T", hostile)], {
      siteName: "S",
      siteDescription: hostile,
    });
    const expected =
      "Line one ## Injected heading - \\[fake\\](http://evil.example/) \\<a href=x\\> !\\[i\\](u)";
    expect(out).toContain(`> ${expected}\n`);
    expect(out).toContain(`- [T](https://example.com/docs/a): ${expected}\n`);
    for (const line of out.split("\n")) {
      const text = line.startsWith("- ") ? line.slice(line.indexOf("): ") + 3) : line;
      if (line.startsWith("- ") || line.startsWith("> ")) {
        expect(text).not.toMatch(/(^|[^\\])[[<]/);
      }
    }
  });

  it("escapes after truncating so an escape is never cut in half", () => {
    const desc = `${"a".repeat(145)}[[[[[[[[[[`;
    const out = generateLlmsTxt([page("https://example.com/docs/a", "T", desc)], {
      siteName: "S",
      siteDescription: "",
    });
    const line = out.split("\n").find((l) => l.startsWith("- ")) ?? "";
    expect(line).not.toMatch(/\\\.\.\.$/);
    expect(line.endsWith("...")).toBe(true);
    expect(line.replace(/\\./g, "")).not.toContain("\\");
  });
});

describe("frontmatter escaping (GEN-7)", () => {
  it("llms-full.txt frontmatter parses as exactly url/title with the collapsed values", () => {
    const pages = FRONTMATTER_URL_TITLES.map((t, i) => page(`https://example.com/p${i}`, t));
    const blocks = frontmatterBlocks(generateLlmsFullTxt(pages));
    expect(blocks).toHaveLength(pages.length);
    blocks.forEach((b, i) => {
      expect(Object.keys(b)).toEqual(["url", "title"]);
      expect(b.url).toBe(pages[i].url);
      expect(b.title).toBe(collapse(pages[i].title));
    });
  });
});

describe("frontmatter control characters (GEN-7)", () => {
  it("writes DEL, C1 (NEL), BOM and non-characters as \\u escapes, never raw", () => {
    const title = `a${C.del}b${C.nel}c${C.bom}d${String.fromCharCode(0xfffe, 0xffff)}e${C.ls}f`;
    const out = generateLlmsFullTxt([page("https://example.com/", title)]);
    for (const ch of out) {
      const code = ch.charCodeAt(0);
      const raw =
        (code >= 0x7f && code <= 0x9f) || [0x2028, 0x2029, 0xfeff, 0xfffe, 0xffff].includes(code);
      expect(raw, `raw U+${code.toString(16)}`).toBe(false);
    }
    expect(out).toContain("\\u007f");
    expect(out).toContain("\\u0085");
    expect(out).toContain("\\ufffe");
    expect(out).toContain("\\uffff");
    expect(frontmatterBlocks(out)[0].title).toBe(collapse(title));
  });
});

describe("runGenerate with hostile crawled titles (GEN-7)", () => {
  afterEach(() => vi.restoreAllMocks());

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ORIGIN = "https://example.com";

  function mockSite(entries: Array<{ path: string; title: string; description?: string }>) {
    const links = entries.map((e) => `<a href="${e.path}">${e.path}</a>`).join(" ");
    const html = (title: string, description = "") =>
      `<html><head><title>${esc(title)}</title><meta name="description" content="${esc(description)}"></head><body><main><h1>Heading</h1><p>Body paragraph for ${esc(title).slice(0, 5)} page.</p>${links}</main></body></html>`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      const hit = entries.find((e) => e.path === u.pathname);
      return hit
        ? new Response(html(hit.title, hit.description), {
            headers: { "content-type": "text/html" },
          })
        : new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    });
  }

  it("emits safe llms.txt, llms-full.txt and per-page markdown", async () => {
    const entries = [
      { path: "/", title: "Home\n## Fake site", description: "Desc\n- [a](b)" },
      ...HOSTILE_TITLES.map((title, i) => ({ path: `/posts/p${i}`, title, description: "x\ny" })),
    ];
    mockSite(entries);
    const result = await runGenerate(`${ORIGIN}/`, {
      maxPages: 30,
      formats: ["llms-txt", "full", "markdown"],
      platformFiles: false,
    });
    const file = (name: string) => result.files.find((f) => f.filename === name)?.content ?? "";

    const llms = file("llms.txt");
    const links: string[] = [];
    for (const line of llms.trimEnd().split("\n")) {
      if (line === "" || line.startsWith("# ") || line.startsWith("> ") || /^## \w+$/.test(line)) {
        continue;
      }
      const m = LINK_LINE.exec(line);
      expect(m, `bad line: ${JSON.stringify(line)}`).not.toBeNull();
      links.push(unescapeMd(m?.[1] ?? ""));
    }
    expect(llms.split("\n")[0]).toBe("# Home ## Fake site");
    expect(links.filter((t) => t !== "Home ## Fake site").sort()).toEqual(
      HOSTILE_TITLES.map(collapse).sort(),
    );

    const mdFiles = result.files.filter((f) => f.filename.startsWith("markdown/"));
    expect(mdFiles).toHaveLength(entries.length);
    const expected = new Map(entries.map((e) => [collapse(e.title), e.path]));
    for (const f of mdFiles) {
      const [fm, ...rest] = frontmatterBlocks(f.content);
      expect(rest).toEqual([]);
      expect(Object.keys(fm)).toEqual(["url", "title"]);
      expect(expected.has(fm.title as string)).toBe(true);
    }
    const full = frontmatterBlocks(file("llms-full.txt"));
    expect(full).toHaveLength(entries.length);
    for (const b of full) expect(Object.keys(b)).toEqual(["url", "title"]);
    expect(full.map((b) => b.title).sort()).toEqual([...expected.keys()].sort());
  });
});

describe("--sections filtering (GEN-10)", () => {
  const pages = [
    page("https://example.com/", "Home"),
    page("https://example.com/posts/one", "Post One"),
    page("https://example.com/getting-started/intro", "Intro"),
    page("https://example.com/docs/other", "Other Doc"),
  ];

  it("keeps the homepage and the sections named by URL segment in generateLlmsTxt", () => {
    for (const sections of [
      ["posts", "getting-started"],
      ["POSTS", "/getting-started/"],
    ]) {
      const out = generateLlmsTxt(pages, { siteName: "S", siteDescription: "", sections });
      expect(out).toContain("[Home]");
      expect(out).toContain("[Post One]");
      expect(out).toContain("[Intro]");
      expect(out).not.toContain("Other Doc");
    }
  });

  it("is a no-op for an empty list and drops unparseable URLs", () => {
    expect(matchesSections("https://example.com/docs/x", [])).toBe(true);
    expect(matchesSections("not a url", ["docs"])).toBe(false);
    expect(matchesSections("https://example.com/docs/x", ["blog"])).toBe(false);
  });

  it("runGenerate --sections keeps homepage and the named sections in llms.txt", async () => {
    const entries = [
      { path: "/", title: "Home" },
      { path: "/posts/one", title: "Post One" },
      { path: "/getting-started/intro", title: "Intro" },
      { path: "/docs/other", title: "Other Doc" },
    ];
    const links = entries.map((e) => `<a href="${e.path}">x</a>`).join(" ");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      const hit = entries.find((e) => e.path === u.pathname);
      return hit
        ? new Response(
            `<html><head><title>${hit.title}</title></head><body><main><p>Body paragraph of ${hit.title}.</p>${links}</main></body></html>`,
            { headers: { "content-type": "text/html" } },
          )
        : new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
    });
    try {
      const result = await runGenerate("https://example.com/", {
        maxPages: 10,
        formats: ["llms-txt"],
        platformFiles: false,
        sections: ["posts", "getting-started"],
      });
      const llms = result.files.find((f) => f.filename === "llms.txt")?.content ?? "";
      expect(llms).toContain("[Home]");
      expect(llms).toContain("[Post One]");
      expect(llms).toContain("[Intro]");
      expect(llms).not.toContain("Other Doc");
      expect(result.sections.length).toBeGreaterThan(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
