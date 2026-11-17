# Agent Playbook: make a site agent-ready with w2agent

For a coding agent that a site owner asked to "use w2agent to make my site agent-ready". Follow the steps in order. The CLI contract (exit codes, JSON documents, error reasons) is in [CLI-AGENT-MODE.md](CLI-AGENT-MODE.md). This page does not repeat it.

Do not read the w2agent source code (`packages/core` and so on) to learn the CLI. Run `w2agent schema` instead. It prints every command, flag and value as JSON.

## 1. Pick a path

1. Is the site deployed at a public URL, and can you not run code (or does the owner prefer it)? Use the [hosted path](#hosted-path).
2. Otherwise you have the project on disk and can run code. Use the [local flow](#local-flow).
3. Detect the framework from the project: `nextjs`, `nuxt`, `astro`, `docusaurus`, `wordpress`, `shopify`. `integrate` detects it from the crawl. Pass `--platform <name>` only when it cannot (`no_platform_detected`). `w2agent schema` lists the accepted values.

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

## Local flow

1. Build the site and start its production server locally. Note the URL (for example `http://127.0.0.1:3000`).
2. Baseline: `w2agent audit <local url> --json`. Keep `overallScore` and `grade`.
3. Find the production origin for `--site-url` (see [Production origin](#production-origin)).
4. Plan: `w2agent integrate <local url> --dry-run --json --project-dir <site dir> --site-url <production origin>`. Always pass `--project-dir`. This writes nothing.
5. Print the plan for the user: `changes`, `warnings`, `postInstallSteps`. Then get [approval](#approval).
6. Apply: run the argv in `next[0]` (it is the same command with `--install`).
7. Do the `postInstallSteps` exactly as written. Then rebuild and restart the local server. A generated `postbuild` hook may try to refresh the content from the production URL with `npx`. That step is non-fatal. If it fails (the production site is not live yet, or npm cannot find the package), the build still succeeds and the site serves the files `integrate` already wrote. Do not edit the hook. Mention the failure in your report.
8. Verify: run the `next` argv from the installed document (`audit <local url> --json`). Compare with the baseline.
9. Close remaining gaps (see [Closing gaps](#closing-gaps)). Re-audit after each batch.
10. Report (see [Final report](#final-report)).

### Approval

- If you can pause and ask, show the plan and wait for a yes.
- If you cannot pause (a non-interactive run), the owner's request to make the site agent-ready counts as approval for the plan exactly as shown, with its `changes` and `postInstallSteps`. Still print the plan first. Anything outside the plan needs explicit approval. Put it in the final report instead of doing it.

### Production origin

`--site-url` makes generated files name the production site instead of the local server. After generation it rewrites the crawl origin and its host and loopback forms. Any crawl host still left is reported in `warnings`. Check those by hand before the owner publishes. Details: [CLI-AGENT-MODE.md](CLI-AGENT-MODE.md#--site-url-crawl-one-origin-write-for-another).

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
- Never rewrite, move or restructure existing user files (for example, do not move page copy into new modules). Edits to existing files are minimal and additive. If a `modify` in the plan would replace most of a file, stop and ask.
- Change `package.json` scripts or dependencies only as `postInstallSteps` say. Anything else needs approval.
- Stay inside the user's project and the w2agent checkout. Do not edit the w2agent repository itself.
- On a failure, branch on `error.reason`. If `userActionRequired` is true, stop and tell the owner. Do not retry it.

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

- `POST https://w2agent.dev/api/audit` with `{"url": "<url>"}` returns the same report as `audit --json`, plus `auditId`. Limit: 5 requests per minute per IP.
- A site that cannot be measured returns 422 `{"error": "audit_failed", "kind": "...", "message": "..."}`. The `kind` values match the `reason` values in [CLI-AGENT-MODE.md](CLI-AGENT-MODE.md#reasons).
- `POST https://w2agent.dev/api/generate` with `{"url": "<url>"}` returns generated files. It is rate limited too.

You write the fixes yourself from the report's fix hints. The same rules apply: additive edits, real content only, nothing advertised that the site lacks, and a final report.

Optional and separate: `agentize` runs a hosted agent server. It needs a login or API key. See [AGENTIZE.md](AGENTIZE.md).
