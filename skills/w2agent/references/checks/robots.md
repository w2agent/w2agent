---
id: robots
checks:
  - robots-txt-exists
fixBy: agent
---

# Fix guide: robots.txt exists

## Passes when

`robots-txt-exists` fetches `<origin>/robots.txt`. It passes (score 100) when the response is HTTP 200 with a non-empty body that is not an HTML document. A 200 response labelled `text/html` whose body is empty or starts with `<` (a catch-all page) does not count. Any other response (404, 5xx, redirect to a page, timeout) fails (score 0). There is no partial, and the check does not read the rules.

Whether the rules block AI agents is a different check, `ai-agent-access` (guide `robots-access`).

## Who fixes it

You do (`fixBy: agent`), and only when the site has no `robots.txt` at all. A file that already exists and passes needs no edit.

`integrate` never serves a `robots.txt`. On Next.js it stages the generated rules at `.w2agent/robots.txt` and lists a `manual` change in its plan that says where to put them. Acting on that `manual` change is yours. The staged file is not served until you copy it.

## Fix (any framework)

1. Confirm the site has no `robots.txt`: fetch `/robots.txt` on the running site and look in the project for a static file, a route or a plugin that should serve it. If one exists, do not replace it. Report why it is not served instead.
2. Serve a plain-text file at `/robots.txt` on the site root, `Content-Type: text/plain`.
3. When `integrate` staged a file, copy its content. For a site with no `robots.txt` it holds an allow-all group, a `Sitemap:` line only when the site serves a sitemap, and a comment with the `llms.txt` URL. Otherwise write the minimum:

```text
User-agent: *
Allow: /
```

4. Add `Sitemap: <production origin>/sitemap.xml` only when the site serves that sitemap (see the `sitemap` guide). Use the production origin, never a local one.

## Next.js (App Router)

1. Look first for `public/robots.txt`, `app/robots.ts`, `app/robots.txt` and the same names under `src/app/`. Next.js errors when a file under `public/` and a route use the same path. If any exists, stop.
2. Create `public/robots.txt` with the content from step 3 above (from `.w2agent/robots.txt` when it exists). A static file also works with `output: "export"`.
3. Alternatively, when the project already uses metadata routes (for example `app/sitemap.ts`), create `app/robots.ts`:

```ts
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://www.example.com/sitemap.xml",
  };
}
```

Replace the origin with the real one and drop `sitemap` when the site serves none. Add `export const dynamic = "force-static";` when `next.config` sets `output: "export"`.

## Pitfalls

- Never write `Disallow: /` or any rule that blocks pages or AI agents. A missing file means "allow all"; the new file must not change that.
- Never replace, shorten or reorder an existing `robots.txt`. This guide applies only when there is none.
- Do not leave the rules only in `.w2agent/robots.txt`. That file is not served.
- Do not create both `public/robots.txt` and `app/robots.ts`.
- Do not list a `Sitemap:` URL the site does not serve, and do not use a local origin.

## Verify

Build and serve the site, then run `audit <local url> --json`. Watch `robots-txt-exists`: expected `pass`, score 100. Also fetch `/robots.txt` and confirm it returns 200 as plain text with the rules. If it still fails, check that the response is not an HTML page and the body is not empty.
