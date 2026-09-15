import { describe, expect, it } from "vitest";
import {
  analyzeUsagePreferences,
  CF_MANAGED_BLOCK_BEGIN,
  CF_MANAGED_BLOCK_END,
  isCloudflareManagedRobots,
  USAGE_PREFERENCE_VOCABULARIES,
  usagePreferenceDeclared,
} from "../src/audit/checks/preferences.js";
import type { CheckResult, FetchedPage, SiteMetadata } from "../src/audit/types.js";

const SITE = "https://example.com";

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: `${SITE}/`,
    status: 200,
    html: "<html></html>",
    headers: {},
    responseTime: 10,
    ...overrides,
  };
}

function metadata(overrides: Partial<SiteMetadata> = {}): SiteMetadata {
  return { baseUrl: SITE, wellKnown: {}, ...overrides };
}

async function run(pages: FetchedPage[], meta: SiteMetadata): Promise<CheckResult> {
  return await usagePreferenceDeclared.run(pages, meta);
}

/**
 * Captured live 2026-09-15 with
 * `curl -sS -A "w2agent/0.1 (+https://w2agent.dev)" https://www.crawlstop.com/robots.txt`
 * (the site Cloudflare's own managed-robots.txt doc names as the worked example),
 * abridged to the prepended managed block plus the site's own rules below it.
 */
const CF_MANAGED_ROBOTS = `# As a condition of accessing this website, you agree to abide by the
# following content signals:
# (a)  If a Content-Signal = yes, you may collect content for the corresponding
#      use.
# ai-train: training or fine-tuning AI models.

${CF_MANAGED_BLOCK_BEGIN}

User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: GPTBot
Disallow: /

${CF_MANAGED_BLOCK_END}

User-agent: *
Disallow: /lp
Disallow: /feedback
Sitemap: https://www.crawlstop.com/sitemap.xml
`;

describe("usage-preference-declared — check shape", () => {
  it("is a tracked, weight-0, info check in bot-accessibility", () => {
    expect(usagePreferenceDeclared).toMatchObject({
      id: "usage-preference-declared",
      category: "bot-accessibility",
      weight: 0,
      severity: "info",
      tracked: true,
    });
  });

  it("every cited vocabulary source is an https doc URL", () => {
    for (const v of USAGE_PREFERENCE_VOCABULARIES) {
      expect(v.sourceUrl, v.source).toMatch(/^https:\/\//);
    }
  });
});

describe("usage-preference-declared — Content-Signal (robots.txt)", () => {
  it("reads a training opt-out and every sibling signal", async () => {
    const robotsTxt = "User-agent: *\nContent-Signal: search=yes, ai-train=no\nAllow: /\n";
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
    expect(analysis).toMatchObject({
      sources: ["robots-content-signal"],
      trainingOptOut: true,
      managedDefault: false,
    });
    expect(analysis.signals).toEqual({
      "robots-content-signal.search": "yes",
      "robots-content-signal.ai-train": "no",
    });

    const result = await run([page()], metadata({ robotsTxt }));
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Training opt-out declared (Content-Signal)");
    expect(result.details).toContain("sources: robots-content-signal");
    expect(result.details).toContain("trainingOptOut: true");
  });

  it("reads ai-train=yes as an explicit permission, not an opt-out", async () => {
    const robotsTxt = "Content-Signal: ai-train=yes, search=yes, ai-input=yes\n";
    const result = await run([page()], metadata({ robotsTxt }));
    expect(result.status).toBe("pass");
    expect(result.message).toBe(
      "AI usage preferences declared; training is permitted (Content-Signal)",
    );
    expect(result.details).toContain("trainingOptOut: false");
  });

  it("matches the directive name case-insensitively (Cloudflare emits Content-signal)", () => {
    const analysis = analyzeUsagePreferences(
      [page()],
      metadata({ robotsTxt: "Content-signal: search=yes, ai-train=no\n" }),
    );
    expect(analysis.trainingOptOut).toBe(true);
  });

  it("ignores the Content Signals Policy comment block, which mentions the signals in prose", () => {
    const robotsTxt =
      "# (a)  If a content-signal = yes, you may collect content\n# ai-train: training or fine-tuning AI models.\nUser-agent: *\nAllow: /\n";
    expect(analyzeUsagePreferences([page()], metadata({ robotsTxt })).sources).toEqual([]);
  });
});

describe("usage-preference-declared — AIPREF Content-Usage", () => {
  it("reads the robots.txt attachment", async () => {
    const robotsTxt = "User-Agent: *\nAllow: /\nContent-Usage: train-ai=n\n";
    const result = await run([page()], metadata({ robotsTxt }));
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Training opt-out declared (Content-Usage (robots.txt))");
    expect(result.details).toContain("robots-content-usage.train-ai: n");
  });

  it("reads the HTTP header attachment from the homepage response", async () => {
    const pages = [page({ headers: { "content-usage": "train-ai=n" } })];
    const result = await run(pages, metadata());
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Training opt-out declared (Content-Usage (HTTP header))");
    expect(result.details).toContain("http-content-usage.train-ai: n");
  });

  it("ignores a Content-Usage header on a page that is not the homepage", () => {
    const pages = [
      page({ url: `${SITE}/pricing`, headers: { "content-usage": "train-ai=n" } }),
      page(),
    ];
    expect(analyzeUsagePreferences(pages, metadata()).sources).toEqual([]);
  });

  it("keeps a path-scoped rule under its path and still reads its preference", () => {
    const robotsTxt = "Content-Usage: train-ai=n\nContent-Usage: /ai-ok/ train-ai=y\n";
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
    expect(analysis.signals).toEqual({
      "robots-content-usage.train-ai": "n",
      "robots-content-usage./ai-ok/.train-ai": "y",
    });
    // A forbid anywhere outweighs a permit anywhere.
    expect(analysis.trainingOptOut).toBe(true);
  });

  it("keeps a path that contains '=' as a path (paths start with /, dictionary keys cannot)", () => {
    const analysis = analyzeUsagePreferences(
      [page()],
      metadata({ robotsTxt: "Content-Usage: /a=b/ train-ai=n\n" }),
    );
    expect(analysis.signals).toEqual({ "robots-content-usage./a=b/.train-ai": "n" });
    expect(analysis.trainingOptOut).toBe(true);
  });

  it("treats non-token values as unknown (vocab §6.5: quoted string, bare key, params only)", () => {
    const robotsTxt =
      'Content-Usage: train-ai="n", search=n\nContent-Usage: /a/ train-ai;allow=n\nContent-Usage: /b/ TRAIN-AI=n\n';
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
    expect(analysis.sources).toEqual(["robots-content-usage"]);
    expect(analysis.trainingOptOut).toBeNull();
    expect(analysis.signals["robots-content-usage.train-ai"]).toBe('"n"');
    expect(analysis.signals["robots-content-usage./a/.train-ai"]).toBe("");
    expect(analysis.signals["robots-content-usage./b/.TRAIN-AI"]).toBe("n");
  });

  it("takes the last value when a key repeats (structured-field dictionary rule)", () => {
    const analysis = analyzeUsagePreferences(
      [page()],
      metadata({ robotsTxt: "Content-Usage: train-ai=n, train-ai=y\n" }),
    );
    expect(analysis.trainingOptOut).toBe(false);
  });
});

describe("usage-preference-declared — RSL License and TDMRep", () => {
  it("counts a License: line as a declaration that says nothing about training", async () => {
    const robotsTxt = "License: https://example.com/license.xml\nUser-agent: *\nAllow: /\n";
    const result = await run([page()], metadata({ robotsTxt }));
    expect(result.status).toBe("pass");
    expect(result.message).toBe(
      "AI usage preferences declared; no training preference stated (License (RSL))",
    );
    expect(result.details).toContain("trainingOptOut: null");
    expect(result.details).toContain("robots-license: https://example.com/license.xml");
  });

  it("reads tdm-reservation 1 as a training opt-out", async () => {
    const wellKnown = {
      "tdmrep.json": JSON.stringify([{ location: "/", "tdm-reservation": 1 }]),
    };
    const result = await run([page()], metadata({ wellKnown }));
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Training opt-out declared (TDMRep)");
    expect(result.details).toContain("tdmrep./: 1");
  });

  it("reads tdm-reservation 0 as an explicit permission", () => {
    const wellKnown = {
      "tdmrep.json": JSON.stringify([{ location: "/", "tdm-reservation": 0 }]),
    };
    expect(analyzeUsagePreferences([page()], metadata({ wellKnown }))).toMatchObject({
      sources: ["tdmrep"],
      trainingOptOut: false,
    });
  });

  it("does not crash or declare a source on malformed or unusable tdmrep bodies", () => {
    const bodies = [
      "{not json",
      "",
      "null",
      "[]",
      JSON.stringify({ location: "/", "tdm-reservation": 1 }),
      JSON.stringify([{ location: "/" }]),
      JSON.stringify([{ "tdm-reservation": 1 }]),
      JSON.stringify([{ location: "/", "tdm-reservation": 2 }]),
      JSON.stringify([{ location: "/", "tdm-reservation": "1" }]),
      JSON.stringify([null, 3, "x"]),
    ];
    for (const body of bodies) {
      const analysis = analyzeUsagePreferences(
        [page()],
        metadata({ wellKnown: { "tdmrep.json": body } }),
      );
      expect(analysis.sources, body).toEqual([]);
      expect(analysis.trainingOptOut, body).toBeNull();
    }
  });
});

describe("usage-preference-declared — Cloudflare managed default", () => {
  it("detects the managed block prepended above the site's own rules", async () => {
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt: CF_MANAGED_ROBOTS }));
    expect(analysis).toMatchObject({
      sources: ["robots-content-signal"],
      trainingOptOut: true,
      managedDefault: true,
    });
    expect(analysis.signals).toEqual({
      "robots-content-signal.search": "yes",
      "robots-content-signal.ai-train": "no",
      "robots-content-signal.use": "reference",
    });

    const result = await run([page()], metadata({ robotsTxt: CF_MANAGED_ROBOTS }));
    // §5 row 4's pinned user-visible proof.
    expect(result.message).toBe("Training opt-out declared (Content-Signal, CDN-managed default)");
    expect(result.details).toContain("managedDefault: true");
  });

  it("does not call a hand-written Content-Signal a CDN-managed default", () => {
    const robotsTxt = "User-agent: *\nContent-Signal: search=yes, ai-train=no\nAllow: /\n";
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
    expect(analysis.managedDefault).toBe(false);
    expect(analysis.trainingOptOut).toBe(true);
  });

  it("needs both markers, in order", () => {
    expect(isCloudflareManagedRobots(CF_MANAGED_ROBOTS)).toBe(true);
    expect(isCloudflareManagedRobots(`${CF_MANAGED_BLOCK_BEGIN}\nAllow: /\n`)).toBe(false);
    expect(isCloudflareManagedRobots(`${CF_MANAGED_BLOCK_END}\nAllow: /\n`)).toBe(false);
    expect(
      isCloudflareManagedRobots(`${CF_MANAGED_BLOCK_END}\nAllow: /\n${CF_MANAGED_BLOCK_BEGIN}\n`),
    ).toBe(false);
  });
});

describe("usage-preference-declared — no declaration", () => {
  it("skips when nothing declares a preference", async () => {
    const robotsTxt = "User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n";
    const result = await run([page()], metadata({ robotsTxt }));
    expect(result).toMatchObject({ status: "skip", score: 0, tracked: true, weight: 0 });
    expect(result.message).toBe(
      "No AI usage preferences declared (no Content-Signal, Content-Usage, License or TDMRep declaration)",
    );
  });

  it("skips when there is no robots.txt, no header and no tdmrep at all", async () => {
    const result = await run([page()], metadata());
    expect(result.status).toBe("skip");
  });

  it("reports every source it found, in the declared order", () => {
    const robotsTxt =
      "Content-Signal: ai-train=no\nContent-Usage: train-ai=n\nLicense: https://example.com/l.xml\n";
    const pages = [page({ headers: { "content-usage": "train-ai=n" } })];
    const wellKnown = {
      "tdmrep.json": JSON.stringify([{ location: "/", "tdm-reservation": 1 }]),
    };
    expect(analyzeUsagePreferences(pages, metadata({ robotsTxt, wellKnown })).sources).toEqual([
      "robots-content-signal",
      "robots-content-usage",
      "robots-license",
      "http-content-usage",
      "tdmrep",
    ]);
  });
});
