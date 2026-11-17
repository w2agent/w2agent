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

class Line extends Drop {
  constructor(
    private readonly text: string,
    readonly directive?: string,
    readonly value?: string,
  ) {
    super();
  }
  valueOf() {
    return `${this.text}\n`;
  }
}

function defaultGroups(blockedAgents: string[] = []) {
  const rule = (d: string, v: string) => new Line(`${d}: ${v}`, d, v);
  const owner = blockedAgents.map((agent) => ({
    user_agent: new Line(`User-agent: ${agent}`, undefined, agent),
    rules: [rule("Disallow", "/")],
    sitemap: "",
  }));
  return [
    {
      user_agent: new Line("User-agent: *", undefined, "*"),
      rules: [
        rule("Disallow", "/admin"),
        rule("Disallow", "/cart"),
        rule("Disallow", "/checkout"),
        rule("Disallow", "/*preview_script_id*"),
        rule("Disallow", "/"),
      ],
      sitemap: new Line(`Sitemap: ${BASE}/sitemap.xml`),
    },
    {
      user_agent: new Line("User-agent: Nutch", undefined, "Nutch"),
      rules: [rule("Disallow", "/")],
      sitemap: "",
    },
    ...owner,
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

function templateFor(robotsTxt: string | undefined): string | undefined {
  const files = shopifyAdapter.generateIntegration(ctx(robotsTxt), []);
  return files.find((f) => f.filename === "shopify/templates/robots.txt.liquid")?.content;
}

async function render(template: string, blockedAgents: string[] = []): Promise<string> {
  return new Liquid().render(new Liquid().parse(template), {
    robots: { default_groups: defaultGroups(blockedAgents) },
    shop: { name: "SECRETSHOP", url: BASE },
  });
}

function allowed(rendered: string, agent: string, path = "/") {
  return robotsParser(`${BASE}/robots.txt`, rendered).isAllowed(`${BASE}${path}`, agent);
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("Shopify robots.txt.liquid", () => {
  it("is not generated when the crawled robots.txt does not block * at the root", () => {
    const files = shopifyAdapter.generateIntegration(
      ctx("User-agent: *\nDisallow: /admin\nDisallow: /cart\n"),
      [],
    );
    const names = files.map((f) => f.filename);
    expect(names).not.toContain("shopify/templates/robots.txt.liquid");
    expect(names).not.toContain("shopify/data/robots-txt-additions.txt");
    expect(files.find((f) => f.filename === "shopify/INSTALL.md")?.content).not.toContain(
      "robots.txt.liquid",
    );
  });

  it("is not generated when no robots.txt was crawled", () => {
    expect(templateFor(undefined)).toBeUndefined();
  });

  it("keeps the Shopify defaults and adds only Allow groups for agents blocked by *", async () => {
    const template = templateFor(
      "User-agent: *\nDisallow: /\nDisallow: /secret\nDisallow: /admin\n",
    )!;
    expect(template).toContain("robots.default_groups");
    expect(template).not.toMatch(/^Sitemap:/m);
    expect(template).not.toContain("llms.txt");
    expect(template).not.toContain("variant=");

    const out = await render(template);
    const defaults = out.slice(0, out.indexOf("User-agent: ChatGPT-User"));
    for (const line of [
      "User-agent: *",
      "Disallow: /admin",
      "Disallow: /cart",
      "Disallow: /checkout",
      "Disallow: /*preview_script_id*",
      "User-agent: Nutch",
    ]) {
      expect(count(defaults, `${line}\n`)).toBe(1);
    }
    expect(count(out, "Disallow: /cart\n")).toBe(1);
    expect(count(out, "Disallow: /secret\n")).toBe(1);
    expect(out.match(/^User-agent: \*$/gm)).toHaveLength(1);

    const parsed = robotsParser(`${BASE}/robots.txt`, out);
    expect(parsed.getSitemaps()).toEqual([`${BASE}/sitemap.xml`]);
    expect(count(out, "Sitemap:")).toBe(1);

    for (const agent of ["ChatGPT-User", "Claude-User", "OAI-SearchBot"]) {
      expect(allowed(out, agent)).toBe(true);
      expect(allowed(out, agent, "/secret")).toBe(false);
      expect(allowed(out, agent, "/admin")).toBe(false);
    }
    expect(allowed(out, "GPTBot")).toBe(false);
    expect(allowed(out, "SomeUnknownBot")).toBe(false);
  });

  it("never reverses a block the owner wrote for a named agent", async () => {
    const template = templateFor(
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ChatGPT-User\nDisallow: /\n\nUser-agent: *\nDisallow: /\n",
    )!;
    const out = await render(template, ["GPTBot", "ChatGPT-User"]);
    expect(allowed(out, "GPTBot")).toBe(false);
    expect(allowed(out, "ChatGPT-User")).toBe(false);
    expect(allowed(out, "Claude-User")).toBe(true);
    expect(count(out, "User-agent: ChatGPT-User\n")).toBe(1);
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
    const template = templateFor(robots)!;
    const additions = shopifyRobotsAdditions(robotsAllowGroups(robots, BASE));

    for (const text of [additions, template.slice(template.indexOf("{% endfor %}") + 12)]) {
      expect(text).not.toMatch(/\{/);
      expect(text).not.toMatch(/\}/);
    }

    const out = await render(template);
    expect(out).not.toContain("SECRETSHOP");
    expect(out).toContain("Disallow: /%7B%7B shop.name %7D%7D");
    expect(out).toContain("Disallow: /%7B% raw %%7D");

    for (const path of ["/{{ shop.name }}", "/{% raw %}x", "/{% endraw %}", "/{%- comment -%}"]) {
      expect(allowed(out, "ChatGPT-User", path)).toBe(false);
    }
    expect(allowed(out, "ChatGPT-User", "/a}}b%}c")).toBe(false);
    expect(allowed(out, "ChatGPT-User", "/fine")).toBe(true);
  });

  it("encodes braces and rejects line breaks in emitted values", () => {
    expect(liquidSafeRobotsLine("Disallow: /{{x}}{%y%}{#z#}")).toBe(
      "Disallow: /%7B%7Bx%7D%7D%7B%y%%7D%7B#z#%7D",
    );
    expect(() => liquidSafeRobotsLine("Disallow: /a\nb")).toThrow();
    expect(() => liquidSafeRobotsLine("Disallow: /a\rb")).toThrow();
  });

  it("writes the same groups to the additions file and the template", () => {
    const files = generateShopifyIntegration(
      "# x",
      [["User-agent: ChatGPT-User", "Allow: /"]],
      BASE,
    );
    const additions = files.find((f) => f.filename === "shopify/data/robots-txt-additions.txt");
    expect(additions?.content).toBe("User-agent: ChatGPT-User\nAllow: /\n");
    const install = files.find((f) => f.filename === "shopify/INSTALL.md")?.content;
    expect(install).toContain("data/robots-txt-additions.txt");
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
});
