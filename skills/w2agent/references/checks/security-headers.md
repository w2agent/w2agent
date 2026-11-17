---
id: security-headers
checks:
  - security-headers
fixBy: agent
---

# Fix guide: security headers

## Passes when

`security-headers` reads the response headers of the first audited page (the home page) and counts four: `content-security-policy`, `x-frame-options`, `x-content-type-options`, `strict-transport-security`. Score = present / 4. At 3 of 4 (score 75) or more it passes. 1 or 2 present is `partial`. None is `fail`. It tests presence only, not values.

## Who fixes it

You do for three of the four (`fixBy: agent`): `X-Content-Type-Options`, `X-Frame-Options` and `Strict-Transport-Security`. `integrate` writes none of them on any framework. `Content-Security-Policy` is the owner's decision: a wrong policy breaks the site's scripts, styles and embeds. Do not add one. Three headers already pass the check at score 75.

Some hosts or CDNs add these headers in production. The audit on a local server does not see them. Set them in the project anyway, unless the owner says the host manages them.

## Fix (any framework)

Send these on every response:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN` (use `DENY` only if you know the site is never framed)
- `Strict-Transport-Security: max-age=63072000` (the site must be served over HTTPS; leave out `includeSubDomains` and `preload`, which commit the owner's other hosts)

Use the framework's or host's own header mechanism. Add to existing header rules. Never replace them.

## Next.js (App Router)

`integrate` covers nothing for this check on Next.js. Do not touch the files it generated.

1. Add `headers()` to `next.config.*`. If `headers()` exists, append your entry to the array it returns.

```ts
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Strict-Transport-Security", value: "max-age=63072000" },
        ],
      },
    ];
  },
};
```

2. Keep the generated `middleware.ts` (or `proxy.ts` on Next.js 16). `headers()` and the middleware do not conflict: the headers apply to every path, including the `/index.md` and `/llms.txt` responses the middleware rewrites to.
3. Next.js drops `Vary: Accept` from the HTML response of `/` with or without your change. Leave it. Deleting the middleware does not fix that; it breaks Accept negotiation.
4. If `next.config` sets `output: "export"`, Next.js ignores `headers()` and prints a warning. Set the headers in the host's config instead, and list it as an owner step in the final report.

## Pitfalls

- Do not delete or edit w2agent's generated middleware or proxy file. Do not put security headers in it: its matcher covers `/` only.
- Do not add a Content-Security-Policy to move the score to 100. Report it as an owner decision.
- Do not replace an existing `headers()` or other header config. Append.
- Do not add `includeSubDomains` or `preload` to HSTS.
- Do not set HSTS on a site that is not served over HTTPS.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `security-headers`: expected `pass`, score 75, details showing `content-security-policy` absent. That is the final state without an owner decision on CSP. Do not spend a second fix round on it. Run `curl -I <local url>` to confirm the three headers.
