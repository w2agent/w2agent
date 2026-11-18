# w2agent

Audit a website for AI-agent readiness and generate the files that make it discoverable by Claude, GPT and other MCP-compatible tools: llms.txt, agent-card.json, Schema.org JSON-LD, WebMCP and more.

## Let your coding agent do it

Ask your coding agent:

> use w2agent to make my site agent-ready

It follows the [agent playbook](https://github.com/w2agent/w2agent/blob/main/docs/AGENT-PLAYBOOK.md). The flow it runs:

```bash
npx w2agent@0.1.0 audit <local url> --json                 # baseline score
npx w2agent@0.1.0 integrate <local url> --dry-run --json \
  --project-dir . --site-url <production origin>            # plan, writes nothing
npx w2agent@0.1.0 integrate <local url> --install --json \
  --project-dir . --site-url <production origin>            # apply
# then: do the postInstallSteps, rebuild and restart the local server
npx w2agent@0.1.0 guide <guide-id>                         # fix guide for a failing check
npx w2agent@0.1.0 audit <local url> --json                 # re-audit
```

## Commands

| Command | What it does |
|---|---|
| `audit <url>` | Score a site for AI-agent readiness. |
| `integrate <url>` | Generate platform-specific integration files (Next.js, WordPress, Nuxt, Astro and more). |
| `guide <guide-id>` | Print the fix guide for a failing check. |
| `generate <url>` | Generate llms.txt, markdown, robots.txt, Schema.org, agent card and FAQ files. |
| `schema` | Print every command, flag and value as JSON. |

Flags, JSON output and exit codes: [CLI agent mode](https://github.com/w2agent/w2agent/blob/main/docs/CLI-AGENT-MODE.md).

## Links

- Source and docs: https://github.com/w2agent/w2agent
- Library: [`@w2agent/core`](https://www.npmjs.com/package/@w2agent/core)

MIT License.
