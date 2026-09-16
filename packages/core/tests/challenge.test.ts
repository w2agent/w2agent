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

// Modelled on the live capture of https://www.etsy.com/ (403, 776 bytes,
// 2026-09-16T17:02Z); the opaque cid/hsh/cookie values are redacted.
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
// client.perimeterx.net. Doc-shaped: humansecurity.com and zoominfo.com both answer HTTP
// 200 with a `set-cookie: _pxhd`, and fiverr's 403 carries `_pxAppId` @28140 (2026-09-16T17:06Z).
const PX_SENSOR_SNIPPET = `<script>window._pxAppId='PXAbC1dEf2';window._pxJsClientSrc='/PXAbC1dEf2/init.js';
(function(){var s=document.createElement('script');s.src='https://client.perimeterx.net/PXAbC1dEf2/main.min.js';
document.head.appendChild(s);})();</script>`;

// Live capture of https://www.homedepot.com/ (403, 371 bytes, 2026-09-16T17:02Z): a static
// hard block, no JS, no sensor, no captcha. 12 of the 50 prod unknown_failure hosts serve
// this shape, at 360–384 bytes.
const AKAMAI_HARD_BLOCK_BODY = `<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>

You don't have permission to access "http&#58;&#47;&#47;www&#46;homedepot&#46;com&#47;" on this server.<P>
Reference&#32;&#35;18&#46;56ce2d17&#46;1789578165&#46;50da5665
<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;56ce2d17&#46;1789578165&#46;50da5665</P>
</BODY>
</HTML>`;

// Live capture of https://www.saudia.com/ (2026-09-16T17:06Z) — an Imperva interstitial
// served at HTTP 200.
const IMPERVA_INTERSTITIAL_BODY = `<!DOCTYPE html><html><head><title>Pardon Our Interruption</title></head>
<body><h1>Pardon Our Interruption</h1>
<p>As you were browsing something about your browser made us think you were a bot.</p>
<script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"></script>
</body></html>`;

// Live capture of https://www.lowes.com/ (2026-09-16T17:06Z): an Akamai "Access Denied"
// page served at HTTP 200 with the site's mPulse/boomerang RUM snippet attached.
const LOWES_ACCESS_DENIED_200_BODY = `<HTML><HEAD>
<TITLE>Access Denied</TITLE>
<script>(window.BOOMR_mq=window.BOOMR_mq||[]).push(["addVar",{"rua.upush":"false","rua.trans":"SJ-6898d930-f704-42d2-8fd7-1bf03cf0093d"}]);</script>
<script>window.BOOMR_API_key="W8H5V-D6KN9-TTLED-Y3VKD-B2SQA";</script>
</HEAD><BODY></BODY></HTML>`;

// A 503 maintenance page from a shared head template that ships the DataDome-documented
// CSP verbatim. Every string the vendor doc tells customers to publish is here; none of it
// is a challenge. This is why the fingerprint is `geo.captcha-delivery.com` and not the
// bare delivery domain.
const CSP_ONLY_MAINTENANCE_BODY = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src js.datadome.co ct.captcha-delivery.com; frame-src *.captcha-delivery.com">
<title>Scheduled maintenance — Acme Store</title></head>
<body><h1>We'll be back shortly</h1><p>Scheduled maintenance until 03:00 UTC.</p></body></html>`;

// A 503 template that still carries the PerimeterX challenge *styling* but never renders
// the container — the shape that makes the bare `px-captcha` substring unsafe.
const PX_CSS_ONLY_MAINTENANCE_BODY = `<!DOCTYPE html><html lang="en"><head>
<title>Temporarily unavailable — Acme Marketplace</title>
<style>#px-captcha>iframe{margin:0 auto;animation:px-challenge-appear .6s ease-in}.px-loader-wrapper{display:none}</style>
</head><body><h1>Temporarily unavailable</h1><p>Please try again in a few minutes.</p></body></html>`;

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

  // Live capture 2026-09-16T17:02Z: www.etsy.com 403 carries the challenge JS config
  // `'host':'geo.captcha-delivery.com'` @506 — well inside the 4 KB body window.
  it("matches the DataDome geo.captcha-delivery host on a blocked status", () => {
    expect(detectChallenge(403, { "content-type": "text/html" }, DATADOME_CHALLENGE_BODY)).toEqual({
      vendor: "datadome",
      signal: "body: geo.captcha-delivery.com",
    });
  });

  it("reaches the DataDome marker at its real ~506-byte offset", () => {
    expect(DATADOME_CHALLENGE_BODY.indexOf("geo.captcha-delivery.com")).toBeGreaterThan(480);
    expect(DATADOME_CHALLENGE_BODY.indexOf("geo.captcha-delivery.com")).toBeLessThan(
      CHALLENGE_BODY_PREFIX_BYTES,
    );
    expect(
      detectChallenge(403, {}, DATADOME_CHALLENGE_BODY.slice(0, CHALLENGE_BODY_PREFIX_BYTES)),
    ).toEqual({ vendor: "datadome", signal: "body: geo.captcha-delivery.com" });
  });

  it("matches the PerimeterX px-captcha container on a blocked status", () => {
    expect(detectChallenge(403, { "content-type": "text/html" }, PX_CHALLENGE_BODY)).toEqual({
      vendor: "perimeterx",
      signal: 'body: id="px-captcha"',
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

  // The case that breaks if `captcha-delivery.com` (or `ct.captcha-delivery.com`) were the
  // pattern: the DataDome tag doc tells every customer to publish exactly those strings in
  // a CSP, so a shared-template 503 would be labelled a challenge.
  it("does not flag a 503 maintenance page carrying only the documented DataDome CSP", () => {
    expect(CSP_ONLY_MAINTENANCE_BODY).toContain("ct.captcha-delivery.com");
    expect(CSP_ONLY_MAINTENANCE_BODY).toContain("*.captcha-delivery.com");
    expect(CSP_ONLY_MAINTENANCE_BODY).not.toContain("geo.captcha-delivery.com");
    expect(detectChallenge(503, { "content-type": "text/html" }, CSP_ONLY_MAINTENANCE_BODY)).toBe(
      null,
    );
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

  // The case that breaks if the bare `px-captcha` substring were the pattern: on fiverr.com
  // its first occurrence (@7252) is a CSS rule, not the container. A 503 template that keeps
  // the challenge styling must not be reported as a bot challenge.
  it("does not flag a 503 template that retains only the px-captcha CSS rule", () => {
    expect(PX_CSS_ONLY_MAINTENANCE_BODY).toContain("px-captcha");
    expect(PX_CSS_ONLY_MAINTENANCE_BODY).not.toContain('id="px-captcha"');
    expect(
      detectChallenge(503, { "content-type": "text/html" }, PX_CSS_ONLY_MAINTENANCE_BODY),
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
});

// These two pages ARE interstitials — they are not ordinary content, and calling them
// "non-challenges" would assert a property they do not have. They return null for one
// reason only: the body-fingerprint loop is status-gated to 403/429/503 (or a cf-mitigated
// header) and both are served at HTTP 200, so no body fingerprint of any pattern, at any
// body cap, could fire on them. They are pinned here so that a future fingerprint written
// from either page's markers is recognised as unreachable rather than as coverage.
describe("known interstitials today's gates cannot reach", () => {
  // Live capture 2026-09-16T17:06Z: https://www.saudia.com/ serves the Imperva "Pardon Our
  // Interruption" interstitial at HTTP 200 (x-iinfo, _Incapsula_Resource). No Imperva
  // fingerprint ships, and one could not fire here even if it did; x-iinfo and
  // visid_incap_* are also present on imperva.com's own 200 marketing page.
  it("cannot reach the Imperva 'Pardon Our Interruption' interstitial because it is a 200", () => {
    expect(IMPERVA_INTERSTITIAL_BODY).toContain("Pardon Our Interruption");
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

  // Live capture 2026-09-16T17:06Z: https://www.lowes.com/ serves an Akamai "Access Denied"
  // page at HTTP 200. Same reason: the status gate never opens, so the body is never read.
  it("cannot reach the lowes.com Akamai 'Access Denied' page because it is a 200", () => {
    expect(LOWES_ACCESS_DENIED_200_BODY).toContain("<TITLE>Access Denied</TITLE>");
    expect(
      detectChallenge(
        200,
        {
          "akamai-grn": "0.15b41160.1789578377.8d69c19d",
          "x-akamai-transformed": "9 367 0 pmb=mRUM,2",
          "content-type": "text/html",
        },
        LOWES_ACCESS_DENIED_200_BODY,
      ),
    ).toBe(null);
  });

  // The gate itself, stated as an assertion: the same two bodies at a gated status still
  // return null (no fingerprint matches them), so the 200s above are held back by the
  // status gate and nothing else.
  it("holds both back on the status gate, not on their content", () => {
    expect(detectChallenge(403, {}, IMPERVA_INTERSTITIAL_BODY)).toBe(null);
    expect(detectChallenge(403, {}, LOWES_ACCESS_DENIED_200_BODY)).toBe(null);
    // A body that DOES carry a fingerprint is the control for the gate being real.
    expect(detectChallenge(200, {}, DATADOME_CHALLENGE_BODY)).toBe(null);
    expect(detectChallenge(403, {}, DATADOME_CHALLENGE_BODY)).toEqual({
      vendor: "datadome",
      signal: "body: geo.captcha-delivery.com",
    });
  });
});

// §7 (deferred hardening): body matching reads only CHALLENGE_BODY_PREFIX_BYTES (4 KB).
describe("detectChallenge body-window limits (measured)", () => {
  it('cannot reach id="px-captcha" at bloomberg.com\'s measured 11171-byte offset within the 4 KB window', () => {
    const filler = `<div class="tile"><span>Browse categories</span></div>\n`.repeat(210);
    const body = `<!DOCTYPE html><html><head><title>Access to this page has been denied</title></head>
<body>${filler}<div id="px-captcha"></div></body></html>`;
    const offset = body.indexOf('id="px-captcha"');
    expect(offset).toBeGreaterThanOrEqual(11171);
    expect(detectChallenge(403, {}, body)).toEqual({
      vendor: "perimeterx",
      signal: 'body: id="px-captcha"',
    });
    expect(detectChallenge(403, {}, body.slice(0, CHALLENGE_BODY_PREFIX_BYTES))).toBe(null);
  });
});
