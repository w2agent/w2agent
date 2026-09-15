import type { Check, CheckResult, FetchedPage, SiteMetadata } from "../types.js";

/**
 * Declared AI-usage preferences. Four independent vocabularies are in play and
 * their grammars differ; each entry below carries the spec that defines it,
 * verified to resolve at implementation time (2026-09-15).
 */
export type UsagePreferenceSource =
  | "robots-content-signal"
  | "robots-content-usage"
  | "robots-license"
  | "http-content-usage"
  | "tdmrep";

export interface UsagePreferenceVocabulary {
  source: UsagePreferenceSource;
  /** Name used in the check message. */
  label: string;
  sourceUrl: string;
}

/** Order is the §4.4 union order, so `sources` and `details` are deterministic. */
export const USAGE_PREFERENCE_VOCABULARIES: readonly UsagePreferenceVocabulary[] = [
  {
    source: "robots-content-signal",
    label: "Content-Signal",
    // "Content-Signal: search=yes, ai-train=no" in robots.txt; values are yes/no.
    sourceUrl: "https://blog.cloudflare.com/content-signals-policy/",
  },
  {
    source: "robots-content-usage",
    label: "Content-Usage (robots.txt)",
    // draft-ietf-aipref-attach-05 §3: "content-usage = ... [ path-pattern 1*WS ] usage-pref".
    sourceUrl: "https://datatracker.ietf.org/doc/draft-ietf-aipref-attach/",
  },
  {
    source: "robots-license",
    label: "License (RSL)",
    // RSL 1.0 §4.4: "License" ":" OWS absolute-URI OWS, globally or inside a User-agent group.
    sourceUrl: "https://rslstandard.org/rsl",
  },
  {
    source: "http-content-usage",
    label: "Content-Usage (HTTP header)",
    // draft-ietf-aipref-attach-05 §2: a structured-field dictionary on the HTTP response.
    sourceUrl: "https://datatracker.ietf.org/doc/draft-ietf-aipref-attach/",
  },
  {
    source: "tdmrep",
    label: "TDMRep",
    // W3C TDM Reservation Protocol §6.1: /.well-known/tdmrep.json, an array of
    // {location, tdm-reservation, tdm-policy}; tdm-reservation 1 = rights reserved.
    sourceUrl: "https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240202/",
  },
];

/**
 * Cloudflare prepends its managed block to the site's own robots.txt, so
 * `managedDefault` is containment of the delimited block, not equality of the
 * whole body. Markers captured live 2026-09-15 from
 * `curl -sS -A "w2agent/0.1 (+https://w2agent.dev)" https://www.crawlstop.com/robots.txt`
 * and matching https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/
 * NOTE the casing asymmetry between the two markers: it is Cloudflare's, not a typo.
 */
export const CF_MANAGED_BLOCK_BEGIN = "# BEGIN Cloudflare Managed content";
export const CF_MANAGED_BLOCK_END = "# END Cloudflare Managed Content";

/** AIPREF usage category for model training (draft-ietf-aipref-vocab-08 §6.1, case sensitive). */
const AIPREF_TRAINING_KEY = "train-ai";
/** Content Signals signal for model training (Cloudflare Content Signals Policy). */
const CONTENT_SIGNAL_TRAINING_KEY = "ai-train";

export interface UsagePreferenceAnalysis {
  sources: UsagePreferenceSource[];
  /**
   * `true` when any source declares no-training, `false` when a source
   * explicitly permits training and none forbids it, `null` when declarations
   * exist but none addresses training (e.g. only a `License:` line).
   * Conflicts resolve to the restrictive reading: one forbid outweighs any
   * number of permits, because a site that says "no" anywhere has said no.
   */
  trainingOptOut: boolean | null;
  signals: Record<string, string>;
  managedDefault: boolean;
}

function robotsDirectiveValues(robotsTxt: string, directive: string): string[] {
  const values: string[] = [];
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== directive) continue;
    const value = line
      .slice(colon + 1)
      .split("#")[0]
      .trim();
    if (value !== "") values.push(value);
  }
  return values;
}

/** Content Signals: comma-delimited `key=value`, lowercased (the policy is written lowercase). */
function parseContentSignal(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const member of value.split(",")) {
    const part = member.trim();
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key === "") continue;
    out[key] = part
      .slice(eq + 1)
      .trim()
      .toLowerCase();
  }
  return out;
}

/**
 * AIPREF structured-field dictionary (draft-ietf-aipref-vocab-08 §6). Keys are
 * case sensitive; only the bare tokens `y` and `n` are preferences, anything
 * else (quoted string, bare key, parameters-only) leaves the preference
 * unknown. A repeated key takes its last value, per §6.5.1.
 */
function parseContentUsagePreferences(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const member of value.split(",")) {
    const head = member.split(";")[0].trim();
    if (head === "") continue;
    const eq = head.indexOf("=");
    const key = (eq === -1 ? head : head.slice(0, eq)).trim();
    if (key === "") continue;
    out[key] = eq === -1 ? "" : head.slice(eq + 1).trim();
  }
  return out;
}

/**
 * `Content-Usage: [<path> ]<preferences>` — the path is optional (attach §3).
 * A path uses Allow/Disallow path syntax, so it starts with "/"; a
 * structured-field dictionary key cannot. That is the spec's own
 * discriminator, and it survives a path containing "=".
 */
function splitContentUsageRule(value: string): { path?: string; preferences: string } {
  const space = value.search(/[ \t]/);
  if (space === -1 || !value.startsWith("/")) return { preferences: value };
  return { path: value.slice(0, space), preferences: value.slice(space + 1).trim() };
}

interface TdmRule {
  location: string;
  reservation: 0 | 1;
}

/**
 * `/.well-known/tdmrep.json` is an array of rules; `location` and
 * `tdm-reservation` are mandatory and any other reservation value is a
 * protocol error that leaves the reservation unset (TDMRep §5.1). A body that
 * is not an array, or that carries no usable rule, is not a declaration.
 */
function parseTdmrep(raw: string | undefined): TdmRule[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rules: TdmRule[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const location = record.location;
    const reservation = record["tdm-reservation"];
    if (typeof location !== "string") continue;
    if (reservation !== 0 && reservation !== 1) continue;
    rules.push({ location, reservation });
  }
  return rules;
}

function hrefOf(url: string): string | undefined {
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
}

function findHomepage(pages: FetchedPage[], baseUrl: string): FetchedPage | undefined {
  const homepageHref = hrefOf(`${baseUrl}/`);
  if (homepageHref === undefined) return undefined;
  return pages.find((page) => hrefOf(page.url) === homepageHref);
}

export function analyzeUsagePreferences(
  pages: FetchedPage[],
  metadata: SiteMetadata,
): UsagePreferenceAnalysis {
  const robotsTxt = metadata.robotsTxt ?? "";
  const signals: Record<string, string> = {};
  const found = new Set<UsagePreferenceSource>();
  let forbidsTraining = false;
  let permitsTraining = false;

  for (const value of robotsDirectiveValues(robotsTxt, "content-signal")) {
    const parsed = parseContentSignal(value);
    if (Object.keys(parsed).length === 0) continue;
    found.add("robots-content-signal");
    for (const [key, signal] of Object.entries(parsed)) {
      signals[`robots-content-signal.${key}`] = signal;
      if (key !== CONTENT_SIGNAL_TRAINING_KEY) continue;
      if (signal === "no") forbidsTraining = true;
      if (signal === "yes") permitsTraining = true;
    }
  }

  for (const value of robotsDirectiveValues(robotsTxt, "content-usage")) {
    const { path, preferences } = splitContentUsageRule(value);
    const parsed = parseContentUsagePreferences(preferences);
    if (Object.keys(parsed).length === 0) continue;
    found.add("robots-content-usage");
    const scope = path === undefined ? "" : `${path}.`;
    for (const [key, preference] of Object.entries(parsed)) {
      signals[`robots-content-usage.${scope}${key}`] = preference;
      if (key !== AIPREF_TRAINING_KEY) continue;
      if (preference === "n") forbidsTraining = true;
      if (preference === "y") permitsTraining = true;
    }
  }

  const licenses = robotsDirectiveValues(robotsTxt, "license");
  if (licenses.length > 0) {
    found.add("robots-license");
    signals["robots-license"] = licenses.join(" ");
  }

  const homepage = findHomepage(pages, metadata.baseUrl);
  const headerValue = homepage?.headers["content-usage"];
  if (headerValue !== undefined) {
    const parsed = parseContentUsagePreferences(headerValue);
    if (Object.keys(parsed).length > 0) {
      found.add("http-content-usage");
      for (const [key, preference] of Object.entries(parsed)) {
        signals[`http-content-usage.${key}`] = preference;
        if (key !== AIPREF_TRAINING_KEY) continue;
        if (preference === "n") forbidsTraining = true;
        if (preference === "y") permitsTraining = true;
      }
    }
  }

  const tdmRules = parseTdmrep(metadata.wellKnown["tdmrep.json"]);
  if (tdmRules.length > 0) {
    found.add("tdmrep");
    for (const rule of tdmRules) {
      signals[`tdmrep.${rule.location}`] = String(rule.reservation);
      if (rule.reservation === 1) forbidsTraining = true;
      if (rule.reservation === 0) permitsTraining = true;
    }
  }

  const sources = USAGE_PREFERENCE_VOCABULARIES.filter((v) => found.has(v.source)).map(
    (v) => v.source,
  );
  const trainingOptOut = forbidsTraining ? true : permitsTraining ? false : null;
  const managedDefault = isCloudflareManagedRobots(robotsTxt);

  return { sources, trainingOptOut, signals, managedDefault };
}

/**
 * True when the robots body *contains* Cloudflare's delimited managed block.
 * Byte-equality of the whole body would never hold: Cloudflare prepends the
 * block to the site's own robots.txt.
 */
export function isCloudflareManagedRobots(robotsTxt: string): boolean {
  const begin = robotsTxt.indexOf(CF_MANAGED_BLOCK_BEGIN);
  if (begin === -1) return false;
  return robotsTxt.indexOf(CF_MANAGED_BLOCK_END, begin) > begin;
}

const LABELS = new Map(USAGE_PREFERENCE_VOCABULARIES.map((v) => [v.source, v.label]));

function messageFor(analysis: UsagePreferenceAnalysis): string {
  const parts = analysis.sources.map((s) => LABELS.get(s) ?? s);
  if (analysis.managedDefault) parts.push("CDN-managed default");
  const where = `(${parts.join(", ")})`;
  if (analysis.trainingOptOut === true) return `Training opt-out declared ${where}`;
  if (analysis.trainingOptOut === false) {
    return `AI usage preferences declared; training is permitted ${where}`;
  }
  return `AI usage preferences declared; no training preference stated ${where}`;
}

function detailsFor(analysis: UsagePreferenceAnalysis): string {
  return [
    `sources: ${analysis.sources.join(", ")}`,
    `trainingOptOut: ${analysis.trainingOptOut}`,
    `managedDefault: ${analysis.managedDefault}`,
    ...Object.entries(analysis.signals).map(([key, value]) => `${key}: ${value}`),
  ].join("\n");
}

export const usagePreferenceDeclared: Check = {
  id: "usage-preference-declared",
  name: "Declared AI usage preferences",
  category: "bot-accessibility",
  weight: 0,
  severity: "info",
  tracked: true,
  run: (pages, metadata): CheckResult => {
    const base = {
      id: "usage-preference-declared",
      name: "Declared AI usage preferences",
      category: "bot-accessibility" as const,
      maxScore: 100,
      weight: 0,
      severity: "info" as const,
      tracked: true,
    };
    const analysis = analyzeUsagePreferences(pages, metadata);

    if (analysis.sources.length === 0) {
      return {
        ...base,
        status: "skip",
        score: 0,
        message:
          "No AI usage preferences declared (no Content-Signal, Content-Usage, License or TDMRep declaration)",
        details: detailsFor(analysis),
      };
    }

    return {
      ...base,
      status: "pass",
      score: 100,
      message: messageFor(analysis),
      details: detailsFor(analysis),
    };
  },
};

export const preferenceChecks: Check[] = [usagePreferenceDeclared];
