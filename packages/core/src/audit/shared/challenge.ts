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
// (challenge) scripts and `js.datadome.co` as the source for the ordinary tag. Neither is
// usable as a fingerprint, and neither is the bare delivery domain: the same doc tells
// every DataDome customer to ship `script-src js.datadome.co ct.captcha-delivery.com` and
// `frame-src *.captcha-delivery.com` in their CSP, so `captcha-delivery.com` is a
// documented CSP value. A customer serving that policy as a
// `<meta http-equiv="Content-Security-Policy">` from a shared head template would have any
// 503 maintenance page labelled a DataDome challenge. The pattern is therefore
// `geo.captcha-delivery.com`, the host in the challenge page's own JS config
// (`'host':'geo.captcha-delivery.com'`), which matches neither documented directive.
// Residual risk, accepted: a customer who lists `geo.captcha-delivery.com` explicitly in a
// CSP would still false-positive — much less likely than the documented wildcard.
// The vendor name is never the pattern: https://www.vinted.com/ answers HTTP 200 carrying
// `set-cookie: datadome=` (capture 2026-09-16T17:08Z).
// Live capture, 2026-09-16T17:02Z, UA "w2agent/0.1 (+https://w2agent.dev)":
//   https://www.etsy.com/ → HTTP 403, 776-byte body, `'host':'geo.captcha-delivery.com'`
//   @506 — well inside the 4 KB body window. Same shape on zocdoc.com @508, immowelt.de
//   @501, trovaprezzi.it @504, tripadvisor.com @505, yelp.com @506 (prod unknown_failure
//   hosts, 17:02–17:03Z), and on datadome.co @501 (17:06Z), leboncoin.fr @501,
//   seloger.com @501, hermes.com @500 (17:08Z). All 10 measured; deepest offset 508.
const DATADOME_JS_TAG = "https://docs.datadome.co/docs/javascript-tag.md";
// The blocking-response doc documents `<div id="px-captcha"></div>` in the block/challenge
// template, and the pattern is the attribute form `id="px-captcha"`.
// Deliberately NOT the bare `px-captcha`: that also matches a CSS rule. On fiverr.com the
// *first* occurrence, @7252, is `#px-captcha>iframe{margin:0 auto;animation:
// px-challenge-appear .6s ease-in}` — styling, not the container. An inactive or
// partially-installed PX integration, or a 503 template that retains hidden #px-captcha
// styling, would otherwise be reported as a bot challenge.
// Live capture, 2026-09-16, same UA: https://www.fiverr.com/ → HTTP 403, `id="px-captcha"`
// @15899 (17:06Z); https://bloomberg.com/ → HTTP 403, `id="px-captcha"` @11171 (17:03Z).
// Both captures double-quote the attribute; a single-quoted or unquoted `id=px-captcha`
// would not match. Accepted: the documented form is the double-quoted one.
// DORMANT TODAY: body matching reads only CHALLENGE_BODY_PREFIX_BYTES (4 KB), so neither
// measured capture fires this fingerprint — and neither did under the bare pattern either,
// so the tightening costs zero real coverage. Raising the cap is deferred hardening; the
// entry ships so a shorter PerimeterX template is named now and the cap decision has a
// fingerprint to become live against.
// Deliberately NOT `_pxAppId` or any other sensor marker: the sensor ships on ordinary
// pages, so it would mislabel any custom 403 on a PX-protected site. Measured 17:06Z:
// fiverr's own 403 carries `window._pxAppId` @28140 and `client.perimeterx.net` @28182
// (plus a `collector-<appid>.perimeterx.net` beacon @16054)
// because the block template ships the full site chrome; the allowed 200s carry the sensor
// too — humansecurity.com and zoominfo.com both answer with a `set-cookie: _pxhd`, and
// humansecurity.com's body references perimeterx @6080. (`_pxAppId` itself is not in
// either 200's captured prefix, but both bodies are truncated at the 64 KB capture cap, so
// that is an absence of evidence, not evidence of absence.) `id="px-captcha"` has no such
// shape: it appears only where the block template renders the challenge container.
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
    pattern: "geo.captcha-delivery.com",
    sourceUrl: DATADOME_JS_TAG,
  },
  {
    vendor: "perimeterx",
    kind: "body",
    pattern: 'id="px-captcha"',
    sourceUrl: PX_BLOCKING_RESPONSE,
  },
];
// No Akamai or Imperva entry ships, and the two rejections have different reasons.
//
// Akamai — measured, and no challenge exists to cite. Live capture 2026-09-16T17:02–17:08Z:
// 26 Akamai-fronted hosts across the three capture files produced zero challenges. Counted
// as "the `server` header matches Akamai* or the response carries an `akamai-*` header"
// (24 hosts), plus mitre.org and aa.com, whose bodies cite errors.edgesuite.net with no
// Akamai header — recount on the header definition alone and the number is 24. (An earlier
// revision of this comment said 62; that was wrong.) 16 of the 26 are prod unknown_failure
// hosts. 12 of those 16 serve a static 360–384-byte hard block (`<TITLE>Access
// Denied</TITLE>`, "You don't have permission to access", Reference #18.x,
// errors.edgesuite.net), no JS, no sensor, no captcha. The other four are larger custom
// hard blocks, still with no challenge in them: hilton.com (64 KB, body truncated at the
// capture cap), macys.com (9899 B), adidas.com (3369 B), ebay.com (1831 B).
// `_abck`, `bm_sz`, `ak_bmsc`, `sensor_data` and `/akam/` appear zero times across all 50
// prod captures; they occur only on allowed 200s (bm_sz on delta.com, walgreens.com,
// bestbuy.com and staples.com; ak_bmsc and `/akam/` on southwest.com), which is exactly
// what makes them presence markers rather than challenge markers.
//
// Imperva — unreachable by construction, not merely unmeasured. Its only interstitial in
// evidence is saudia.com at HTTP 200 (`<title>Pardon Our Interruption</title>`, x-iinfo),
// and the body-fingerprint loop below is status-gated to 403/429/503 (or a cf-mitigated
// header), so no body fingerprint of any pattern could fire on it at any body cap. x-iinfo
// and visid_incap_* are presence signals on imperva.com's own 200 page, and lowes.com
// serves `<title>Access Denied</title>` at 200 behind Akamai, so a fingerprint written from
// any of these would flip allowed sites to blocked.
//
// Contrast with PerimeterX, which does ship dormant: its evidence is a 403, so the status
// gate already passes and only the 4 KB body cap holds it back — a shorter PX block
// template fires today, and raising the cap makes the captured ones fire. An Imperva entry
// would be unreachable by construction instead. D-4's citation rule is satisfied for
// neither an Akamai nor an Imperva 403 challenge: none exists in the captures.
// See tests/challenge.test.ts for the pinned negative controls.

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
