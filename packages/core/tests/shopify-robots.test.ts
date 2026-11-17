import { Drop, Liquid } from "liquidjs";
import robotsParser from "robots-parser";
import { describe, expect, it } from "vitest";
import { shopifyAdapter } from "../src/adapters/shopify/index.js";
import {
  generateShopifyIntegration,
  liquidSafeRobotsLine,
  shopifyRobotsAdditions,
} from "../src/adapters/shopify/templates.js";
import { robotsAllowGroups } from "../src/generate/robots-txt.js";
import type { GenerateContext } from "../src/generate/types.js";

const BASE = "https://shop.example";

const SHOPIFY_DEFAULT_GROUPS_LOOP = `{% for group in robots.default_groups %}
  {{- group.user_agent }}

  {%- for rule in group.rules -%}
    {{ rule }}
  {%- endfor -%}

  {%- if group.sitemap != blank %}
    {{ group.sitemap }}
  {%- endif %}
{% endfor %}`;

const OWNER_RULES = [
  "User-agent: *",
  "Disallow: /",
  "Disallow: /private",
  "",
  "User-agent: ChatGPT-User",
  "Disallow: /",
  "",
].join("\n");

class Line extends Drop {
  constructor(private readonly text: string) {
    super();
  }
  valueOf() {
    return `${this.text}\n`;
  }
}

function defaultGroups() {
  const rule = (d: string, v: string) => new Line(`${d}: ${v}`);
  return [
    {
      user_agent: new Line("User-agent: *"),
      rules: [
        rule("Disallow", "/admin"),
        rule("Disallow", "/cart"),
        rule("Disallow", "/checkout"),
        rule("Disallow", "/*preview_script_id*"),
      ],
      sitemap: new Line(`Sitemap: ${BASE}/sitemap.xml`),
    },
    {
      user_agent: new Line("User-agent: Nutch"),
      rules: [rule("Disallow", "/")],
      sitemap: "",
    },
  ];
}

function ctx(robotsTxt: string | undefined): GenerateContext {
  return {
    pages: [],
    rawPages: [],
    metadata: { robotsTxt } as unknown as GenerateContext["metadata"],
    baseUrl: BASE,
  };
}

function additionsFor(robotsTxt: string | undefined): string | undefined {
  const files = shopifyAdapter.generateIntegration(ctx(robotsTxt), []);
  return files.find((f) => f.filename === "shopify/data/robots-txt-additions.txt")?.content;
}

async function render(template: string): Promise<string> {
  return new Liquid().render(new Liquid().parse(template), {
    robots: { default_groups: defaultGroups() },
    shop: { name: "SECRETSHOP", url: BASE },
  });
}

const OWNER_TEMPLATE = `${SHOPIFY_DEFAULT_GROUPS_LOOP}\n\n${OWNER_RULES}`;

// The generator only sees the live robots.txt, which is the owner template rendered.
async function ownerWithAdditions() {
  const live = await render(OWNER_TEMPLATE);
  const additions = additionsFor(live);
  return { live, additions, out: await render(`${OWNER_TEMPLATE}\n${additions ?? ""}`) };
}

function allowed(rendered: string, agent: string, path = "/") {
  return robotsParser(`${BASE}/robots.txt`, rendered).isAllowed(`${BASE}${path}`, agent);
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("Shopify robots additions", () => {
  it("writes only the additions file, never a robots.txt.liquid", () => {
    const files = shopifyAdapter.generateIntegration(
      ctx("User-agent: *\nDisallow: /\nDisallow: /secret\n"),
      [],
    );
    const names = files.map((f) => f.filename);
    expect(names).toContain("shopify/data/robots-txt-additions.txt");
    expect(names.some((n) => n.endsWith("robots.txt.liquid"))).toBe(false);
    const install = files.find((f) => f.filename === "shopify/INSTALL.md")?.content ?? "";
    expect(install).toContain(
      "at its end, after the `robots.default_groups` loop and your own rules",
    );
    expect(install).toContain("Do not create one from these groups alone");
  });

  it("writes nothing when the crawled robots.txt does not block * at the root", () => {
    const files = shopifyAdapter.generateIntegration(
      ctx("User-agent: *\nDisallow: /admin\nDisallow: /cart\n"),
      [],
    );
    expect(files.map((f) => f.filename)).not.toContain("shopify/data/robots-txt-additions.txt");
    expect(files.find((f) => f.filename === "shopify/INSTALL.md")?.content).not.toContain(
      "robots.txt.liquid",
    );
  });

  it("writes nothing when no robots.txt was crawled", () => {
    expect(additionsFor(undefined)).toBeUndefined();
  });

  it("appended to an owner template, keeps every owner rule and allows only unnamed AI agents", async () => {
    const { live, additions, out } = await ownerWithAdditions();
    expect(additions).toBeDefined();
    expect(additions).not.toMatch(/^Sitemap:/m);

    expect(allowed(live, "Claude-User")).toBe(false);
    expect(allowed(out, "ChatGPT-User")).toBe(false);
    expect(count(out, "User-agent: ChatGPT-User\n")).toBe(1);
    for (const agent of ["Claude-User", "OAI-SearchBot", "Perplexity-User"]) {
      expect(allowed(out, agent)).toBe(true);
      expect(allowed(out, agent, "/private")).toBe(false);
      expect(allowed(out, agent, "/admin")).toBe(false);
    }
    for (const agent of ["GPTBot", "ClaudeBot", "SomeUnknownBot", "Nutch"]) {
      expect(allowed(out, agent)).toBe(false);
    }
    expect(allowed(out, "SomeUnknownBot", "/private")).toBe(false);
    expect(allowed(out, "SomeUnknownBot", "/products")).toBe(false);
    expect(out.startsWith(live)).toBe(true);
  });

  it("keeps hostile crawled path rules inert in Liquid", async () => {
    const hostile = [
      "/{{ shop.name }}",
      "/{% raw %}",
      "/{% endraw %}",
      "/{%- comment -%}",
      "/a}}b%}c",
    ];
    const robots = `User-agent: *\nDisallow: /\n${hostile.map((p) => `Disallow: ${p}`).join("\n")}\n`;
    const additions = additionsFor(robots)!;
    expect(additions).not.toMatch(/[{}]/);
    expect(additions).toBe(shopifyRobotsAdditions(robotsAllowGroups(robots, BASE)));

    const out = await render(`${OWNER_TEMPLATE}\n${additions}`);
    expect(out).not.toContain("SECRETSHOP");
    expect(out).toContain("Disallow: /%7B%7B shop.name %7D%7D");
    expect(out).toContain("Disallow: /%7B% raw %%7D");

    for (const path of ["/{{ shop.name }}", "/{% raw %}x", "/{% endraw %}", "/{%- comment -%}"]) {
      expect(allowed(out, "Claude-User", path)).toBe(false);
    }
    expect(allowed(out, "Claude-User", "/a}}b%}c")).toBe(false);
    expect(allowed(out, "Claude-User", "/fine")).toBe(true);
  });

  it("encodes braces and rejects line breaks in emitted values", () => {
    expect(liquidSafeRobotsLine("Disallow: /{{x}}{%y%}{#z#}")).toBe(
      "Disallow: /%7B%7Bx%7D%7D%7B%y%%7D%7B#z#%7D",
    );
    expect(() => liquidSafeRobotsLine("Disallow: /a\nb")).toThrow();
    expect(() => liquidSafeRobotsLine("Disallow: /a\rb")).toThrow();
  });

  it("generateShopifyIntegration writes the groups to the additions file", () => {
    const files = generateShopifyIntegration(
      "# x",
      [["User-agent: ChatGPT-User", "Allow: /"]],
      BASE,
    );
    const additions = files.find((f) => f.filename === "shopify/data/robots-txt-additions.txt");
    expect(additions?.content).toBe("User-agent: ChatGPT-User\nAllow: /\n");
    expect(files.map((f) => f.filename)).not.toContain("shopify/templates/robots.txt.liquid");
  });
});

describe("robotsAllowGroups", () => {
  it("returns [] without a robots.txt or when nothing is blocked", () => {
    expect(robotsAllowGroups(undefined, BASE)).toEqual([]);
    expect(robotsAllowGroups("", BASE)).toEqual([]);
    expect(robotsAllowGroups("User-agent: *\nDisallow: /admin\n", BASE)).toEqual([]);
  });

  it("returns only Allow groups, with no header, Sitemap or comment", () => {
    const groups = robotsAllowGroups("User-agent: *\nDisallow: /\n", BASE);
    expect(groups.length).toBeGreaterThan(0);
    for (const line of groups.flat()) {
      expect(line).toMatch(/^(User-agent|Allow|Disallow|Crawl-delay): |^$/);
    }
  });

  it("returns [] when the file ends in a User-agent line with no rules", () => {
    const robots = "User-agent: *\nDisallow: /\n\nUser-agent: ChatGPT-User\n# end\n\n";
    expect(robotsAllowGroups(robots, BASE)).toEqual([]);
    expect(additionsFor(robots)).toBeUndefined();
  });
});
