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
    // The unscoped rule is the one that covers the homepage; /ai-ok/ does not.
    expect(analysis.trainingOptOut).toBe(true);
  });

  it("keeps a path that contains '=' as a path (paths start with /, dictionary keys cannot)", () => {
    const analysis = analyzeUsagePreferences(
      [page()],
      metadata({ robotsTxt: "Content-Usage: /a=b/ train-ai=n\n" }),
    );
    expect(analysis.signals).toEqual({ "robots-content-usage./a=b/.train-ai": "n" });
    // /a=b/ does not cover the homepage, so it states nothing about a generic fetch of "/".
    expect(analysis).toMatchObject({ trainingOptOut: null, trainingScoped: true });
  });

  it("treats non-token values as unknown (vocab §6.5: quoted string, bare key with params)", () => {
    const robotsTxt =
      'Content-Usage: train-ai="n", search=n\nContent-Usage: /a/ train-ai;allow=n\n';
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
    expect(analysis.sources).toEqual(["robots-content-usage"]);
    expect(analysis).toMatchObject({ trainingOptOut: null, trainingScoped: false });
    expect(analysis.signals["robots-content-usage.train-ai"]).toBe('"n"');
    expect(analysis.signals["robots-content-usage./a/.train-ai"]).toBe("");
  });

  it("takes the last value when a key repeats (structured-field dictionary rule)", () => {
    const analysis = analyzeUsagePreferences(
      [page()],
      metadata({ robotsTxt: "Content-Usage: train-ai=n, train-ai=y\n" }),
    );
    expect(analysis.trainingOptOut).toBe(false);
  });
});

/**
 * RFC 9651 §4.2.2 parsing, applied because AIPREF vocab §6.5.1 is fail-closed:
 * "If the parsing of the Dictionary fails, preferences are unknown."
 */
describe("usage-preference-declared — structured-field dictionary parsing", () => {
  const usage = (value: string) =>
    analyzeUsagePreferences([page()], metadata({ robotsTxt: `Content-Usage: ${value}\n` }));

  it("consumes a quoted string opaquely, so a comma inside it is not a member separator", () => {
    const analysis = usage('note="a, train-ai=n , b"');
    expect(analysis.sources).toEqual(["robots-content-usage"]);
    expect(analysis).toMatchObject({ trainingOptOut: null, trainingScoped: false });
    expect(analysis.signals).toEqual({
      "robots-content-usage.note": '"a, train-ai=n , b"',
    });
  });

  it("reads a permit whose parameter holds a quoted string that looks like an opt-out", () => {
    const analysis = usage('train-ai=y;note="hello, train-ai=n;tail"');
    expect(analysis.trainingOptOut).toBe(false);
    expect(analysis.signals).toEqual({ "robots-content-usage.train-ai": "y" });
  });

  it('honors \\" and \\\\ escapes inside a quoted string', () => {
    expect(usage('note="a\\"b, train-ai=n", search=y').signals).toEqual({
      "robots-content-usage.note": '"a\\"b, train-ai=n"',
      "robots-content-usage.search": "y",
    });
    expect(usage('note="a\\\\", train-ai=n').trainingOptOut).toBe(true);
  });

  it("invalidates the whole line when a parameter is malformed", () => {
    const analysis = usage("train-ai=n;@bad");
    expect(analysis.sources).toEqual([]);
    expect(analysis.signals).toEqual({});
    expect(analysis).toMatchObject({ trainingOptOut: null, trainingScoped: false });
  });

  it("invalidates the whole line when any key carries an uppercase character", () => {
    for (const value of ["TRAIN-AI=n, train-ai=n", "train-Ai=n", "train-ai=n;Allow=1"]) {
      const analysis = usage(value);
      expect(analysis.sources, value).toEqual([]);
      expect(analysis.signals, value).toEqual({});
    }
  });

  it("fails closed on every other dictionary syntax error", () => {
    const invalid = [
      "train-ai=n,",
      "train-ai=n, ",
      ",train-ai=n",
      'note="unterminated, train-ai=n',
      'note="bad\\escape", train-ai=n',
      "train-ai=n extra",
      "train-ai=(a b, train-ai=n",
      "train-ai=?2",
      "train-ai=@1.5",
      "train-ai=:not base64:",
      "9key=n",
    ];
    for (const value of invalid) {
      expect(usage(value).sources, value).toEqual([]);
    }
  });

  it("consumes an inner list opaquely without losing a sibling preference", () => {
    const analysis = usage("x=(a b);p=1, train-ai=n");
    expect(analysis.trainingOptOut).toBe(true);
    expect(analysis.signals).toEqual({
      "robots-content-usage.x": "(a b)",
      "robots-content-usage.train-ai": "n",
    });
  });

  it("applies the same parser to the HTTP Content-Usage header", () => {
    const quoted = [page({ headers: { "content-usage": 'note="a, train-ai=n"' } })];
    expect(analyzeUsagePreferences(quoted, metadata())).toMatchObject({
      sources: ["http-content-usage"],
      trainingOptOut: null,
    });

    const uppercase = [page({ headers: { "content-usage": "TRAIN-AI=n" } })];
    expect(analyzeUsagePreferences(uppercase, metadata()).sources).toEqual([]);
  });
});

describe("usage-preference-declared — scope of the verdict", () => {
  it("does not let a path-scoped forbid override a site-wide permit", () => {
    const robotsTxt = "Content-Usage: train-ai=y\nContent-Usage: /legal/ train-ai=n\n";
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
    expect(analysis).toMatchObject({ trainingOptOut: false, trainingScoped: true });
  });

  it("does not read a named crawler's group as a site-wide statement", async () => {
    const robotsTxt = "User-agent: FooBot\nAllow: /\nContent-Usage: /press/ train-ai=y\n";
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
    expect(analysis).toMatchObject({ trainingOptOut: null, trainingScoped: true });
    expect(analysis.signals).toEqual({
      "robots-content-usage.FooBot./press/.train-ai": "y",
    });

    const result = await run([page()], metadata({ robotsTxt }));
    expect(result.status).toBe("pass");
    expect(result.message).toBe(
      "AI usage preferences declared; the training preference is scoped to specific agents or paths (Content-Usage (robots.txt))",
    );
    expect(result.details).toContain("trainingOptOut: null");
  });

  it("scopes a Content-Signal declared inside a named crawler's group", () => {
    const robotsTxt = "User-agent: GPTBot\nContent-Signal: ai-train=no\nAllow: /\n";
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
    expect(analysis).toMatchObject({ trainingOptOut: null, trainingScoped: true });
    expect(analysis.signals).toEqual({ "robots-content-signal.GPTBot.ai-train": "no" });
  });

  it("counts the wildcard group and the group-less preamble as generic", () => {
    const wildcard =
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nContent-Signal: ai-train=no\n";
    expect(analyzeUsagePreferences([page()], metadata({ robotsTxt: wildcard }))).toMatchObject({
      trainingOptOut: true,
      trainingScoped: false,
    });

    const preamble = "Content-Signal: ai-train=no\nUser-agent: GPTBot\nDisallow: /\n";
    expect(analyzeUsagePreferences([page()], metadata({ robotsTxt: preamble }))).toMatchObject({
      trainingOptOut: true,
    });
  });

  it("treats a path as site-wide only when it covers the homepage", () => {
    for (const path of ["/", "/*"]) {
      const robotsTxt = `Content-Usage: ${path} train-ai=n\n`;
      expect(analyzeUsagePreferences([page()], metadata({ robotsTxt })).trainingOptOut, path).toBe(
        true,
      );
    }
    for (const path of ["/legal/", "/*.pdf$"]) {
      const robotsTxt = `Content-Usage: ${path} train-ai=n\n`;
      expect(
        analyzeUsagePreferences([page()], metadata({ robotsTxt })).trainingOptOut,
        path,
      ).toBeNull();
    }
  });

  it("counts an HTTP header on the homepage response as in scope", () => {
    const pages = [page({ headers: { "content-usage": "train-ai=n" } })];
    expect(analyzeUsagePreferences(pages, metadata())).toMatchObject({
      trainingOptOut: true,
      trainingScoped: false,
    });
  });

  it("reads declarations split by bare CR line endings (REP allows CR-only files)", () => {
    const robotsTxt = "User-agent: *\rContent-Signal: ai-train=no\rAllow: /\r";
    expect(analyzeUsagePreferences([page()], metadata({ robotsTxt }))).toMatchObject({
      sources: ["robots-content-signal"],
      trainingOptOut: true,
    });
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

  it("rejects a License value that is not an absolute URI (RSL 1.0 §4.4.1)", () => {
    for (const value of ["bananas", "/licenses/rsl.xml", "example.com/license.xml", "://x"]) {
      const robotsTxt = `License: ${value}\n`;
      const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
      expect(analysis.sources, value).toEqual([]);
      expect(analysis.signals, value).toEqual({});
    }
  });

  it("keeps only the absolute-URI License values", () => {
    const robotsTxt = "License: bananas\nLicense: https://example.com/license.xml\n";
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
    expect(analysis.sources).toEqual(["robots-license"]);
    expect(analysis.signals).toEqual({ "robots-license": "https://example.com/license.xml" });
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

  it("uses the first location that matches the homepage (TDMRep §6.1) and scopes the rest", () => {
    const wellKnown = {
      "tdmrep.json": JSON.stringify([
        { location: "/directory-a/", "tdm-reservation": 1 },
        { location: "/", "tdm-reservation": 0 },
        { location: "/directory-b/", "tdm-reservation": 1 },
      ]),
    };
    const analysis = analyzeUsagePreferences([page()], metadata({ wellKnown }));
    expect(analysis).toMatchObject({ trainingOptOut: false, trainingScoped: true });
    expect(analysis.signals).toEqual({
      "tdmrep./directory-a/": "1",
      "tdmrep./": "0",
      "tdmrep./directory-b/": "1",
    });
  });

  it("states no site-wide preference when no location matches the homepage", () => {
    const wellKnown = {
      "tdmrep.json": JSON.stringify([{ location: "/directory-a/", "tdm-reservation": 1 }]),
    };
    expect(analyzeUsagePreferences([page()], metadata({ wellKnown }))).toMatchObject({
      sources: ["tdmrep"],
      trainingOptOut: null,
      trainingScoped: true,
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
    // §5 row 4's pinned user-visible proof, byte for byte.
    expect(result.message).toBe("Training opt-out declared (Content-Signal, CDN-managed default)");
    expect(result.details).toBe(
      [
        "sources: robots-content-signal",
        "trainingOptOut: true",
        "managedDefault: true",
        "robots-content-signal.search: yes",
        "robots-content-signal.ai-train: no",
        "robots-content-signal.use: reference",
      ].join("\n"),
    );
  });

  it("does not claim CDN provenance for an empty managed block", () => {
    const robotsTxt = `${CF_MANAGED_BLOCK_BEGIN}\n\n${CF_MANAGED_BLOCK_END}\nUser-agent: *\nAllow: /\n`;
    expect(isCloudflareManagedRobots(robotsTxt)).toBe(false);
    expect(analyzeUsagePreferences([page()], metadata({ robotsTxt })).managedDefault).toBe(false);
  });

  it("does not claim CDN provenance when the block carries only Allow/Disallow rules", () => {
    const robotsTxt = `${CF_MANAGED_BLOCK_BEGIN}\nUser-agent: GPTBot\nDisallow: /\n${CF_MANAGED_BLOCK_END}\n`;
    expect(isCloudflareManagedRobots(robotsTxt)).toBe(false);
  });

  it("drops the CDN-managed label when the site declares its own Content-Signal too", async () => {
    const robotsTxt = `${CF_MANAGED_ROBOTS}\nUser-agent: *\nContent-Signal: ai-train=no, search=no\n`;
    const analysis = analyzeUsagePreferences([page()], metadata({ robotsTxt }));
    expect(analysis).toMatchObject({ managedDefault: false, trainingOptOut: true });

    const result = await run([page()], metadata({ robotsTxt }));
    expect(result.message).toBe("Training opt-out declared (Content-Signal)");
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
