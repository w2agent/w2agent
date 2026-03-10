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

## Outputs

| Name | Description |
|------|-------------|
| `score` | Overall audit score (0–100) |
| `grade` | Letter grade (A, B, C, D, or F) |

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
      - uses: w2agent/generate-action@v1
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
      - uses: w2agent/generate-action@v1
        with:
          url: https://example.com
          output-dir: .w2agent/
```

## Permissions

| Permission | Scope | When needed |
|------------|-------|-------------|
| `pull-requests: write` | Posting/updating the audit comment on PRs | PR workflows |
| `contents: write` | Committing generated files back to the repo | Push workflows |

Workflows that only audit on PRs and never commit files only need
`pull-requests: write`. The two permissions are independent — combine them if
your workflow does both.

## Using Outputs

Reference `score` and `grade` in downstream steps by giving the action an `id`:

```yaml
- uses: w2agent/generate-action@v1
  id: audit
  with:
    url: https://example.com
- run: echo "Score ${{ steps.audit.outputs.score }}, Grade ${{ steps.audit.outputs.grade }}"
```

## Prerequisites

- **w2agent npm package**: The action installs `w2agent` via
  `npm install -g w2agent`. The package must be published to npm before this
  action is functional.
- **`jq`**: GitHub-hosted runners (`ubuntu-latest`) have `jq` pre-installed.
  Self-hosted runners must have `jq` available on `PATH`.
