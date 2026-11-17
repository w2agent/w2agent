export type HomeBranch = "markdown" | "plain" | "html";

export interface AcceptCase {
  name: string;
  accept: string | null;
  path: string;
  branch: HomeBranch | "untouched";
}

const CHROME =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";

export const ACCEPT_CASES: AcceptCase[] = [
  { name: "Chrome", accept: CHROME, path: "/", branch: "html" },
  {
    name: "Firefox",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    path: "/",
    branch: "html",
  },
  {
    name: "html with text/plain;q=0.8",
    accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
    path: "/",
    branch: "html",
  },
  { name: "axios default", accept: "application/json, text/plain, */*", path: "/", branch: "html" },
  { name: "curl */*", accept: "*/*", path: "/", branch: "html" },
  { name: "no Accept header", accept: null, path: "/", branch: "html" },
  { name: "text/*", accept: "text/*", path: "/", branch: "html" },
  { name: "text/markdown;q=0", accept: "text/markdown;q=0", path: "/", branch: "html" },
  { name: "text/plain, text/html", accept: "text/plain, text/html", path: "/", branch: "html" },
  { name: "text/markdown", accept: "text/markdown", path: "/", branch: "markdown" },
  { name: "TEXT/Markdown", accept: "TEXT/Markdown", path: "/", branch: "markdown" },
  {
    name: "markdown, html;q=0.9",
    accept: "text/markdown, text/html;q=0.9",
    path: "/",
    branch: "markdown",
  },
  { name: "markdown, html", accept: "text/markdown, text/html", path: "/", branch: "markdown" },
  { name: "markdown, plain", accept: "text/markdown, text/plain", path: "/", branch: "markdown" },
  { name: "text/plain", accept: "text/plain", path: "/", branch: "plain" },
  {
    name: "html;q=0.5, plain",
    accept: "text/html;q=0.5, text/plain",
    path: "/",
    branch: "plain",
  },
  { name: "text/plain with query", accept: "text/plain", path: "/?utm=1", branch: "plain" },
  {
    name: "text/* does not count as explicit text/plain",
    accept: "text/*, text/html;q=0.5",
    path: "/",
    branch: "html",
  },
  {
    name: "explicit text/markdown;q=0 beats */*",
    accept: "text/markdown;q=0, */*",
    path: "/",
    branch: "html",
  },
  {
    name: "comma inside a quoted parameter does not split the range",
    accept: 'text/markdown;profile="a,b";q=0.1,text/html;q=0.9',
    path: "/",
    branch: "html",
  },
  {
    name: "semicolon and escaped quote inside a quoted parameter",
    accept: 'text/markdown;profile="a;q=0.1\\",b";q=0.1,text/html;q=0.9',
    path: "/",
    branch: "html",
  },
  {
    name: "quoted parameter before a real q on a winning range",
    accept: 'text/markdown;profile="x,y";q=0.9,text/html;q=0.5',
    path: "/",
    branch: "markdown",
  },
  {
    name: "semicolon-and-q inside a quoted parameter is not a q",
    accept: 'text/markdown;q=0.5;p="x;q=1", text/html;q=0.8',
    path: "/",
    branch: "html",
  },
  { name: "text/markdown on /about", accept: "text/markdown", path: "/about", branch: "untouched" },
];

// Nitro mounts the app under app.baseURL, and h3 strips the mount prefix from event.path by plain
// slicing ("/docs?x=1" -> "?x=1", "/docsx" -> "x"); every request below carries
// Accept: text/markdown.
export const BASE_URL = "/docs";

// app.baseURL as useRuntimeConfig() reports it; Nuxt normalises to a trailing slash, the
// middleware must not depend on it.
export const RUNTIME_BASE_URLS = ["/docs/", "/docs"];

export const BASE_URL_ACCEPTS = [
  { accept: "text/markdown", file: "index.md" },
  { accept: "text/plain", file: "llms.txt" },
];

export const BASE_URL_CASES: { path: string; branch: "markdown" | "untouched" }[] = [
  { path: "/docs?x=1", branch: "markdown" },
  { path: "/docs", branch: "markdown" },
  { path: "/docs/", branch: "markdown" },
  { path: "/docs/?utm=1", branch: "markdown" },
  { path: "/docsx", branch: "untouched" },
  { path: "/docs/about", branch: "untouched" },
];
