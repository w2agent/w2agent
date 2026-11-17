---
name: w2agent
description: Make a website agent-ready with the w2agent CLI. Audits AI readiness (score and grade), then adds llms.txt, llms-full.txt, markdown routes and related files to Next.js, Nuxt, Astro, Docusaurus, WordPress or Shopify projects. Use when the user says "make my site agent-ready", "use w2agent", "AI readiness audit", "add llms.txt", "make my site visible to AI agents", or asks how agent-ready a site is.
---

# w2agent: make a site agent-ready

Use this when a site owner asks you to make their site agent-ready. Follow the steps in order.

Do not read the w2agent source code to learn the CLI. Run `w2agent schema` instead. It prints every command, flag and value as JSON.

## 1. Pick a path

1. Site deployed at a public URL, and you cannot run code (or the owner prefers it): use the [hosted path](#hosted-path).
2. Otherwise you have the project on disk and can run code: use the [local flow](#local-flow).
3. Detect the framework from the project: `nextjs`, `nuxt`, `astro`, `docusaurus`, `wordpress`, `shopify`. `integrate` detects it from the crawl. Pass `--platform <name>` only when it cannot (`no_platform_detected`, see the failure rule under Rules). `w2agent schema` lists the accepted values.

## 2. Run the CLI

Pinned version: `w2agent@0.1.0`. The runner is:

```bash
npx -y w2agent@0.1.0 <command>
```

If npm answers 404 for `w2agent@0.1.0`:

- If a w2agent checkout exists locally (the owner may have cloned it next to the site, not in your cwd), build the CLI from source and run `node <checkout>/packages/cli/dist/index.js <command>`. Narrowest build that works (needs Node 18+ and pnpm):
  ```bash
  cd <checkout> && pnpm install && pnpm --filter w2agent... build
  ```
  The full `pnpm install && pnpm build` also works but builds more packages.
- Otherwise stop and tell the owner. Never guess another package name (no `w2agent-cli`, no scoped names). Never install a package with a different name.

Examples below write `w2agent`. Substitute your runner for it. `next` arrays in JSON output start with `"w2agent"`: replace that first element with your runner.

## CLI contract (minimum)

Add `--json` to `audit`, `integrate` and `login`. Stdout is then one JSON document. Progress goes to stderr.

- Exit code `0`: success. `1`: operational error (the site, the project or the login blocked it). `2`: usage error (bad URL, flag or value).
- On failure stdout holds `{"ok": false, "error": {"reason", "message", "userActionRequired", "retryable", "next"}}`. Branch on `error.reason`, not on `message`.
- `userActionRequired: true` means a person must act (allow-list the crawler, log in, choose a platform). Stop and tell the owner. Do not retry it. The one exception is `no_platform_detected` (see Rules).
- `retryable: true` means the same command may work later (`unreachable`, `rate_limited`, `timeout`).
- `error.next` and the success `next` are lists of argv arrays. Each starts with `"w2agent"`. Run one by substituting your runner for that first element. Never put a real secret in one: a `<api-key>` placeholder must be replaced by the owner's key.
- Common reasons: `unreachable`, `blocked`, `auth_gated`, `rate_limited`, `timeout`, `invalid_url`, `invalid_argument`, `no_platform_detected`, `not_a_project`, `below_threshold`.
- `audit <url> --json` has no `ok` field. It prints the report (`overallScore`, `grade`, `categories` with `checks`). Success is exit code 0.
- `integrate --json` success has `ok: true`, `outcome` (`planned` for `--dry-run`, `installed` for `--install`), `changes` (each `{action, path, reason}`, `path` relative to `--project-dir`; actions `create`, `modify`, `skip`, `manual`, `delete`), `warnings`, `postInstallSteps` and `next`. For `skip` and `manual`, read `reason` and act by hand.

Full contract: https://github.com/interskh/w2agent/blob/main/docs/CLI-AGENT-MODE.md

## Local flow

1. Build the site and start its production server locally. Note the URL (for example `http://127.0.0.1:3000`).
2. Baseline: `w2agent audit <local url> --json`. Keep `overallScore` and `grade`.
3. Find the production origin for `--site-url` (see [Production origin](#production-origin)).
4. Plan: `w2agent integrate <local url> --dry-run --json --project-dir <site dir> --site-url <production origin>`. Always pass `--project-dir`. This writes nothing.
5. Print the plan for the user: `changes`, `warnings`, `postInstallSteps`. Then get [approval](#approval).
6. Apply: run the argv in `next[0]` (it is the same command with `--install`).
7. Before you add the `postbuild` step, read the generated build script (for Next.js, `w2agent-build.mjs`). It runs `w2agent` through npx. Run `npm view w2agent@0.1.0 version`.
   - If it succeeds: edit that generated script (a file w2agent just created, not a user file) so the call is pinned, for example `["-y", "w2agent@0.1.0", "generate", ...]`. Then do the `postInstallSteps`, rebuild and restart the local server.
   - If npm answers 404: do not add the `postbuild` step. The files `integrate` wrote already serve. Report it as a skipped postInstallStep and say why.
   - Never point a committed hook at a local checkout path. This applies to every platform: a generated call to `w2agent` through npx is pinned or not wired in.
8. Verify: run the `next` argv from the installed document (`audit <local url> --json`). Compare with the baseline.
9. Close remaining gaps (see [Closing gaps](#closing-gaps)). Re-audit after each batch.
10. Report (see [Final report](#final-report)).

### Approval

- If you can pause and ask, show the plan and wait for a yes.
- If you cannot pause (a non-interactive run), the owner's request to make the site agent-ready counts as approval for the plan exactly as shown, with its `changes` and `postInstallSteps`. Still print the plan first. Anything outside the plan needs explicit approval. Put it in the final report instead of doing it.
- Exception: a `modify` replaces the whole file. If any `modify` targets a file that a previous w2agent run did not create, the request is not approval. Ask the owner before you apply. In a non-interactive run, do not apply: stop after the dry run and report those paths.

### Production origin

`--site-url` makes generated files name the production site instead of the local server. After generation it rewrites the crawl origin and its host and loopback forms. Any crawl host still left is reported in `warnings`. Check those by hand before the owner publishes. Details: https://github.com/interskh/w2agent/blob/main/docs/CLI-AGENT-MODE.md

Find the origin in the project first. Places to look:

- Next.js `metadataBase`
- a `Sitemap:` line in `robots.txt`
- `site` in `astro.config.*`
- `url` in `docusaurus.config.*`
- Nuxt `site.url` or `siteUrl`
- a `CNAME` file
- `homepage` in `package.json`
- the README

Use what you find and say where it came from. If you find none, ask the owner. If you cannot ask, stop after the dry run and report that the production origin is needed. Never invent one.

### Rules

- Do not hand-write what `integrate` generates: `llms.txt`, markdown routes, middleware, and the robots or sitemap rules it emits. Run it.
- Never rewrite, move or restructure existing user files (for example, do not move page copy into new modules). Edits you make by hand are minimal and additive. A `modify` in the plan replaces the whole file (the plan shows no diff). If a `modify` targets a file that a previous w2agent run did not create, follow the [approval](#approval) exception.
- Change `package.json` scripts or dependencies only as `postInstallSteps` say. Anything else needs approval.
- Stay inside the user's project and the w2agent checkout. Do not edit the w2agent repository itself.
- On a failure, branch on `error.reason`. If `userActionRequired` is true, stop and tell the owner. Do not retry it. One exception: on `no_platform_detected`, if the project files show the framework (for example `next` in `package.json` dependencies means `nextjs`), retry once with `--platform <name>`, using a value that `w2agent schema` lists for `--platform`. If they do not show it, stop and ask.

### Closing gaps

After the re-audit, read the failing checks and their `fixSnippet` in the audit JSON. Apply only fixes that are true for this site, using its real content: sitemap, JSON-LD with the site's real business data, canonical URLs, security headers. Never fabricate content.

What not to advertise:

- No agent card without a live A2A endpoint (`--a2a-endpoint`).
- No MCP declaration without a running MCP server.
- No OAuth, OpenAPI or auth metadata the site does not have.

For a typical brochure site, `integrate` cannot move Agent Protocols, Auth & Access, or much of Content Quality. A low score there is expected. Do not fake it.

### Final report

Give the owner:

- before and after score and grade;
- files created and modified;
- `warnings` (especially leftover crawl hosts);
- what you did not do and why;
- anything that needs the owner (production origin, approvals, content only they can write).

## Hosted path

For a deployed public site when you will not run code. Before the first call, tell the owner that the URL is sent to w2agent.dev and that w2agent.dev fetches the site. Only public URLs work: localhost and private hosts are rejected.

- `POST https://w2agent.dev/api/audit` with `{"url": "<url>"}` returns the same report as `audit --json`, plus `auditId` and possibly a `summary` text. `/api/audit` and `/api/generate` share one limit: 5 requests per minute per IP.
- An invalid, private or loopback URL returns HTTP 400 `{"error": "<reason>"}`.
- A site that cannot be measured returns 422 `{"error": "audit_failed", "kind": "...", "message": "..."}`. The `kind` values match the `reason` values above.
- `POST https://w2agent.dev/api/generate` with `{"url": "<url>"}` returns generated files. It counts against the same limit.

You write the fixes yourself from the report's fix hints. The same rules apply: additive edits, real content only, nothing advertised that the site lacks, and a final report.

Optional and separate: `agentize` runs a hosted agent server. It needs a login or API key. See https://github.com/interskh/w2agent/blob/main/docs/AGENTIZE.md

## More docs

- Playbook: https://github.com/interskh/w2agent/blob/main/docs/AGENT-PLAYBOOK.md
- CLI contract: https://github.com/interskh/w2agent/blob/main/docs/CLI-AGENT-MODE.md
- Install details: https://github.com/interskh/w2agent/blob/main/docs/INTEGRATE-INSTALL.md
