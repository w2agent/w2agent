import { describe, expect, it } from "vitest";
import { CHALLENGE_BODY_PREFIX_BYTES } from "../src/audit/errors.js";
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

// Modelled on the live capture of https://www.etsy.com/ (403, 776 bytes, 2026-09-17);
// the opaque cid/hsh/cookie values are redacted.
const DATADOME_CHALLENGE_BODY = `<html lang="en"><head><title>etsy.com</title><style>#cmsg{animation: A 1.5s;}@keyframes A{0%{opacity:0;}99%{opacity:0;}100%{opacity:1;}}</style></head><body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p><script data-cfasync="false">var dd={'rt':'c','cid':'REDACTEDREDACTEDREDACTEDREDAC==','hsh':'D013AA612AB2224D03B2318D0F5B19','t':'fe','rr':'','qp':'','s':45225,'e':'${"e".repeat(96)}','host':'geo.captcha-delivery.com','cookie':'${"c".repeat(128)}'}</script><script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>`;

// The ordinary DataDome tag, which vendor docs source from js.datadome.co — not a challenge.
const DATADOME_TAG_ON_NORMAL_PAGE = `<!DOCTYPE html><html lang="en"><head><title>Vintage denim jacket — Marketplace</title>
<script src="https://js.datadome.co/tags.js" async></script></head>
<body><h1>Vintage denim jacket</h1><p>Size M · €38 · Ships from France</p></body></html>`;

const PX_CHALLENGE_BODY = `<!DOCTYPE html><html lang="en"><head><title>Access to this page has been denied</title>
<script src="https://captcha.px-cdn.net/PXAbC1dEf2/captcha.js?a=c&m=0"></script></head>
<body><div id="px-captcha"></div><p>Please verify you are a human.</p>
<p>Reference ID #f0a3c2d1-9b44-11f1-8e2a-0242ac120002</p></body></html>`;

// The PX *sensor* snippet as it ships on ordinary pages: it sets window._pxAppId and loads
// client.perimeterx.net. Observed at HTTP 200 on humansecurity.com and zoominfo.com.
const PX_SENSOR_SNIPPET = `<script>window._pxAppId='PXAbC1dEf2';window._pxJsClientSrc='/PXAbC1dEf2/init.js';
(function(){var s=document.createElement('script');s.src='https://client.perimeterx.net/PXAbC1dEf2/main.min.js';
document.head.appendChild(s);})();</script>`;

// Live capture of https://www.homedepot.com/ (403, 371 bytes, 2026-09-17): a static hard
// block, no JS, no sensor, no captcha. 16 of the 50 prod unknown_failure hosts serve this.
const AKAMAI_HARD_BLOCK_BODY = `<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>

You don't have permission to access "http&#58;&#47;&#47;www&#46;homedepot&#46;com&#47;" on this server.<P>
Reference&#32;&#35;18&#46;56ce2d17&#46;1789578165&#46;50da5665
<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;56ce2d17&#46;1789578165&#46;50da5665</P>
</BODY>
</HTML>`;

// Live capture of https://www.saudia.com/ — an Imperva interstitial served at HTTP 200.
const IMPERVA_INTERSTITIAL_BODY = `<!DOCTYPE html><html><head><title>Pardon Our Interruption</title></head>
<body><h1>Pardon Our Interruption</h1>
<p>As you were browsing something about your browser made us think you were a bot.</p>
<script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"></script>
</body></html>`;

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
      signal: "body: /cdn-cgi/challenge-platform/h/",
    });
  });

  // Live capture 2026-09-15: www.udemy.com 403 serves this orchestrate path,
  // www.g2.com 403 serves only scripts/jsd/main.js. Only the former is a challenge.
  it("matches the live challenge orchestrator path", () => {
    const body = `<script>a.src = '/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=a3b6'</script>`;
    expect(detectChallenge(403, { server: "cloudflare" }, body)).toEqual({
      vendor: "cloudflare",
      signal: "body: /cdn-cgi/challenge-platform/h/",
    });
  });

  it("does not treat JavaScript Detections instrumentation on a transient 503 as a challenge", () => {
    const body = JSD_ON_NORMAL_PAGE.replace(
      "<h1>See what your customers do</h1>",
      "<h1>Service Unavailable</h1>",
    );
    expect(detectChallenge(503, { server: "cloudflare" }, body)).toBeNull();
    expect(detectChallenge(403, { server: "cloudflare" }, body)).toBeNull();
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

  // Live capture 2026-09-17: www.etsy.com 403 carries `geo.captcha-delivery.com` @510 and
  // `ct.captcha-delivery.com/c.js` @726 — both inside the 4 KB body window.
  it("matches the DataDome captcha-delivery marker on a blocked status", () => {
    expect(detectChallenge(403, { "content-type": "text/html" }, DATADOME_CHALLENGE_BODY)).toEqual({
      vendor: "datadome",
      signal: "body: captcha-delivery.com",
    });
  });

  it("reaches the DataDome marker at its real ~510-byte offset", () => {
    expect(DATADOME_CHALLENGE_BODY.indexOf("geo.captcha-delivery.com")).toBeGreaterThan(480);
    expect(DATADOME_CHALLENGE_BODY.indexOf("geo.captcha-delivery.com")).toBeLessThan(
      CHALLENGE_BODY_PREFIX_BYTES,
    );
    expect(
      detectChallenge(403, {}, DATADOME_CHALLENGE_BODY.slice(0, CHALLENGE_BODY_PREFIX_BYTES)),
    ).toEqual({ vendor: "datadome", signal: "body: captcha-delivery.com" });
  });

  it("matches the PerimeterX px-captcha block template on a blocked status", () => {
    expect(detectChallenge(403, { "content-type": "text/html" }, PX_CHALLENGE_BODY)).toEqual({
      vendor: "perimeterx",
      signal: "body: px-captcha",
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

  // The g2.com analog for DataDome: an ordinary WAF block on a DataDome-protected site
  // carries the ordinary tag, not the challenge response page.
  it("does not flag a 403 that carries only the ordinary DataDome tag", () => {
    expect(detectChallenge(403, { server: "nginx" }, DATADOME_TAG_ON_NORMAL_PAGE)).toBe(null);
  });

  // https://www.vinted.com/ answers HTTP 200 with `set-cookie: datadome=`; the vendor name
  // is a presence marker and must never be the pattern.
  it("does not flag a 200 page carrying the DataDome tag and cookie", () => {
    expect(
      detectChallenge(
        200,
        { "content-type": "text/html", "set-cookie": "datadome=; Max-Age=-1; Path=/" },
        DATADOME_TAG_ON_NORMAL_PAGE,
      ),
    ).toBe(null);
  });

  // Body fingerprints are status-gated: the DataDome challenge page itself must not match
  // at 200 without a cf-mitigated header.
  it("does not flag the DataDome challenge body on a 200", () => {
    expect(detectChallenge(200, { "set-cookie": "datadome=abc" }, DATADOME_CHALLENGE_BODY)).toBe(
      null,
    );
  });

  // The case that breaks if `_pxAppId` (or any sensor marker) were the pattern: a custom
  // 403 on a PX-protected site ships the full site chrome, sensor included.
  it("does not flag a 403 carrying only the PerimeterX sensor snippet", () => {
    const body = `<!DOCTYPE html><html><head><title>Page not available</title>${PX_SENSOR_SNIPPET}
</head><body><h1>Sorry, that page is unavailable.</h1></body></html>`;
    expect(body).toContain("window._pxAppId");
    expect(body).toContain("client.perimeterx.net");
    expect(body).not.toContain("px-captcha");
    expect(
      detectChallenge(403, { "set-cookie": "_pxhd=S5YsZvwZ/oNi0Cm4iKknDms3; path=/" }, body),
    ).toBe(null);
  });

  // No Akamai fingerprint ships; these pin that we did not accidentally add a presence rule.
  // Cookie values are from the live 200 captures (delta.com bm_sz, southwest.com ak_bmsc) —
  // the homedepot.com 403 itself carried neither.
  it("does not flag the Akamai hard block, which is not a challenge", () => {
    expect(
      detectChallenge(
        403,
        {
          server: "AkamaiGHost",
          "akamai-grn": "0.56ce2d17.1789578165.50da5665",
          "set-cookie": "bm_sz=B44C866D6930BC0FD6A6788FB2663FE8~YAAQ; ak_bmsc=A9F3666DA1DA~000",
        },
        AKAMAI_HARD_BLOCK_BODY,
      ),
    ).toBe(null);
  });

  it("does not flag a 200 carrying Akamai Bot Manager presence markers", () => {
    const body = `<!DOCTYPE html><html><head><title>Book a flight</title>
<script src="/akam/13/1a2b3c4d" defer></script></head><body><h1>Where to?</h1></body></html>`;
    expect(
      detectChallenge(
        200,
        {
          "set-cookie": "ak_bmsc=A9F3666DA1DA~000; bm_sz=B44C866D6930BC0FD6A6788FB2663FE8~YAAQ",
          "akamai-grn": "0.15b41160.1789578377.8d69c19d",
        },
        body,
      ),
    ).toBe(null);
  });

  // No Imperva fingerprint ships either. saudia.com serves this interstitial at HTTP 200,
  // and x-iinfo / visid_incap_* appear on imperva.com's own 200 marketing page.
  it("does not flag the Imperva 'Pardon Our Interruption' interstitial served at 200", () => {
    expect(
      detectChallenge(
        200,
        {
          "x-iinfo": "31-2442306-2442307 2NNN RT(1789578389783 97)",
          "set-cookie": "visid_incap_2439=qlanutcoTlCs; incap_ses_7748_2439=NwvANwCX9wwNhz19",
        },
        IMPERVA_INTERSTITIAL_BODY,
      ),
    ).toBe(null);
  });
});

// §7 (deferred hardening): body matching reads only CHALLENGE_BODY_PREFIX_BYTES (4 KB).
describe("detectChallenge body-window limits (measured)", () => {
  it("cannot reach px-captcha at fiverr.com's measured 7252-byte offset within the 4 KB window", () => {
    const filler = `<div class="tile"><span>Browse categories</span></div>\n`.repeat(140);
    const body = `<!DOCTYPE html><html><head><title>Access to this page has been denied</title></head>
<body>${filler}<div id="px-captcha"></div></body></html>`;
    const offset = body.indexOf("px-captcha");
    expect(offset).toBeGreaterThanOrEqual(7252);
    expect(detectChallenge(403, {}, body)).toEqual({
      vendor: "perimeterx",
      signal: "body: px-captcha",
    });
    expect(detectChallenge(403, {}, body.slice(0, CHALLENGE_BODY_PREFIX_BYTES))).toBe(null);
  });
});
