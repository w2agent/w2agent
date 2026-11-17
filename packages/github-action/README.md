# w2agent Audit & Generate Action

Audit your website for AI agent readiness on every PR, and regenerate agent
assets (llms.txt, robots.txt, schema.org, agent-card) on every push to main.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `url` | yes | — | Website URL to audit |
| `threshold` | no | `80` | Minimum passing score (0–100). Fails the step if below. |
| `output-dir` | no | `.w2agent/` | Directory for generated agent assets |
| `github-token` | no | `${{ github.token }}` | Token used to post PR comments |
| `node-version` | no | `20` | Node.js version to install w2agent with |
| `formats` | no | `all` | Comma-separated generate formats: `llms-txt`, `robots-txt`, `schema-org`, `agent-card`, `faq`, `markdown`, `full`, `webmcp`, `all` |
| `max-pages` | no | `20` | Maximum pages to scan during audit and generate |
| `generate` | no | `true` | Set to `false` to run audit only (no file generation or commit) |

## Outputs

| Name | Description |
|------|-------------|
| `score` | Overall audit score (0–100) |
| `grade` | Letter grade (A, B, C, D, or F) |
| `badge-url` | URL to the w2agent.dev badge SVG for this site (requires site to be indexed on w2agent.dev) |

The full audit JSON is always written to `/tmp/w2agent-audit.json` and can be accessed by downstream steps in the same job.

## Badge

The action outputs a `badge-url` pointing to a shields.io-compatible SVG badge. Add it to your project README:

```markdown
[![AI Readiness](https://w2agent.dev/api/sites/example-com/badge.svg)](https://w2agent.dev/leaderboard/example.com)
```

Replace `example-com` with your site slug (hostname with dots replaced by hyphens, `www.` stripped). The badge shows the current grade and score and updates automatically after each audit.

> **Note**: The badge returns a "pending" state until the site has been audited at least once on w2agent.dev.

## Example: PR Audit

Posts an audit score comment on every pull request. Fails the step if the
score is below the threshold.

```yaml
name: AI Readiness Audit

on:
  pull_request:

permissions:
  pull-requests: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: interskh/w2agent/packages/github-action@v0.1.0
        with:
          url: https://example.com
          threshold: 80
```

## Example: Generate on Push

Regenerates agent assets on every push to `main` and commits them back to the
repository. The action handles the auto-commit — no extra step needed.

```yaml
name: Regenerate Agent Assets

on:
  push:
    branches: [main]

permissions:
  contents: write

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: interskh/w2agent/packages/github-action@v0.1.0
        with:
          url: https://example.com
          output-dir: .w2agent/
```

## Example: Audit Only (No Generate)

Runs the audit and posts a PR comment without generating or committing any files. Useful when you want score gating without modifying repo contents.

```yaml
name: AI Readiness Audit

on:
  pull_request:

permissions:
  pull-requests: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: interskh/w2agent/packages/github-action@v0.1.0
        with:
          url: https://example.com
          threshold: 80
          generate: 'false'
```

## Example: Custom Formats

Generate only specific agent file formats instead of all of them:

```yaml
- uses: interskh/w2agent/packages/github-action@v0.1.0
  with:
    url: https://example.com
    formats: 'llms-txt,robots-txt'
    max-pages: '10'
    output-dir: .w2agent/
```

Available formats: `llms-txt`, `robots-txt`, `schema-org`, `agent-card`, `faq`, `markdown`, `full`, `webmcp`, `all` (default).

## Permissions

| Permission | Scope | When needed |
|------------|-------|-------------|
| `pull-requests: write` | Posting/updating the audit comment on PRs | PR workflows |
| `contents: write` | Committing generated files back to the repo | Push workflows |

Workflows that only audit on PRs and never commit files only need
`pull-requests: write`. The two permissions are independent — combine them if
your workflow does both.

## Using Outputs

Reference `score`, `grade`, and `badge-url` in downstream steps by giving the action an `id`:

```yaml
- uses: interskh/w2agent/packages/github-action@v0.1.0
  id: audit
  with:
    url: https://example.com
- run: |
    echo "Score ${{ steps.audit.outputs.score }}, Grade ${{ steps.audit.outputs.grade }}"
    echo "Badge: ${{ steps.audit.outputs.badge-url }}"
```

## Troubleshooting

**`npm install -g w2agent@0.1.0` fails — package not found**
The action installs the pinned `w2agent@0.1.0`. It works once that version is published to npm and the `v0.1.0` release tag exists. See [npmjs.com/package/w2agent](https://www.npmjs.com/package/w2agent) for status.

**Audit fails with "URL unreachable" or timeout**
Ensure the URL is publicly accessible from GitHub Actions runners. Private/intranet URLs require a self-hosted runner with network access. Use `max-pages: '5'` to reduce timeout risk on large sites.

**`jq: command not found` on self-hosted runners**
GitHub-hosted runners (`ubuntu-latest`) have `jq` pre-installed. Self-hosted runners must have `jq` on `PATH`. Install with: `sudo apt-get install -y jq` (Debian/Ubuntu) or `brew install jq` (macOS).

**Badge shows "pending"**
The badge requires the site to have been audited at least once on [w2agent.dev](https://w2agent.dev). The badge URL is derived from the hostname and will show live data after the first indexed audit.
