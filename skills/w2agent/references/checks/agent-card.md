---
id: agent-card
checks:
  - well-known-agent-card
  - nextjs-well-known-served
fixBy: owner
---

# Fix guide: A2A agent card

## Passes when

Both checks read `/.well-known/agent-card.json`. The crawler keeps the file only when it answers 200 with a JSON content type and its body differs from what the site returns for an unknown `/.well-known/` path (a catch-all page does not count).

- `well-known-agent-card`: no file is `fail` (0). A file that is not an A2A card (missing or invalid fields) is `fail`. A complete A2A v1.0 card (`name`, `description`, `version`, `supportedInterfaces[]` each with an absolute `url`, `protocolBinding` and `protocolVersion`, `capabilities`, `defaultInputModes`, `defaultOutputModes`, and `skills[]` each with `id`, `name`, `description`, `tags`) passes (100). The card is `partial` (50) when an interface `url` is the site's own home page (a stub, not an A2A endpoint), or when it is the older v0.3 shape (top-level `url`).
- `nextjs-well-known-served` (runs only on sites detected as Next.js): passes (100) when `agent-card.json` is a JSON object with a non-empty `name`, otherwise `fail` (0). That is a weaker test than `well-known-agent-card`: a stub card can pass this check and still be `partial` on the other. Its message says Next.js "needs route handlers or public/ files"; that text suggests adding files, and for this check you must not do that unless the owner has a live A2A agent.

## Who fixes it

The owner does (`fixBy: owner`). An agent card tells other agents where to send A2A requests. It is only true when the site operates an A2A agent at a live endpoint. A site with no such agent should not publish a card, and these two checks stay `fail`. Only the owner knows whether an A2A agent exists and what its endpoint URL is.

`integrate` writes a card only when it is given `--a2a-endpoint <url>`. Without that flag it skips the card and prints that it did.

## Fix (any framework)

1. Ask the owner whether the site runs an A2A agent, and for the live endpoint URL. If the answer is no or unknown, do nothing: report both checks as "not applicable: the site operates no A2A agent" and leave them failing.
2. If the owner gives an endpoint, run `integrate` again with `--a2a-endpoint <url>` and follow its plan. Never hand-write `agent-card.json`, and never use the home page URL as the endpoint.
3. Report that the endpoint must be a live A2A service. `integrate` does not verify it.

## Next.js (App Router)

With `--a2a-endpoint`, the `integrate` plan adds `app/.well-known/agent-card.json/route.ts` (served as JSON) and `.w2agent/agent-card.json`, the card data that the route reads. Follow the plan. Do not hand-write either file: `integrate` covers this framework.

## Pitfalls

- Do not publish a card for a site without an A2A agent. It advertises a service the site lacks, and agents will send requests that fail.
- Do not point `supportedInterfaces[].url` at the home page. The check marks that as a stub (`partial`).
- Do not copy a card from another site or from the check's fix snippet and fill in guesses.
- Do not read a pass of `nextjs-well-known-served` as proof of a valid card. Read `well-known-agent-card` as well.

## Verify

Only when the owner supplied an endpoint: serve the site and run `audit <local url> --json`. Expected: `well-known-agent-card` `pass` and `nextjs-well-known-served` `pass`. Without an A2A agent the final state is `fail` for both: report them as owner items that do not apply.
