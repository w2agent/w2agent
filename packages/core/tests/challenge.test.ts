import { describe, expect, it } from "vitest";
import {
  CF_TITLE_CORROBORATOR,
  CHALLENGE_FINGERPRINTS,
  detectChallenge,
} from "../src/audit/shared/challenge.js";

const CF_CHALLENGE_BODY = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="X-UA-Compatible" content="IE=Edge"><meta name="robots" content="noindex,nofollow">
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=8f2c1b9a" defer></script>
</head><body class="no-js"><div class="main-wrapper"><h1>example.com</h1>
<p>Verifying you are human. This may take a few seconds.</p></div></body></html>`;

const CF_CHL_OPT_BODY = `<!DOCTYPE html><html><head><title>Attention Required!</title></head>
<body><script>window._cf_chl_opt={cvId:"3",cType:"managed",cRay:"8f2c1b9a0d3e",cTplC:0};</script>
<div id="challenge-error-text">Enable JavaScript and cookies to continue</div></body></html>`;

const TURNSTILE_INTERSTITIAL_BODY = `<!DOCTYPE html><html><head><title>Security check</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head>
<body><div class="cf-turnstile" data-sitekey="0x4AAAAAAABkMY"></div></body></html>`;

const SIGNUP_PAGE_WITH_TURNSTILE = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Create your Acme account — Acme Analytics</title>
<meta name="description" content="Start a 14-day free trial of Acme Analytics. No credit card required.">
<link rel="canonical" href="https://acme.example/signup"><link rel="stylesheet" href="/assets/app.css">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head><body>
<header class="site-nav"><a class="logo" href="/">Acme Analytics</a>
<nav><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/login">Log in</a></nav></header>
<main><section class="signup"><h1>Create your account</h1>
<p>Already have an account? <a href="/login">Log in</a>.</p>
<form method="post" action="/api/signup">
<label for="email">Work email</label><input id="email" name="email" type="email" required>
<label for="password">Password</label><input id="password" name="password" type="password" required>
<label for="company">Company</label><input id="company" name="company" type="text">
<div class="cf-turnstile" data-sitekey="0x4AAAAAAABkMY" data-theme="light"></div>
<button type="submit" class="btn-primary">Start free trial</button>
</form>
<p class="legal">By signing up you agree to our <a href="/terms">Terms</a>.</p>
</section></main>
<footer><p>&copy; 2026 Acme Analytics, Inc.</p></footer></body></html>`;

const HCAPTCHA_BODY = `<!DOCTYPE html><html><head><title>Access denied</title>
<script src="https://js.hcaptcha.com/1/api.js" async defer></script></head>
<body><div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div></body></html>`;

const RECAPTCHA_BODY = `<!DOCTYPE html><html><head><title>Are you a robot?</title>
<script src="https://www.google.com/recaptcha/api.js" async defer></script></head>
<body><div class="g-recaptcha" data-sitekey="6Lc_aXkUAAAAA"></div></body></html>`;

const JSD_ON_NORMAL_PAGE = `<!DOCTYPE html><html><head><title>Acme Analytics — product tour</title>
<script src="/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload" async></script>
</head><body><h1>See what your customers do</h1><p>Dashboards in minutes.</p></body></html>`;

const PLAIN_403_BODY = `<!DOCTYPE html><html><head><title>403 Forbidden</title></head>
<body><h1>Forbidden</h1><p>You don't have permission to access this resource.</p>
<hr><address>Apache/2.4.62 (Debian) Server at example.com Port 443</address></body></html>`;

const MARKETING_BODY = `<!DOCTYPE html><html lang="en"><head><title>Acme Analytics — product analytics for teams</title>
<meta name="description" content="Understand your product in minutes."></head>
<body><h1>Product analytics for teams</h1><p>Trusted by 4,000 companies.</p>
<a class="cta" href="/signup">Start free</a></body></html>`;

describe("detectChallenge fingerprints", () => {
  it("every fingerprint cites an https source and a known kind", () => {
    for (const fp of [...CHALLENGE_FINGERPRINTS, CF_TITLE_CORROBORATOR]) {
      expect(fp.sourceUrl, fp.pattern).toMatch(/^https:\/\//);
      expect(["header", "body"], fp.pattern).toContain(fp.kind);
      if (fp.kind === "header") expect(fp.header, fp.pattern).toBeTruthy();
    }
  });

  it("matches the cf-mitigated header on any status, including 200", () => {
    expect(detectChallenge(200, { "cf-mitigated": "challenge" }, MARKETING_BODY)).toEqual({
      vendor: "cloudflare",
      signal: "cf-mitigated: challenge",
    });
    expect(detectChallenge(403, { "cf-mitigated": "challenge" }, "")).toEqual({
      vendor: "cloudflare",
      signal: "cf-mitigated: challenge",
    });
  });

  it("matches cf-mitigated regardless of header case", () => {
    expect(detectChallenge(503, { "CF-Mitigated": "Challenge" }, "")).toEqual({
      vendor: "cloudflare",
      signal: "cf-mitigated: challenge",
    });
  });

  it("matches the AWS WAF action header for challenge and captcha", () => {
    expect(detectChallenge(202, { "x-amzn-waf-action": "challenge" }, "")).toEqual({
      vendor: "aws-waf",
      signal: "x-amzn-waf-action: challenge",
    });
    expect(detectChallenge(405, { "x-amzn-waf-action": "captcha" }, "")).toEqual({
      vendor: "aws-waf",
      signal: "x-amzn-waf-action: captcha",
    });
  });

  it("matches the Cloudflare challenge-platform body marker on a blocked status", () => {
    expect(detectChallenge(403, { server: "cloudflare" }, CF_CHALLENGE_BODY)).toEqual({
      vendor: "cloudflare",
      signal: "body: /cdn-cgi/challenge-platform/",
    });
  });

  it("matches window._cf_chl_opt", () => {
    expect(detectChallenge(429, {}, CF_CHL_OPT_BODY)).toEqual({
      vendor: "cloudflare",
      signal: "body: window._cf_chl_opt",
    });
  });

  it("matches a Turnstile widget on a 403", () => {
    expect(detectChallenge(403, {}, TURNSTILE_INTERSTITIAL_BODY)).toEqual({
      vendor: "cloudflare",
      signal: "body: challenges.cloudflare.com/turnstile/v0/api.js",
    });
  });

  it("matches hCaptcha and reCAPTCHA as an unattributed vendor", () => {
    expect(detectChallenge(403, {}, HCAPTCHA_BODY)).toEqual({
      vendor: "unknown",
      signal: "body: js.hcaptcha.com/1/api.js",
    });
    expect(detectChallenge(503, {}, RECAPTCHA_BODY)).toEqual({
      vendor: "unknown",
      signal: "body: www.google.com/recaptcha/api.js",
    });
  });

  it("matches a body marker on a 200 that carries cf-mitigated", () => {
    expect(
      detectChallenge(200, { "cf-mitigated": "unknown-future-value" }, TURNSTILE_INTERSTITIAL_BODY),
    ).toEqual({
      vendor: "cloudflare",
      signal: "body: challenges.cloudflare.com/turnstile/v0/api.js",
    });
  });
});

describe("detectChallenge non-challenges", () => {
  it("does not flag a 200 signup page that embeds a Turnstile widget", () => {
    expect(detectChallenge(200, { "content-type": "text/html" }, SIGNUP_PAGE_WITH_TURNSTILE)).toBe(
      null,
    );
  });

  it("does not flag Cloudflare JavaScript Detections injected into a normal 200 page", () => {
    expect(
      detectChallenge(200, { server: "cloudflare", "cf-ray": "8f2c1b9a" }, JSD_ON_NORMAL_PAGE),
    ).toBe(null);
  });

  it("does not flag a 'Just a moment...' title on its own", () => {
    const titleOnly = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><p>Redirecting you to the new site.</p></body></html>`;
    expect(detectChallenge(403, {}, titleOnly)).toBe(null);
  });

  it("flags 'Just a moment...' when a Cloudflare marker corroborates it", () => {
    const titleOnly = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><p>Verifying you are human.</p></body></html>`;
    expect(detectChallenge(403, { "cf-ray": "8f2c1b9a0d3e-LHR" }, titleOnly)).toEqual({
      vendor: "cloudflare",
      signal: "title: Just a moment... (with cf-ray)",
    });
    expect(detectChallenge(403, { server: "cloudflare" }, CF_CHALLENGE_BODY)?.vendor).toBe(
      "cloudflare",
    );
  });

  it("does not flag an ordinary 403 error page with no markers", () => {
    expect(detectChallenge(403, { server: "Apache" }, PLAIN_403_BODY)).toBe(null);
  });

  it("does not flag an ordinary 200 marketing page", () => {
    expect(detectChallenge(200, { server: "nginx" }, MARKETING_BODY)).toBe(null);
  });

  it("tolerates an empty body prefix and empty headers", () => {
    expect(detectChallenge(403, {}, "")).toBe(null);
  });
});
