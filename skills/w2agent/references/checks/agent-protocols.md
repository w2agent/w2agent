---
id: agent-protocols
checks:
  - mcp-discovery
  - mcp-server-card
  - agent-skills-index
  - api-endpoints
  - well-known-ucp
  - action-schemas
  - webmcp-declarative
  - webmcp-imperative
fixBy: owner
---

# Fix guide: agent protocols the site must really offer

## Passes when

Each check looks for evidence that the site offers a protocol to agents.

- `mcp-discovery`: probes homepage links that look like an MCP endpoint, then `<origin>/mcp`, and on a real domain (not an IP or `localhost`) `mcp.<domain>/mcp` and `mcp.<domain>/`. No endpoint found is `fail` (0). An endpoint on the deprecated HTTP+SSE transport is `partial` (50). An endpoint that answers 401 (auth required) is `pass` with score 75. A working endpoint is `pass` (100).
- `mcp-server-card` (weight 0): looks at `<MCP endpoint>/server-card`, `ai-catalog.json` entries of type `application/mcp-server-card+json`, then `/.well-known/mcp/server-card.json`. A card with non-empty `name`, `version` and `description` passes. A card that lacks one is `fail`. No card is `skip`.
- `agent-skills-index` (weight 0): reads `/.well-known/agent-skills/index.json`. Missing is `skip`. Invalid is `fail`: not JSON, over 256 KB, a `$schema` other than `https://schemas.agentskills.io/discovery/0.2.0/schema.json`, no `skills` array or an empty one, or a skill entry that lacks a `name` (lowercase words with single hyphens, at most 64 characters), a `type` of `skill-md` or `archive`, a non-blank `description` (at most 1024 characters), a `url` that resolves to an http(s) URL other than the index itself, or a `digest` of the form `sha256:` plus 64 lowercase hex characters. A valid index without `$schema` is `partial` (50). A valid index with it passes.
- `api-endpoints`: passes (100) when an audited page has a link whose `href` contains `openapi`, `swagger`, `api-docs` or `graphql`, or whose text matches "REST API", "GraphQL API", "API reference", "API docs", "API documentation" or "API explorer", or has a `<link rel="api">`. Otherwise `fail` (0).
- `well-known-ucp`: on a site detected as e-commerce, `/.well-known/ucp` must be JSON with a top-level `ucp` object holding a `version` in `YYYY-MM-DD` form, and non-empty `services` and `payment_handlers` objects whose values are arrays. Otherwise it is `fail`. On a site not detected as e-commerce the audit sets a non-passing result to `skip` ("Not applicable"). A valid profile there still passes.
- `action-schemas`: passes when an audited page has a JSON-LD block whose top level has a `potentialAction`, or whose `@type` is exactly `SearchAction` or `OrderAction`. A block that is a JSON array, or an `@graph` wrapper, is not searched. One page passes (score 33 per page, capped at 100). None is `fail`.
- `webmcp-declarative` (weight 0): passes when an audited page has a `<form toolname="...">`. Otherwise `skip`.
- `webmcp-imperative` (weight 0): passes when inline page code or one of the first five same-site scripts (each 256 KB or less) calls `document.modelContext` or `navigator.modelContext` (or `registerTool` on it), or a page carries an origin-trial token whose feature name contains "webmcp" or "modelcontext". Otherwise `skip`.

## Who fixes it

The owner does (`fixBy: owner`). Every one of these says "the site offers X". It is only true when the site has a real MCP server, a real API, a real checkout, a real search, a real skill. Only the owner knows that, and you cannot create the service by writing its description.

`skip` results (`mcp-server-card`, `agent-skills-index`, `well-known-ucp` off a store, `webmcp-declarative`, `webmcp-imperative`) are not failures. They mean "not measured" or "not applicable". They never authorize an edit. The two WebMCP checks have weight 0 and only ever pass or skip. The two discovery files (`mcp-server-card`, `agent-skills-index`) also have weight 0, but a file that exists and is invalid is `fail` (and `agent-skills-index` without `$schema` is `partial`), as the bullets above say.

A brochure site with no API, no MCP server, no store and no search form has nothing to fix here. Report each non-passing check as "not applicable: the site does not offer this".

## Fix (any framework)

Do not edit anything for these checks. For the final report, per check:

1. Give the status and message from the audit.
2. Say what the site would have to offer: an MCP endpoint (`mcp-discovery`); public API documentation or an OpenAPI file linked from a page (`api-endpoints`); a real search or order action described in the page's JSON-LD (`action-schemas`); a commerce profile for a store (`well-known-ucp`); a skills index with real skills (`agent-skills-index`).
3. Ask the owner whether the site offers it. If yes, ask for the live URL or the files. If no, record it as not applicable and stop.

`action-schemas` and `api-endpoints` can pass by describing something that exists on the site. Do not add a `SearchAction` for a site with no search page, an `OrderAction` for a site that takes no orders, or a link labelled "API" for a site without one.

## Next.js (App Router)

`integrate` crawls the site and, only when it finds forms, generates WebMCP files (a declarative HTML sample and a `webmcp.js` script that registers each form as a tool). On Next.js the plan then includes `WebMcpScript.tsx` and a post-install step to import it in the root layout. The plan covers that step: follow `integrate`'s plan and its steps, and do not hand-write these files. A site with no forms gets no WebMCP files, and the two checks stay `skip`. Whether a mounted `WebMcpScript` shows up in the server HTML that `webmcp-imperative` reads is not established here: re-audit and report the result as it is. `integrate` does not generate an MCP server, a server card, a skills index, a UCP profile or an API catalog, and it writes no `toolname` attribute into your forms.

## Pitfalls

- Do not advertise what the site lacks. A discovery file for a service that does not exist sends agents to a dead end.
- Do not point `/mcp`, a card or an index at a made-up URL to turn a check green.
- Do not hand-copy the `fixSnippet` or example JSON in the audit output into the project. The values in it are placeholders.
- Do not publish `/.well-known/ucp` for a site that does not run the Universal Commerce Protocol. The check's "not applicable" for non-stores is correct.
- JSON files must be served with a JSON content type. The crawler drops a `.well-known` file that is not, or that equals the site's catch-all page.

## Verify

After the owner supplies a real service and the files for it, run `audit <local url> --json`. Expected: the matching check `pass`. For a site that offers none of these the final state is `fail` or `skip`: report each as an owner item that does not apply.
