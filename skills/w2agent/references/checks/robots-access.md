---
id: robots-access
checks:
  - ai-agent-access
  - local-business-booking-accessible
  - astro-robots-txt
  - wp-robots-default-blocking
fixBy: owner
---

# Fix guide: robots.txt rules that block agents or booking pages

## Passes when

These checks read the site's existing `robots.txt`. They fail only because of rules in that file (or because the file's own response is broken).

- `ai-agent-access` checks whether the root URL `/` is allowed for each AI crawler token that robots.txt can name. Training crawlers (for example `GPTBot`, `ClaudeBot`, `Google-Extended`, `CCBot`) are listed in the details but not scored. Any user-initiated agent token blocked (for example `ChatGPT-User`, `Claude-User`, `Perplexity-User`) is `fail` (score 0). Otherwise any AI search token blocked (for example `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`) is `partial` (score 50). Neither blocked passes. `Google-Agent` has no robots token and is never counted. With no usable robots.txt (a 404 or other status below 500 except 429, or a 200 that is an HTML page) the check passes. A robots.txt that answers 5xx is `fail` (crawlers must assume a full disallow). A network error or repeated 429 is `error`, which means unmeasured, not a finding.
- `local-business-booking-accessible` (only runs on sites detected as local businesses) collects same-origin links whose path contains an exact `/book`, `/appointment`, `/reserve` or `/schedule` segment, and links or iframes to a known booking platform (OpenTable, Resy, Calendly, Acuity, Booksy, Vagaro, Mindbody). With none of these it is `skip`. With only external booking it passes. With same-origin booking paths it tests each against robots.txt for the `*` group: all allowed passes, some blocked is `partial` (score is the allowed share), all blocked is `fail`. No robots.txt passes.
- `astro-robots-txt` (runs only on sites detected as Astro) and `wp-robots-default-blocking` (only on WordPress) test the same rule from the adapter side: they find the user-initiated and AI-search tokens that robots.txt blocks for `/` (training tokens are not counted). `astro-robots-txt` is `fail` (0) when robots.txt is missing or empty, and `fail` when any such token is blocked, otherwise it passes. `wp-robots-default-blocking` passes with no blocked token and with no robots.txt, and otherwise is `fail` with a score of 100 minus 20 per blocked token (never below 0).

## Who fixes it

The owner does (`fixBy: owner`). A rule that blocks an AI agent or a booking page is a policy the owner wrote. Changing it decides who may read or index the business, and the audit cannot tell an accident from a choice.

You do not edit, replace or weaken `robots.txt` to make these checks pass, and `integrate` never overwrites it. `integrate` only prepares a copy: on Next.js it stages `.w2agent/robots.txt`, which adds `Allow` groups for agents that only a blanket `*` rule blocks and leaves any rule that names the agent alone. A `5xx` on `/robots.txt` is a hosting or route fault: report it with the status code.

## Fix (any framework)

For the final report, name:

1. Which check failed and the exact tokens or paths listed in its message and details.
2. The rule in the site's `robots.txt` that causes it (the `User-agent` group and the `Disallow` line).
3. What the change would be, as a suggestion for the owner: for blocked agents, an `Allow: /` group for each token the owner wants to admit; for blocked booking pages, removing the `Disallow` for those paths or moving them out of the blocked path.
4. The file `integrate` produced, when it staged one, so the owner can merge it.

Leave the file as it is. Report the check as an owner item.

When `astro-robots-txt` fails with "No robots.txt found", there is no rule to respect: the `robots` guide (`robots-txt-exists`) covers creating the file. Once it exists, this check passes unless the file blocks an agent token.

## Next.js (App Router)

Nothing to change in code. The rules live in `public/robots.txt`, `app/robots.ts` or `app/robots.txt`. `integrate --install` writes the generated rules to `.w2agent/robots.txt` only, never to a served path. Point the owner at that staged file and at the existing file they should merge it into.

## Pitfalls

- Do not delete a `Disallow` line, add `Allow: /` for an agent, or replace the file to raise the score. The owner may block these agents on purpose.
- Do not treat `error` (network failure, 429) as a block. Re-run the audit; report it as unmeasured when it stays.
- Do not advertise booking the site lacks. This check only reads links that already exist.
- Do not edit `robots.txt` on a framework where a plugin or hosting layer generates it. Report it.

## Verify

After the owner changes the file, run `audit <local url> --json`. Watch `ai-agent-access` and `local-business-booking-accessible`, and on Astro or WordPress `astro-robots-txt` or `wp-robots-default-blocking`: expected `pass`. Until then the final report keeps them as owner items with the tokens or paths from the audit details.
