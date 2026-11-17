---
id: https
checks:
  - https
fixBy: owner
---

# Fix guide: HTTPS

## Passes when

`https` passes (100) when every audited page URL starts with `https://`. If any one starts with `http://`, it is `fail` (0). There is no partial. The check reads the URL the audit requested for each page, not the URL after a redirect. Auditing `http://example.com` fails even when the server redirects to `https://`.

An audit of a local server (`http://localhost:<port>`) always fails this check. That is expected. A local run says nothing about the production site. Production hosting and its TLS certificate decide the result.

## Who fixes it

The owner does (`fixBy: owner`). HTTPS comes from the hosting platform or the domain's certificate and redirect setup, not from the project's code. `integrate` writes nothing for it. You cannot fix it from the repository.

## Fix (any framework)

Do not edit anything. For the final report:

1. If the audited URL was `http://localhost` or another local address, say: "https cannot pass on a local audit. It depends on the production host." Mark it not applicable to the local run.
2. If the audited URL was a real `http://` address, say which URL it was and ask the owner to confirm that the production site serves `https://` with a valid certificate and redirects `http` to `https`. Audit the `https://` address to measure it.
3. If the site is `https://` but the check fails, the crawl found a page URL that starts with `http://`. Name it from the audit output. The owner decides whether the site's own links should use `https`.

## Pitfalls

- Do not add redirects, an HSTS header or a local certificate to make a local audit pass.
- Do not rewrite links to `https://` for a site that has no certificate: its pages would stop loading.
- The `Strict-Transport-Security` header belongs to the `security-headers` guide and only matters once the site is on HTTPS.

## Verify

Run `audit <production https url> --json` after the owner confirms the host. Expected: `https` is `pass`. For a local audit the expected, final state is `fail`: report it as an owner item that cannot be measured locally.
