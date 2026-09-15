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
const CF_JS_DETECTIONS =
  "https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/";
const CF_TURNSTILE =
  "https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/";
const CF_HTTP_HEADERS = "https://developers.cloudflare.com/fundamentals/reference/http-headers/";
const AWS_WAF_ACTIONS =
  "https://docs.aws.amazon.com/waf/latest/developerguide/waf-captcha-and-challenge-actions.html";
const HCAPTCHA = "https://docs.hcaptcha.com/";
const RECAPTCHA = "https://developers.google.com/recaptcha/docs/display";

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
    pattern: "/cdn-cgi/challenge-platform/",
    sourceUrl: CF_JS_DETECTIONS,
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
];

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
