// Shared by the emitted-plugin test (core) and the @w2agent/docusaurus package test, so both
// copies of the plugin run the same loaded-content fixture and meet the same expected output.

export const SITE_CONFIG = {
  url: "https://docs.example.com/",
  baseUrl: "/proj/",
  title: "Fx Docs",
  tagline: "A\ntagline",
};

const doc = (permalink: string, title: string, sourceDirName: string, extra = {}) => ({
  permalink,
  title,
  description: "",
  unlisted: false,
  sourceDirName,
  ...extra,
});

// Shape of the docs plugin content that Docusaurus passes to postBuild: permalinks carry baseUrl.
export const PLUGINS = [
  {
    name: "docusaurus-plugin-content-docs",
    options: { id: "default" },
    content: {
      loadedVersions: [
        {
          versionName: "current",
          isLast: true,
          docs: [
            doc("/proj/", "Intro", ".", { description: "Welcome text." }),
            doc("/proj/guides/setup", "Setup\n   Guide", "02-guides", {
              description: "Install\n  the thing.",
            }),
            doc("/proj/guides/hidden", "Hidden", "02-guides", { unlisted: true }),
            doc("/proj/guides/old-draft", "Draft", "02-guides", { draft: true }),
            doc("/proj/api/v2/ref", "Reference", "03-api-reference/v2"),
          ],
        },
        {
          versionName: "1.0.0",
          isLast: false,
          docs: [doc("/proj/1.0.0/guides/setup", "Setup (old)", "02-guides")],
        },
      ],
    },
  },
  {
    name: "docusaurus-plugin-content-docs",
    options: { id: "community" },
    content: {
      loadedVersions: [
        {
          versionName: "current",
          isLast: true,
          docs: [doc("/proj/community/hello", "Hello", ".")],
        },
      ],
    },
  },
  {
    name: "docusaurus-plugin-content-blog",
    options: { id: "default" },
    content: { blogPosts: [{ permalink: "/proj/blog/post", title: "Blog post" }] },
  },
  { name: "docusaurus-plugin-content-pages", options: { id: "default" }, content: undefined },
];

export const EXPECTED_LLMS_TXT = [
  "# Fx Docs",
  "",
  "> A tagline",
  "",
  "## Docs",
  "",
  "- [Intro](https://docs.example.com/proj/): Welcome text.",
  "- [Hello](https://docs.example.com/proj/community/hello)",
  "",
  "## Guides",
  "",
  "- [Setup Guide](https://docs.example.com/proj/guides/setup): Install the thing.",
  "",
  "## Api reference",
  "",
  "- [Reference](https://docs.example.com/proj/api/v2/ref)",
  "",
  "",
].join("\n");

export const FORBIDDEN_FRAGMENTS = ["Hidden", "Draft", "1.0.0", "Blog post"];

// Docusaurus applyTrailingSlash: undefined leaves permalinks alone; true adds "/"; false strips it,
// except for the baseUrl root; a "?"/"#" suffix is never touched.
export const TRAILING_PLUGINS = [
  {
    name: "docusaurus-plugin-content-docs",
    options: { id: "default" },
    content: {
      loadedVersions: [
        {
          versionName: "current",
          isLast: true,
          docs: [
            doc("/proj/", "Intro", "."),
            doc("/proj/guides/setup", "Setup", "."),
            doc("/proj/guides/dir/", "Dir", "."),
            doc("/proj/guides/q#frag", "Q", "."),
          ],
        },
      ],
    },
  },
];

export const TRAILING_SLASH_CASES: { trailingSlash: boolean | undefined; links: string[] }[] = [
  {
    trailingSlash: undefined,
    links: ["/proj/", "/proj/guides/setup", "/proj/guides/dir/", "/proj/guides/q#frag"],
  },
  {
    trailingSlash: true,
    links: ["/proj/", "/proj/guides/setup/", "/proj/guides/dir/", "/proj/guides/q/#frag"],
  },
  {
    trailingSlash: false,
    links: ["/proj/", "/proj/guides/setup", "/proj/guides/dir", "/proj/guides/q#frag"],
  },
];

export const EMPTY_PLUGINS = [
  {
    name: "docusaurus-plugin-content-docs",
    options: { id: "default" },
    content: { loadedVersions: [{ versionName: "current", isLast: true, docs: [] }] },
  },
];
