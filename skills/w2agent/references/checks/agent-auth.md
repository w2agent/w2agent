---
id: agent-auth
checks:
  - public-api
  - openapi-spec
  - developer-portal
  - agent-auth-docs
  - oauth-discovery
  - scoped-permissions
  - pkce-s256
  - mcp-auth
  - cimd-support
  - agent-operator-signing
  - api-catalog-rfc9727
fixBy: owner
---

# Fix guide: public API and agent authorization

## Passes when

These checks only describe a site that has a public API or an MCP server, and how agents get access to it.

- `public-api`: probes `<origin>/api/` and `https://api.<registered domain>/` (the last two host labels). It passes (100) when either answers 2xx or 4xx with a JSON or YAML content type. Otherwise it counts links on the home page: `href` values that contain `/api/` (or end in `/api`) or `api.<host>`. Three or more pass, one or two are `partial` (50), none is `fail` (0).
- `openapi-spec`: probes a fixed list of paths (`/openapi.json`, `/swagger.json`, `/.well-known/openapi`, `/api-docs`, `/api/docs`, `/v3/api-docs`, `/v2/api-docs`, and similar). A spec with at least one endpoint passes (100), a spec with none is `partial` (50), no spec is `fail`.
- `developer-portal`: probes `/developers`, `/developer`, `/api`, `/docs/api`, `/api-docs`, then the `docs.`, `developers.` and `developer.` subdomains, for an HTML 2xx page. Text of 1000 characters or more passes, less is `partial` (50), none is `fail`.
- `agent-auth-docs`: counts places where "api key", "oauth" or "rate limit" appears within 200 characters of "agent", "bot", "ai", "scope", "permission" or "token", in the portal text, the `/keys`, `/api-keys` or `/docs/keys` pages, and the home page. Three or more pass, one or two are `partial`, none is `fail`.
- `oauth-discovery`: follows RFC 9728 protected-resource metadata to RFC 8414 authorization-server metadata. The full chain passes. Valid resource metadata with no usable server, or valid server metadata at the root without resource metadata, is `partial` (50). Otherwise `fail`.
- `scoped-permissions`: scans the portal and key-doc text for scope patterns such as `read:x`, the word "scope" near "permission", "token" or "access", bullet items like `- x:y`, and wording such as "restricted keys" or "read-only". Three or more signals pass, one or two are `partial`, none is `fail`.
- `pkce-s256`: passes when the authorization server metadata lists `S256` in `code_challenge_methods_supported`. `partial` (50) when the developer docs mention PKCE and S256 but the metadata does not. Otherwise `fail`.
- `mcp-auth`: judged only when an MCP endpoint was found and it answers 401. A Bearer challenge that links valid protected-resource metadata passes. A challenge without valid metadata is `partial`; a 401 with no Bearer challenge is `fail`. Every other case is `skip`.
- `cimd-support` (bonus): passes when the resolved authorization server advertises `client_id_metadata_document_supported`. Otherwise `skip`. It is never `fail`.
- `agent-operator-signing` (weight 0): reads `/.well-known/http-message-signatures-directory` (served as `application/http-message-signatures-directory+json`). Missing is `skip`. It passes when the file holds an Ed25519 key (`kty` `OKP`, `crv` `Ed25519`, string `x`) and a `signature_agent` on the site's own origin. A file that lacks either is `fail`.
- `api-catalog-rfc9727`: reads `/.well-known/api-catalog` (served as `application/linkset+json`). It passes when the `linkset` array has an entry with an `anchor` and `item`, `service-desc` or `service-doc` links that each have an `href`. Missing or empty is `fail`.

Several results are set to `skip` by the audit itself, in this order (engine, cascade): `openapi-spec`, `developer-portal` and `api-catalog-rfc9727` when `public-api` is `fail` or `skip`; `agent-auth-docs` and `scoped-permissions` when `developer-portal` is `fail` or `skip` (so also after it was just set to `skip`); `oauth-discovery` when `public-api` is `fail` or `skip` and no MCP endpoint exists; `pkce-s256` when both `oauth-discovery` and `developer-portal` are `fail` or `skip`; `mcp-auth` when no MCP endpoint exists (this one is set even when it would have passed, and its score becomes 0). The message reads "Not applicable — dependency unmet". A passing or partial result is kept, except for `mcp-auth`.

## Who fixes it

The owner does (`fixBy: owner`). Whether a public API exists, how agents authenticate and what scopes it offers are product and security decisions. You cannot add an API, an OAuth server or a signing key by writing their descriptions, and a wrong one is a security fault. `integrate` writes none of these files.

Read each non-pass result by its kind:

- Cascade `skip` ("dependency unmet"): not applicable. The site has no public API (or no MCP server), so these checks have nothing to measure. No edit. Report "not applicable: no public API detected".
- `skip` with "Could not verify portal (network unreachable)": not measured. Re-run the audit once. If it repeats, report it as unmeasured.
- Own `skip` (`cimd-support`, `agent-operator-signing`): the site does not offer it. No edit.
- `fail` or `partial` on a check that did run: a finding. It is still the owner's, and only meaningful if the site really has the API or server that the check describes.

## Fix (any framework)

Do not edit anything. For the final report:

1. If `public-api` is `fail` and the checks below it are cascade `skip`, write one line: "No public API or MCP server detected; the agent-auth checks do not apply." Stop there.
2. If the owner says the site does have an API: name what the audit did not find (an OpenAPI file at a probed path, a developer portal at a probed path, protected-resource metadata, a catalog), and ask the owner to publish or point to it.
3. For `partial` or `fail` on OAuth checks, report the audit's message: it names which step of the discovery chain broke.

## Pitfalls

- Do not create `/api`, `/developers`, an OpenAPI file, OAuth metadata, a signing directory or a catalog for a site that has no API. The checks would pass and the site would advertise something that does not exist.
- Do not read a cascade `skip` as a failure or as "fix `public-api` first". The right fix is often nothing.
- Do not add `S256` or a scope list to a document you do not control. The authorization server states them, not the site.
- A `skip` never authorizes an edit.

## Verify

When the owner adds real API surface, run `audit <local url> --json`. Expected: `public-api` `pass`, and the checks that were cascade `skip` now run and report their own status. For a site without an API the final state is `fail` for `public-api` and `skip` for the rest: report that as not applicable.
