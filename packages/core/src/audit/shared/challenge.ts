export type ChallengeVendor =
  | "cloudflare"
  | "akamai"
  | "datadome"
  | "perimeterx"
  | "imperva"
  | "aws-waf"
  | "unknown";

export interface ChallengeFingerprint {
  vendor: ChallengeVendor;
  kind: "header" | "body";
  header?: string;
  pattern: string;
  sourceUrl: string;
}

const CF_DETECT_RESPONSE =
  "https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/";
const CF_CHALLENGE_TEMPLATE =
  "https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/additional-configuration/";
// Live capture, 2026-09-15, UA "w2agent/0.1 (+https://w2agent.dev)":
//   https://www.udemy.com/ → HTTP 403, server: cloudflare, cf-mitigated: challenge,
//   body @4578 `a.src = '/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=…'`
//   (same shape on patreon.com, glassdoor.com, upwork.com, indeed.com).
// Negative control, same capture: https://www.g2.com/ → HTTP 403, server: cloudflare,
//   NO cf-mitigated, body @1017 `a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'`
//   — JavaScript Detections instrumentation on an ordinary WAF block, not a challenge
//   (identical script on https://www.crunchbase.com/ at HTTP 200). Hence the `/h/`
//   segment: it is the challenge orchestrator path, and `scripts/jsd/` is excluded.
const CF_CHALLENGE_ORCHESTRATE = "https://www.udemy.com/";
const CF_TURNSTILE =
  "https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/";
const CF_HTTP_HEADERS = "https://developers.cloudflare.com/fundamentals/reference/http-headers/";
const AWS_WAF_ACTIONS =
  "https://docs.aws.amazon.com/waf/latest/developerguide/waf-captcha-and-challenge-actions.html";
const HCAPTCHA = "https://docs.hcaptcha.com/";
const RECAPTCHA = "https://developers.google.com/recaptcha/docs/display";
// The tag doc names `ct.captcha-delivery.com` as the CSP source for the *response page*
// (challenge) scripts and `js.datadome.co` as the source for the ordinary tag. Only the
// former is a challenge, so the fingerprint is the delivery domain and never the vendor
// name: https://www.vinted.com/ answers HTTP 200 carrying `set-cookie: datadome=`.
// Live capture, 2026-09-17, UA "w2agent/0.1 (+https://w2agent.dev)":
//   https://www.etsy.com/ → HTTP 403, 776-byte body, `'host':'geo.captcha-delivery.com'`
//   @510 and `<script src="https://ct.captcha-delivery.com/c.js">` @726 — both inside the
//   4 KB body window. Same shape on zocdoc.com @512, immowelt.de @505, trovaprezzi.it
//   @508, tripadvisor.com @509, yelp.com @510 (prod unknown_failure hosts), and on
//   leboncoin.fr, seloger.com, hermes.com, datadome.co.
const DATADOME_JS_TAG = "https://docs.datadome.co/docs/javascript-tag.md";
// The blocking-response doc documents `<div id="px-captcha">` in the block/challenge
// template. Live capture, 2026-09-17, same UA: https://www.fiverr.com/ → HTTP 403,
// `px-captcha` @7252; https://bloomberg.com/ → HTTP 403, `px-captcha` @9109.
// DORMANT TODAY: body matching reads only CHALLENGE_BODY_PREFIX_BYTES (4 KB), so neither
// measured capture fires this fingerprint. Raising the cap is deferred hardening; the
// entry ships so a shorter PerimeterX template is named now and the cap decision has a
// fingerprint to become live against.
// Deliberately NOT `_pxAppId`: the standard PX sensor snippet sets `window._pxAppId` on
// ordinary pages (humansecurity.com and zoominfo.com serve it at HTTP 200; fiverr's own
// 403 carries it @28140 because the block template ships the full site chrome), so it
// would mislabel any custom 403 on a PX-protected site. `px-captcha` has no such shape.
const PX_BLOCKING_RESPONSE =
  "https://docs.humansecurity.com/applications/advanced-blocking-response.md";

export const CHALLENGE_FINGERPRINTS: readonly ChallengeFingerprint[] = [
  {
    vendor: "cloudflare",
    kind: "header",
    header: "cf-mitigated",
    pattern: "challenge",
    sourceUrl: CF_DETECT_RESPONSE,
  },
  {
    vendor: "aws-waf",
    kind: "header",
    header: "x-amzn-waf-action",
    pattern: "challenge",
    sourceUrl: AWS_WAF_ACTIONS,
  },
  {
    vendor: "aws-waf",
    kind: "header",
    header: "x-amzn-waf-action",
    pattern: "captcha",
    sourceUrl: AWS_WAF_ACTIONS,
  },
  {
    vendor: "cloudflare",
    kind: "body",
    pattern: "/cdn-cgi/challenge-platform/h/",
    sourceUrl: CF_CHALLENGE_ORCHESTRATE,
  },
  {
    vendor: "cloudflare",
    kind: "body",
    pattern: "window._cf_chl_opt",
    sourceUrl: CF_CHALLENGE_TEMPLATE,
  },
  {
    vendor: "cloudflare",
    kind: "body",
    pattern: "challenges.cloudflare.com/turnstile/v0/api.js",
    sourceUrl: CF_TURNSTILE,
  },
  {
    vendor: "unknown",
    kind: "body",
    pattern: "js.hcaptcha.com/1/api.js",
    sourceUrl: HCAPTCHA,
  },
  {
    vendor: "unknown",
    kind: "body",
    pattern: "www.google.com/recaptcha/api.js",
    sourceUrl: RECAPTCHA,
  },
  {
    vendor: "datadome",
    kind: "body",
    pattern: "captcha-delivery.com",
    sourceUrl: DATADOME_JS_TAG,
  },
  {
    vendor: "perimeterx",
    kind: "body",
    pattern: "px-captcha",
    sourceUrl: PX_BLOCKING_RESPONSE,
  },
];
// No Akamai or Imperva entry ships. Live capture, 2026-09-17: 62 Akamai-fronted hosts
// produced zero challenges — the 16 prod Akamai hosts serve a static ~370-byte hard block
// (`<TITLE>Access Denied</TITLE>`, "You don't have permission to access", Reference #18.x,
// errors.edgesuite.net), no JS, no sensor, no captcha; `_abck`/`bm_sz`/`ak_bmsc`/`/akam/`
// appear zero times across all 50 prod captures. Imperva produced no 403 challenge at all;
// the only interstitial found is saudia.com at HTTP 200. Every remaining marker for
// both vendors is a presence signal observed on allowed 200s (bm_sz on delta.com,
// ak_bmsc on southwest.com, x-iinfo/visid_incap_* on imperva.com, and lowes.com serves
// `<title>Access Denied</title>` at 200), so a fingerprint written from them would flip
// allowed sites to blocked. See tests/challenge.test.ts for the pinned negative controls.

export const CF_TITLE_CORROBORATOR: ChallengeFingerprint = {
  vendor: "cloudflare",
  kind: "header",
  header: "cf-ray",
  pattern: "",
  sourceUrl: CF_HTTP_HEADERS,
};

const CF_TITLE = "<title>just a moment...";
const CF_MITIGATED = "cf-mitigated";
const CHALLENGE_STATUSES = new Set([403, 429, 503]);

const HEADER_FINGERPRINTS = CHALLENGE_FINGERPRINTS.filter((f) => f.kind === "header").map((f) => ({
  ...f,
  header: (f.header ?? "").toLowerCase(),
  needle: f.pattern.toLowerCase(),
}));

const BODY_FINGERPRINTS = CHALLENGE_FINGERPRINTS.filter((f) => f.kind === "body").map((f) => ({
  ...f,
  needle: f.pattern.toLowerCase(),
}));

export function detectChallenge(
  status: number,
  headers: Record<string, string>,
  bodyPrefix: string,
): { vendor: ChallengeVendor; signal: string } | null {
  const lowered: Record<string, string> = {};
  for (const key of Object.keys(headers ?? {})) {
    const value = headers[key];
    if (typeof value === "string") lowered[key.toLowerCase()] = value.toLowerCase();
  }

  for (const fp of HEADER_FINGERPRINTS) {
    const value = lowered[fp.header];
    if (value?.includes(fp.needle)) {
      return { vendor: fp.vendor, signal: `${fp.header}: ${fp.pattern}` };
    }
  }

  if (!CHALLENGE_STATUSES.has(status) && lowered[CF_MITIGATED] === undefined) return null;

  const body = (bodyPrefix ?? "").toLowerCase();
  for (const fp of BODY_FINGERPRINTS) {
    if (body.includes(fp.needle)) return { vendor: fp.vendor, signal: `body: ${fp.pattern}` };
  }

  if (body.includes(CF_TITLE) && lowered[CF_TITLE_CORROBORATOR.header ?? ""] !== undefined) {
    return { vendor: "cloudflare", signal: "title: Just a moment... (with cf-ray)" };
  }

  return null;
}
