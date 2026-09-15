import robotsParser from "robots-parser";
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
    // RSL 1.0 §4.4.1: "license-directive = "License" ":" OWS absolute-URI OWS".
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
   * What the declarations say about training *for the homepage, fetched by a
   * generic agent* — the only subject this check can speak for. `true` when a
   * declaration in scope forbids training, `false` when one permits it and none
   * forbids it, `null` when no in-scope declaration addresses training. A
   * declaration that applies to a named crawler or to a path that does not
   * cover "/" never moves this value; it is reported in `signals` and sets
   * `trainingScoped` instead.
   */
  trainingOptOut: boolean | null;
  /** A training preference was declared, but only outside the homepage/generic-agent scope. */
  trainingScoped: boolean;
  signals: Record<string, string>;
  managedDefault: boolean;
}

// ---------------------------------------------------------------------------
// RFC 9651 structured fields
// ---------------------------------------------------------------------------

/**
 * A dictionary member. `token` is set only when the member's value is a bare
 * Token; every other bare item type leaves it undefined, which AIPREF reads as
 * "unknown" (vocab §6.5). `raw` is the source text of the bare item, used for
 * the human-readable `signals` rendering.
 */
interface DictionaryMember {
  token?: string;
  raw: string;
}

class StructuredFieldError extends Error {}

interface Cursor {
  s: string;
  i: number;
}

function fail(): never {
  throw new StructuredFieldError("structured field parse error");
}

function peek(c: Cursor): string {
  return c.s[c.i] ?? "";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isLcAlpha(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

function isAlpha(ch: string): boolean {
  return isLcAlpha(ch) || (ch >= "A" && ch <= "Z");
}

/** tchar (RFC 9110) plus ":" and "/", the token charset of RFC 9651 §4.2.6. */
const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~:/0-9A-Za-z]/;

function skipOws(c: Cursor): void {
  while (peek(c) === " " || peek(c) === "\t") c.i++;
}

function skipSp(c: Cursor): void {
  while (peek(c) === " ") c.i++;
}

/** §4.2.3.3. Fails on an uppercase or otherwise out-of-charset first character. */
function parseKey(c: Cursor): string {
  const start = c.i;
  const first = peek(c);
  if (!isLcAlpha(first) && first !== "*") fail();
  c.i++;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (!isLcAlpha(ch) && !isDigit(ch) && ch !== "_" && ch !== "-" && ch !== "." && ch !== "*") {
      break;
    }
    c.i++;
  }
  return c.s.slice(start, c.i);
}

/** §4.2.4. Returns the parsed type so §4.2.9 can reject a Decimal date. */
function parseNumber(c: Cursor): "integer" | "decimal" {
  let type: "integer" | "decimal" = "integer";
  let digits = "";
  if (peek(c) === "-") c.i++;
  if (!isDigit(peek(c))) fail();
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (isDigit(ch)) {
      digits += ch;
      c.i++;
    } else if (type === "integer" && ch === ".") {
      if (digits.length > 12) fail();
      digits += ch;
      type = "decimal";
      c.i++;
    } else {
      break;
    }
    if (type === "integer" && digits.length > 15) fail();
    if (type === "decimal" && digits.length > 16) fail();
  }
  if (type === "decimal") {
    const dot = digits.indexOf(".");
    if (dot === digits.length - 1) fail();
    if (digits.length - dot - 1 > 3) fail();
  }
  return type;
}

/** §4.2.5. Consumed opaquely, but escapes and the closing DQUOTE are enforced. */
function parseString(c: Cursor): void {
  if (peek(c) !== '"') fail();
  c.i++;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    c.i++;
    if (ch === "\\") {
      const next = c.s[c.i];
      if (next !== '"' && next !== "\\") fail();
      c.i++;
      continue;
    }
    if (ch === '"') return;
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code >= 0x7f) fail();
  }
  fail();
}

/** §4.2.6. */
function parseToken(c: Cursor): string {
  const start = c.i;
  if (!isAlpha(peek(c)) && peek(c) !== "*") fail();
  c.i++;
  while (c.i < c.s.length && TOKEN_CHAR.test(c.s[c.i])) c.i++;
  return c.s.slice(start, c.i);
}

/** §4.2.7. */
function parseByteSequence(c: Cursor): void {
  if (peek(c) !== ":") fail();
  c.i++;
  const end = c.s.indexOf(":", c.i);
  if (end === -1) fail();
  const content = c.s.slice(c.i, end);
  if (!/^[A-Za-z0-9+/=]*$/.test(content)) fail();
  c.i = end + 1;
}

/** §4.2.8. */
function parseBoolean(c: Cursor): void {
  if (peek(c) !== "?") fail();
  c.i++;
  const ch = peek(c);
  if (ch !== "0" && ch !== "1") fail();
  c.i++;
}

/** §4.2.10. Structural scan; the decoded code points are not needed here. */
function parseDisplayString(c: Cursor): void {
  if (peek(c) !== "%" || c.s[c.i + 1] !== '"') fail();
  c.i += 2;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    c.i++;
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code >= 0x7f) fail();
    if (ch === '"') return;
    if (ch === "%") {
      const hex = c.s.slice(c.i, c.i + 2);
      if (hex.length !== 2 || !/^[0-9a-f]{2}$/.test(hex)) fail();
      c.i += 2;
    }
  }
  fail();
}

/** §4.2.3.1. Returns the Token text when the item is a Token, else undefined. */
function parseBareItem(c: Cursor): string | undefined {
  const ch = peek(c);
  if (ch === "-" || isDigit(ch)) {
    parseNumber(c);
    return undefined;
  }
  if (ch === '"') {
    parseString(c);
    return undefined;
  }
  if (isAlpha(ch) || ch === "*") return parseToken(c);
  if (ch === ":") {
    parseByteSequence(c);
    return undefined;
  }
  if (ch === "?") {
    parseBoolean(c);
    return undefined;
  }
  if (ch === "@") {
    c.i++;
    if (parseNumber(c) === "decimal") fail();
    return undefined;
  }
  if (ch === "%") {
    parseDisplayString(c);
    return undefined;
  }
  return fail();
}

/** §4.2.3.2. Consumed but fully validated — a bad parameter invalidates the field. */
function parseParameters(c: Cursor): void {
  while (peek(c) === ";") {
    c.i++;
    skipSp(c);
    parseKey(c);
    if (peek(c) === "=") {
      c.i++;
      parseBareItem(c);
    }
  }
}

/**
 * §4.2.1.2, without the trailing parameters: the caller reads them, so that the
 * member's `raw` rendering stops at the closing ")". The inner list itself is
 * consumed opaquely — it carries no preference.
 */
function parseInnerList(c: Cursor): void {
  if (peek(c) !== "(") fail();
  c.i++;
  while (c.i < c.s.length) {
    skipSp(c);
    if (peek(c) === ")") {
      c.i++;
      return;
    }
    parseBareItem(c);
    parseParameters(c);
    const ch = peek(c);
    if (ch !== " " && ch !== ")") fail();
  }
  fail();
}

/** §4.2.1.1 + §4.2.3, returning the member's bare Token and source text. */
function parseItemOrInnerList(c: Cursor): DictionaryMember {
  const start = c.i;
  if (peek(c) === "(") {
    parseInnerList(c);
    const raw = c.s.slice(start, c.i);
    parseParameters(c);
    return { raw };
  }
  const token = parseBareItem(c);
  const raw = c.s.slice(start, c.i);
  parseParameters(c);
  return token === undefined ? { raw } : { token, raw };
}

/**
 * RFC 9651 §4.2.2, the parse AIPREF requires (vocab §6.5, §6.5.1). Returns
 * `undefined` when parsing fails anywhere in the field: a failed parse leaves
 * every preference unknown and the whole field contributes nothing, so a
 * `note="a, train-ai=n"` string or a `TRAIN-AI=n` uppercase key can never be
 * mistaken for a declaration. A repeated key takes its last value.
 */
function parseContentUsagePreferences(value: string): Record<string, DictionaryMember> | undefined {
  const c: Cursor = { s: value, i: 0 };
  const dictionary: Record<string, DictionaryMember> = {};
  try {
    skipSp(c);
    while (c.i < c.s.length) {
      const key = parseKey(c);
      if (peek(c) === "=") {
        c.i++;
        dictionary[key] = parseItemOrInnerList(c);
      } else {
        parseParameters(c);
        dictionary[key] = { raw: "" };
      }
      skipOws(c);
      if (c.i >= c.s.length) return dictionary;
      if (c.s[c.i] !== ",") fail();
      c.i++;
      skipOws(c);
      if (c.i >= c.s.length) fail();
    }
    return dictionary;
  } catch (error) {
    if (error instanceof StructuredFieldError) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/** REP allows CR, LF and CRLF line endings; a CR-only file must not be one line. */
const ROBOTS_LINE_BREAK = /\r\n|\r|\n/;

interface RobotsLine {
  key: string;
  value: string;
  /** The group's user-agent values, or `undefined` for the group-less preamble. */
  agents: string[] | undefined;
  insideManagedBlock: boolean;
}

/**
 * One pass over robots.txt that keeps RFC 9309 §2.2.1 group membership, because
 * a declaration inside a `User-agent: FooBot` group says nothing about what a
 * generic agent may do. Consecutive user-agent lines form one group; a
 * user-agent line following a rule starts a new one.
 */
function scanRobots(robotsTxt: string): RobotsLine[] {
  const lines: RobotsLine[] = [];
  let agents: string[] | undefined;
  let lastWasAgent = false;
  let insideManagedBlock = false;

  for (const rawLine of robotsTxt.split(ROBOTS_LINE_BREAK)) {
    const trimmed = rawLine.trim();
    // The block markers are comments, so they are read before comment stripping.
    if (trimmed.startsWith(CF_MANAGED_BLOCK_BEGIN)) {
      insideManagedBlock = true;
      continue;
    }
    if (trimmed.startsWith(CF_MANAGED_BLOCK_END)) {
      insideManagedBlock = false;
      continue;
    }
    const hash = trimmed.indexOf("#");
    const text = hash > -1 ? trimmed.slice(0, hash) : trimmed;
    const colon = text.indexOf(":");
    if (colon < 0) continue;
    const key = text.slice(0, colon).trim().toLowerCase();
    const value = text.slice(colon + 1).trim();
    if (key === "") continue;
    if (key === "user-agent") {
      if (!lastWasAgent || agents === undefined) agents = [];
      if (value !== "") agents.push(value);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (value !== "") lines.push({ key, value, agents, insideManagedBlock });
  }
  return lines;
}

function directiveLines(lines: RobotsLine[], directive: string): RobotsLine[] {
  return lines.filter((line) => line.key === directive);
}

/** A group a generic agent selects: the preamble, or a group naming "*". */
function isGenericGroup(line: RobotsLine): boolean {
  if (line.agents === undefined) return true;
  return line.agents.some((agent) => agent.trim().toLowerCase() === "*");
}

/** Key segment identifying a non-generic group in `signals`. */
function agentScope(line: RobotsLine): string {
  const agents = line.agents ?? [];
  return agents.length > 0 ? `${agents.join("|")}.` : "(unnamed).";
}

/**
 * True when a robots path pattern covers the homepage. REP path matching (and
 * TDMRep §6.1.1, which re-uses it) is not a plain prefix test — "*" and "$" are
 * significant — so the match is delegated to the same parser the crawler uses.
 */
function coversRoot(pattern: string, baseUrl: string): boolean {
  try {
    const probe = robotsParser(`${baseUrl}/robots.txt`, `User-agent: *\nDisallow: ${pattern}`);
    return probe.isAllowed(`${baseUrl}/`, "probe") === false;
  } catch {
    return false;
  }
}

/**
 * `Content-Usage: [<path> ]<preferences>` — the path is optional (attach §3.2).
 * A path uses Allow/Disallow path syntax, so it starts with "/"; a
 * structured-field dictionary key cannot. That is the spec's own
 * discriminator, and it survives a path containing "=".
 */
function splitContentUsageRule(value: string): { path?: string; preferences: string } {
  const space = value.search(/[ \t]/);
  if (space === -1 || !value.startsWith("/")) return { preferences: value };
  return { path: value.slice(0, space), preferences: value.slice(space + 1).trim() };
}

/** RSL 1.0 §4.4.1: the License value MUST be an absolute URI. */
function isAbsoluteUri(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9+\-.]*:/.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// TDMRep
// ---------------------------------------------------------------------------

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
  const robotsLines = scanRobots(robotsTxt);
  const baseUrl = metadata.baseUrl;
  const signals: Record<string, string> = {};
  const found = new Set<UsagePreferenceSource>();
  let forbidsTraining = false;
  let permitsTraining = false;
  let trainingScoped = false;

  /** Records a training statement against the homepage/generic-agent scope. */
  const recordTraining = (inScope: boolean, forbids: boolean): void => {
    if (!inScope) {
      trainingScoped = true;
      return;
    }
    if (forbids) forbidsTraining = true;
    else permitsTraining = true;
  };

  for (const line of directiveLines(robotsLines, "content-signal")) {
    const parsed = parseContentSignal(line.value);
    if (Object.keys(parsed).length === 0) continue;
    found.add("robots-content-signal");
    const inScope = isGenericGroup(line);
    const scope = inScope ? "" : agentScope(line);
    for (const [key, signal] of Object.entries(parsed)) {
      signals[`robots-content-signal.${scope}${key}`] = signal;
      if (key !== CONTENT_SIGNAL_TRAINING_KEY) continue;
      if (signal === "no") recordTraining(inScope, true);
      if (signal === "yes") recordTraining(inScope, false);
    }
  }

  for (const line of directiveLines(robotsLines, "content-usage")) {
    const { path, preferences } = splitContentUsageRule(line.value);
    const parsed = parseContentUsagePreferences(preferences);
    if (parsed === undefined || Object.keys(parsed).length === 0) continue;
    found.add("robots-content-usage");
    const genericGroup = isGenericGroup(line);
    const inScope = genericGroup && (path === undefined || coversRoot(path, baseUrl));
    const scope = `${genericGroup ? "" : agentScope(line)}${path === undefined ? "" : `${path}.`}`;
    for (const [key, member] of Object.entries(parsed)) {
      signals[`robots-content-usage.${scope}${key}`] = member.raw;
      if (key !== AIPREF_TRAINING_KEY) continue;
      if (member.token === "n") recordTraining(inScope, true);
      if (member.token === "y") recordTraining(inScope, false);
    }
  }

  const licenses = directiveLines(robotsLines, "license")
    .map((line) => line.value)
    .filter(isAbsoluteUri);
  if (licenses.length > 0) {
    found.add("robots-license");
    signals["robots-license"] = licenses.join(" ");
  }

  const homepage = findHomepage(pages, baseUrl);
  const headerValue = homepage?.headers["content-usage"];
  if (headerValue !== undefined) {
    const parsed = parseContentUsagePreferences(headerValue);
    if (parsed !== undefined && Object.keys(parsed).length > 0) {
      found.add("http-content-usage");
      for (const [key, member] of Object.entries(parsed)) {
        signals[`http-content-usage.${key}`] = member.raw;
        if (key !== AIPREF_TRAINING_KEY) continue;
        // The header travelled on the homepage response: it always applies.
        if (member.token === "n") recordTraining(true, true);
        if (member.token === "y") recordTraining(true, false);
      }
    }
  }

  const tdmRules = parseTdmrep(metadata.wellKnown["tdmrep.json"]);
  if (tdmRules.length > 0) {
    found.add("tdmrep");
    // TDMRep §6.1: "The most specific match is the first in sequence" — only the
    // first rule whose location matches "/" governs the homepage.
    const governing = tdmRules.find((rule) => coversRoot(rule.location, baseUrl));
    for (const rule of tdmRules) {
      signals[`tdmrep.${rule.location}`] = String(rule.reservation);
      recordTraining(rule === governing, rule.reservation === 1);
    }
  }

  const sources = USAGE_PREFERENCE_VOCABULARIES.filter((v) => found.has(v.source)).map(
    (v) => v.source,
  );
  const trainingOptOut = forbidsTraining ? true : permitsTraining ? false : null;
  const managedDefault = isCloudflareManagedRobots(robotsTxt);

  return { sources, trainingOptOut, trainingScoped, signals, managedDefault };
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
 * True when the robots body carries a Cloudflare-managed Content Signals
 * default: the delimited block must contain an actual `Content-Signal` line
 * (an empty block is forgeable and declares nothing), and the site must not
 * carry a `Content-Signal` line of its own outside the block — if it does, the
 * signal is the site's own choice, not a CDN default.
 */
export function isCloudflareManagedRobots(robotsTxt: string): boolean {
  const signalLines = directiveLines(scanRobots(robotsTxt), "content-signal");
  if (signalLines.some((line) => !line.insideManagedBlock)) return false;
  return signalLines.some((line) => line.insideManagedBlock);
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
  if (analysis.trainingScoped) {
    return `AI usage preferences declared; the training preference is scoped to specific agents or paths ${where}`;
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
