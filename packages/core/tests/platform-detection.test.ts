import { describe, expect, it, vi } from "vitest";
import { astroAdapter } from "../src/adapters/astro/index.js";
import { docusaurusAdapter } from "../src/adapters/docusaurus/index.js";
import { nextjsAdapter } from "../src/adapters/nextjs/index.js";
import { nuxtAdapter } from "../src/adapters/nuxt/index.js";
import { detectPlatform } from "../src/adapters/registry.js";
import { shopifyAdapter } from "../src/adapters/shopify/index.js";
import { wordpressAdapter } from "../src/adapters/wordpress/index.js";
import type { FetchedPage, SiteMetadata } from "../src/audit/types.js";

import "../src/adapters/index.js";

const SITE = "https://site.example";
const meta: SiteMetadata = { baseUrl: SITE, wellKnown: {} };

function page(html: string, url = `${SITE}/`, headers: Record<string, string> = {}): FetchedPage {
  return {
    url,
    status: 200,
    html,
    headers: { "content-type": "text/html", ...headers },
    responseTime: 10,
  };
}

const shell = (head: string, body = "") =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

// Captured from a real Next.js 16 App Router build (trimmed): chunk assets in script[src]/link[href],
// plus flight data that serialises the page and mentions /_next/static/ inside a string.
const NEXT16_HEAD =
  '<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/0j1we3cwg31qe.js"/>' +
  '<script src="/_next/static/chunks/0m3mby5pxg4oz.js" async=""></script>';
const NEXT16_FLIGHT =
  "<script>(self.__next_f=self.__next_f||[]).push([0])</script>" +
  '<script>self.__next_f.push([1,"1:\\"$Sreact.fragment\\"\\n2:\\"/_next/static/chunks/3qfy96eoyh-ek.js\\"\\n"])</script>';
const NEXT16 = shell(NEXT16_HEAD, `<h1>HOME HTML</h1>${NEXT16_FLIGHT}`);

// Synthetic Pages Router page (captured Next 15 pages build is not kept in the repo).
const NEXT_PAGES = shell(
  '<script src="/_next/static/chunks/main-6f8a2e1b.js" defer=""></script>',
  '<div id="__next"><h1>Home</h1></div><script id="__NEXT_DATA__" type="application/json">{"props":{},"page":"/","nextVersion":"14.2.3"}</script>',
);

// Captured from a real WordPress 7.1 front page (trimmed): plain permalinks advertise ?rest_route=/.
const WP_HEAD =
  '<meta name="generator" content="WordPress 7.1.4" />' +
  `<link rel="https://api.w.org/" href="${SITE}/index.php?rest_route=/" />` +
  `<link rel="modulepreload" href="${SITE}/wp-includes/js/dist/script-modules/interactivity/index.min.js?ver=6a43" id="@wordpress/interactivity-js-modulepreload">`;
const WP = shell(WP_HEAD, "<h1>Hello world</h1>");

// Captured from a real Nuxt 4 SSR build (trimmed).
const NUXT = shell(
  '<link rel="modulepreload" as="script" crossorigin href="/_nuxt/7v5ML05W.js">',
  '<div id="__nuxt"><h1>Nuxt</h1></div><script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">[{"a":1}]</script>',
);

// Captured from a real Docusaurus 3.10 build (trimmed): <html> has no docusaurus class token.
const DOCUSAURUS =
  '<!doctype html><html lang="en" dir="ltr" class="docs-wrapper plugin-docs docs-doc-page" data-has-hydrated="false"><head><meta charset="UTF-8"><meta name="generator" content="Docusaurus v3.10.2"></head>' +
  '<body><div id="__docusaurus"><div class="theme-doc-sidebar-container docSidebarContainer_YfHR"><h1>Intro</h1></div></div></body></html>';
const DOCUSAURUS_NO_GENERATOR =
  '<!doctype html><html lang="en" class="docs-wrapper"><head></head><body><div id="__docusaurus"><div class="theme-doc-sidebar-menu menu__list">x</div></div></body></html>';

// Synthetic Shopify Dawn-style page.
const SHOPIFY = shell(
  '<link rel="preconnect" href="https://cdn.shopify.com" crossorigin><script async="async" src="https://cdn.shopify.com/shopifycloud/storefront/assets/storefront-features.js"></script>',
  "<main><h1>Store</h1></main>",
);

// Synthetic Astro page.
const ASTRO = shell(
  '<meta name="generator" content="Astro v5.18.2"><link rel="stylesheet" href="/_astro/index.Dk3e9.css">',
  '<main data-astro-cid-j7pv25f6><astro-island uid="1" component-url="/_astro/Counter.js"></astro-island></main>',
);

const detect = (pages: FetchedPage[]) => detectPlatform(pages, meta);

describe("platform detection: each platform", () => {
  it.each([
    ["nextjs (App Router)", NEXT16, "nextjs", 0.95],
    ["nextjs (Pages Router)", NEXT_PAGES, "nextjs", 1.0],
    ["wordpress", WP, "wordpress", 1.0],
    ["nuxt", NUXT, "nuxt", 0.95],
    ["docusaurus", DOCUSAURUS, "docusaurus", 1.0],
    ["shopify", SHOPIFY, "shopify", 0.95],
    ["astro", ASTRO, "astro", 1.0],
  ])("%s", (_label, html, platform, confidence) => {
    const result = detect([page(html)]);
    expect(result?.platform).toBe(platform);
    expect(result?.confidence).toBe(confidence);
  });

  it("reads the Next.js version from the __NEXT_DATA__ script", () => {
    expect(detect([page(NEXT_PAGES)])?.version).toBe("14.2.3");
  });

  it("reads the WordPress version from the generator meta", () => {
    expect(detect([page(WP)])?.version).toBe("7.1.4");
  });

  it("detects Docusaurus from #__docusaurus and theme-doc-* classes without a generator tag", () => {
    const result = docusaurusAdapter.detect([page(DOCUSAURUS_NO_GENERATOR)], meta);
    expect(result?.confidence).toBe(0.9);
  });

  it("detects a docusaurus class token on <html> (0.95)", () => {
    const html = '<html class="docusaurus-mode docs-wrapper"><body></body></html>';
    expect(docusaurusAdapter.detect([page(html)], meta)?.confidence).toBe(0.95);
  });

  it("detects the WordPress REST link from the Link header and from a link[rel] element", () => {
    const header = page("<html><body></body></html>", `${SITE}/`, {
      link: `<${SITE}/index.php?rest_route=/>; rel="https://api.w.org/"`,
    });
    expect(wordpressAdapter.detect([header], meta)?.confidence).toBe(0.85);
    const html = page(
      shell(`<link rel="https://api.w.org/" href="${SITE}/index.php?rest_route=/" />`),
    );
    expect(wordpressAdapter.detect([html], meta)?.confidence).toBe(0.85);
  });

  it("accepts a Link header that contains wp-json without the rel", () => {
    const p = page("<html><body></body></html>", `${SITE}/`, {
      link: `<${SITE}/wp-json/>; rel="alternate"`,
    });
    expect(wordpressAdapter.detect([p], meta)?.confidence).toBe(0.85);
  });
});

describe("platform detection: ambiguous cases", () => {
  it("Next.js page with a WordPress-hosted image is Next.js", () => {
    const html = NEXT16.replace(
      "</body>",
      '<img alt="hero" src="https://cms.example.net/wp-content/uploads/2026/01/hero.jpg"></body>',
    );
    expect(detect([page(html)])?.platform).toBe("nextjs");
  });

  it("Next.js page loading a cross-host WordPress stylesheet is Next.js (tie goes to the framework)", () => {
    const html = NEXT16.replace(
      "</head>",
      '<link rel="stylesheet" href="https://cms.example.net/wp-includes/css/dist/block-library/style.min.css"></head>',
    );
    const result = detect([page(html, `${SITE}/`, { "x-powered-by": "Next.js" })]);
    expect(result?.platform).toBe("nextjs");
  });

  it("Docusaurus site whose doc page quotes Next.js markers in prose and code is Docusaurus", () => {
    const proseHtml = DOCUSAURUS.replace(
      "</body>",
      '<article class="theme-doc-markdown"><p>Next.js embeds <code>__NEXT_DATA__</code> and loads <code>/_next/static/</code>.</p>' +
        '<pre><code>&lt;script id="__NEXT_DATA__" type="application/json"&gt;{}&lt;/script&gt;</code></pre></article></body>',
    );
    const pages = [page(DOCUSAURUS), page(proseHtml, `${SITE}/docs/migrating`)];
    expect(detect(pages)?.platform).toBe("docusaurus");
    expect(detect([...pages].reverse())?.platform).toBe("docusaurus");
    expect(nextjsAdapter.detect([pages[1]], meta)).toBeNull();
  });

  it("Next.js homepage with one WordPress page follows the homepage", () => {
    const pages = [page(NEXT16), page(WP, `${SITE}/blog/hello`)];
    expect(detect(pages)?.platform).toBe("nextjs");
    expect(detect([...pages].reverse())?.platform).toBe("nextjs");
  });

  it("falls back to all pages when the homepage matches nothing", () => {
    const pages = [page("<html><body>Welcome</body></html>"), page(WP, `${SITE}/blog/hello`)];
    expect(detect(pages)?.platform).toBe("wordpress");
  });

  it("homepage match ignores a trailing slash and query string", () => {
    const home = page(NEXT16, `${SITE}/?utm=1`);
    const other = page(WP, `${SITE}/about/`);
    expect(
      detectPlatform([other, home], { baseUrl: `${SITE}/index/..`, wellKnown: {} })?.platform,
    ).toBe("nextjs");
  });

  it("uses pages[0] when no page matches baseUrl", () => {
    const pages = [page(NEXT16, "https://other.example/"), page(WP, "https://other.example/x")];
    expect(detect(pages)?.platform).toBe("nextjs");
  });

  it("returns null for no pages", () => {
    expect(detect([])).toBeNull();
  });
});

describe("platform detection: markers are bound to markup", () => {
  const prose = (text: string) => page(shell("", `<p>${text}</p>`));
  const codeBlock = (text: string) => page(shell("", `<pre><code>${text}</code></pre>`));
  const jsonScript = (text: string) =>
    page(shell("", `<script type="application/json" id="data">${text}</script>`));

  const cases: Array<[string, (p: FetchedPage[]) => unknown, string[]]> = [
    [
      "nextjs",
      (p) => nextjsAdapter.detect(p, meta),
      ["__NEXT_DATA__", "/_next/static/chunks/a.js", "/_next/image?url=a"],
    ],
    [
      "wordpress",
      (p) => wordpressAdapter.detect(p, meta),
      [
        "/wp-content/uploads/a.png",
        "/wp-includes/js/a.js",
        "wp-json",
        '&lt;meta name="generator" content="WordPress 6"&gt;',
      ],
    ],
    [
      "shopify",
      (p) => shopifyAdapter.detect(p, meta),
      [
        "https://cdn.shopify.com/a.js",
        "Shopify.theme = {}",
        "shopify-features",
        "mystore.myshopify.com",
      ],
    ],
    ["nuxt", (p) => nuxtAdapter.detect(p, meta), ["__NUXT__", "__NUXT_DATA__", "/_nuxt/entry.js"]],
    [
      "astro",
      (p) => astroAdapter.detect(p, meta),
      ["astro-island", "data-astro-cid-abc", "/_astro/a.css"],
    ],
    [
      "docusaurus",
      (p) => docusaurusAdapter.detect(p, meta),
      ["docusaurus-theme", "theme-doc-markdown", "__docusaurus"],
    ],
  ];

  for (const [id, run, mentions] of cases) {
    it(`${id}: prose, escaped code blocks and JSON payloads do not count`, () => {
      for (const text of mentions) {
        expect(run([prose(text)]), `prose: ${text}`).toBeNull();
        expect(run([codeBlock(text)]), `code block: ${text}`).toBeNull();
        expect(run([jsonScript(JSON.stringify({ text }))]), `json: ${text}`).toBeNull();
      }
    });
  }

  it("Next.js flight data alone does not count", () => {
    const flight = page(shell("", NEXT16_FLIGHT));
    expect(nextjsAdapter.detect([flight], meta)).toBeNull();
  });

  it("Nuxt: __NUXT__ counts only in a code script", () => {
    const code = page(shell("", "<script>window.__NUXT__={}</script>"));
    expect(nuxtAdapter.detect([code], meta)?.confidence).toBe(0.95);
  });

  it("Shopify: Shopify.theme counts in a code script and script#shopify-features counts", () => {
    const code = page(
      shell("", '<script>var Shopify = Shopify || {}; Shopify.theme = {"name":"Dawn"};</script>'),
    );
    expect(shopifyAdapter.detect([code], meta)?.confidence).toBe(0.9);
    const features = page(
      shell("", '<script id="shopify-features" type="application/json">{}</script>'),
    );
    expect(shopifyAdapter.detect([features], meta)?.confidence).toBe(0.9);
  });

  it("Shopify: an img from cdn.shopify.com does not count, a look-alike host does not count", () => {
    const img = page(shell("", '<img src="https://cdn.shopify.com/s/files/1/a.jpg">'));
    expect(shopifyAdapter.detect([img], meta)).toBeNull();
    const fake = page(shell('<script src="https://cdn.shopify.com.evil.example/a.js"></script>'));
    expect(shopifyAdapter.detect([fake], meta)).toBeNull();
  });

  it("Shopify: myshopify.com is matched on the page host, not as a substring", () => {
    expect(
      shopifyAdapter.detect([page("<html></html>", "https://store.myshopify.com/")], meta)
        ?.confidence,
    ).toBe(0.9);
    expect(
      shopifyAdapter.detect(
        [page("<html></html>", "https://example.com/?shop=a.myshopify.com")],
        meta,
      ),
    ).toBeNull();
    expect(
      shopifyAdapter.detect([page("<html></html>", "https://notmyshopify.com/")], meta),
    ).toBeNull();
  });

  it("Next.js: /_next/image counts in img src and srcset only for relative or same-host URLs", () => {
    const relative = page(shell("", '<img src="/_next/image?url=%2Fa.png&w=640&q=75">'));
    expect(nextjsAdapter.detect([relative], meta)?.confidence).toBe(0.95);
    const srcset = page(
      shell(
        "",
        `<img srcset="${SITE}/_next/image?url=%2Fa.png&w=320&q=75 1x, ${SITE}/_next/image?url=%2Fa.png&w=640&q=75 2x" src="/a.png">`,
      ),
    );
    expect(nextjsAdapter.detect([srcset], meta)?.confidence).toBe(0.95);
    const foreign = page(
      shell("", '<img src="https://cdn.other.example/_next/image?url=%2Fa.png&w=640&q=75">'),
    );
    expect(nextjsAdapter.detect([foreign], meta)).toBeNull();
  });

  it("Astro: any attribute starting data-astro-cid- counts", () => {
    const p = page(shell("", "<div data-astro-cid-abc123>x</div>"));
    expect(astroAdapter.detect([p], meta)?.confidence).toBe(0.9);
  });

  it("img[src] media does not count for WordPress", () => {
    const p = page(shell("", '<img src="/wp-content/uploads/a.png">'));
    expect(wordpressAdapter.detect([p], meta)).toBeNull();
  });
});

describe("platform detection: WordPress asset host", () => {
  const withAsset = (url: string, pageUrl = `${SITE}/`) =>
    page(shell(`<link rel="stylesheet" href="${url}">`), pageUrl);

  it.each([
    ["relative", "/wp-content/themes/a/style.css"],
    ["same host", `${SITE}/wp-includes/css/a.css`],
    ["protocol-relative same host", "//site.example/wp-content/a.css"],
  ])("%s asset is 0.95", (_label, url) => {
    expect(wordpressAdapter.detect([withAsset(url)], meta)?.confidence).toBe(0.95);
  });

  it("another host is 0.5", () => {
    const result = wordpressAdapter.detect(
      [withAsset("https://cms.example.net/wp-content/themes/a/style.css")],
      meta,
    );
    expect(result?.confidence).toBe(0.5);
    expect(result?.platform).toBe("wordpress");
  });

  it("a headless WordPress backend alone still resolves to WordPress when nothing else matches", () => {
    const result = detect([
      page(shell('<script src="https://cms.example.net/wp-includes/js/a.js"></script>')),
    ]);
    expect(result?.platform).toBe("wordpress");
    expect(result?.confidence).toBe(0.5);
  });
});

describe("platform detection: tie-break", () => {
  const bothOneZero = shell(
    '<meta name="generator" content="WordPress 6.5">',
    '<script id="__NEXT_DATA__" type="application/json">{}</script>',
  );

  it("prefers the rendering framework on equal confidence", () => {
    expect(detect([page(bothOneZero)])?.platform).toBe("nextjs");
  });

  it("is independent of registration order", async () => {
    vi.resetModules();
    const registry = await import("../src/adapters/registry.js");
    const order = ["astro", "nuxt", "wordpress", "shopify", "docusaurus", "nextjs"] as const;
    const modules = {
      astro: (await import("../src/adapters/astro/index.js")).astroAdapter,
      nuxt: (await import("../src/adapters/nuxt/index.js")).nuxtAdapter,
      wordpress: (await import("../src/adapters/wordpress/index.js")).wordpressAdapter,
      shopify: (await import("../src/adapters/shopify/index.js")).shopifyAdapter,
      docusaurus: (await import("../src/adapters/docusaurus/index.js")).docusaurusAdapter,
      nextjs: (await import("../src/adapters/nextjs/index.js")).nextjsAdapter,
    };
    for (const id of order) registry.registerAdapter(modules[id]);
    expect(registry.allAdapters().map((a) => a.id)).toEqual([...order]);
    expect(registry.detectPlatform([page(bothOneZero)], meta)?.platform).toBe("nextjs");

    const wpShopify = shell(
      '<meta name="generator" content="WordPress 6.5">',
      '<script>Shopify.theme = {}</script><script id="shopify-features" type="application/json">{}</script>',
    );
    expect(registry.detectPlatform([page(wpShopify)], meta)?.platform).toBe("wordpress");

    const nuxtAstro = shell(
      '<meta name="generator" content="Nuxt 3.1"><meta name="generator" content="Astro v4.0">',
    );
    expect(registry.detectPlatform([page(nuxtAstro)], meta)?.platform).toBe("nuxt");
  });

  it("a higher confidence still beats the tie order", () => {
    const html = shell(
      '<meta name="generator" content="WordPress 6.5">',
      '<script src="/_next/static/chunks/a.js"></script>',
    );
    expect(detect([page(html)])?.platform).toBe("wordpress");
  });
});

describe("platform detection: gate fix round 1", () => {
  it("a __NUXT__ mention inside another script's string is not Nuxt", () => {
    const html = shell(
      '<script>window.__INITIAL_STATE__={"article":"window.__NUXT__ holds state"}</script>',
    );
    expect(nuxtAdapter.detect([page(html)], meta)).toBeNull();
  });

  it("the real window.__NUXT__ assignment is Nuxt", () => {
    const html = shell("<script>window.__NUXT__={};window.__NUXT__.config={}</script>");
    expect(nuxtAdapter.detect([page(html)], meta)?.confidence).toBe(0.95);
  });

  it("a Shopify.theme mention inside a string is not Shopify, the assignment is", () => {
    const mention = shell('<script>var t={"a":"see Shopify.theme docs"}</script>');
    expect(shopifyAdapter.detect([page(mention)], meta)).toBeNull();
    const real = shell('<script>var Shopify=Shopify||{};Shopify.theme = {"id":1}</script>');
    expect(shopifyAdapter.detect([page(real)], meta)?.confidence).toBe(0.9);
  });

  it.each([
    ["next", nextjsAdapter, '<img src="/image-proxy?url=https://up.example/_next/image">'],
    ["next static", nextjsAdapter, '<script src="/proxy?u=/_next/static/a.js"></script>'],
    ["nuxt", nuxtAdapter, '<script src="/proxy?u=/_nuxt/a.js"></script>'],
    ["astro", astroAdapter, '<script src="/proxy?u=/_astro/a.js"></script>'],
    ["wordpress", wordpressAdapter, '<link rel="stylesheet" href="/p?u=/wp-content/a.css">'],
    ["wordpress includes", wordpressAdapter, '<script src="/p?u=/wp-includes/a.js"></script>'],
  ])("%s marker inside a URL query is not a signal", (_l, adapter, head) => {
    expect(adapter.detect([page(shell(head))], meta)).toBeNull();
  });

  it("markers still match in the pathname, including relative to a nested page URL", () => {
    expect(
      nextjsAdapter.detect(
        [page(shell('<script src="../_next/static/a.js"></script>'), `${SITE}/a/b`)],
        meta,
      )?.confidence,
    ).toBe(0.95);
    expect(
      nextjsAdapter.detect([page(shell('<img src="/_next/image?url=%2Fa.png&w=64&q=75">'))], meta)
        ?.confidence,
    ).toBe(0.95);
  });

  it("apex and www count as the same WordPress host", () => {
    const html = shell(
      '<link rel="stylesheet" href="https://www.site.example/wp-content/themes/t/style.css">',
    );
    expect(wordpressAdapter.detect([page(html)], meta)?.confidence).toBe(0.95);
    expect(
      wordpressAdapter.detect(
        [
          page(html, "https://www.site.example/"),
          page(html.replace("www.", ""), "https://site.example/"),
        ],
        meta,
      )?.confidence,
    ).toBe(0.95);
  });

  it.each([
    "preload",
    "prefetch",
  ])("an image %s of a wp-content upload is not a theme asset", (rel) => {
    const html = shell(`<link rel="${rel}" as="image" href="/wp-content/uploads/hero.jpg">`);
    expect(wordpressAdapter.detect([page(html)], meta)).toBeNull();
  });
});

describe("platform detection: code-script markers ignore strings and comments", () => {
  it.each([
    '<script>window.__INITIAL_STATE__={"article":"window.__NUXT__ = {}"}</script>',
    '<script>var s="window.__NUXT__=1";</script>',
    "<script>var s='it\\'s window.__NUXT__ = 1';</script>",
    "<script>var s=`window.__NUXT__ = ${1}`;</script>",
    "<script>// window.__NUXT__ = {}\nvar a = 1;</script>",
    "<script>/* window.__NUXT__ = {} */ var a = 1;</script>",
  ])("Nuxt: %s is not Nuxt", (script) => {
    expect(nuxtAdapter.detect([page(shell(script))], meta)).toBeNull();
  });

  it("Shopify: a Shopify.theme assignment inside a string or comment is not Shopify", () => {
    for (const script of [
      '<script>console.log("Shopify.theme = x")</script>',
      "<script>// Shopify.theme = {}\n</script>",
    ]) {
      expect(shopifyAdapter.detect([page(shell(script))], meta)).toBeNull();
    }
  });

  it("real assignments next to strings and comments still match", () => {
    const nuxt = shell(
      '<script>window.__NUXT__={};window.__NUXT__.config={public:{},app:{baseURL:"/a//b"}}</script>',
    );
    expect(nuxtAdapter.detect([page(nuxt)], meta)?.confidence).toBe(0.95);
    const shop = shell(
      '<script>/* theme */ var Shopify = Shopify || {};\nShopify.theme = {"name":"Dawn // x"};</script>',
    );
    expect(shopifyAdapter.detect([page(shop)], meta)?.confidence).toBe(0.9);
  });
});
