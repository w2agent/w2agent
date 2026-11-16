# Agent onboarding eval

Measures whether a coding agent (Claude Code or Codex) can make a small Next.js site more agent-ready, with and without w2agent. The agent works in an isolated workspace and gets one short prompt. A scorer then builds the agent's site, serves it, and audits it with the w2agent CLI.

Two arms:

- `tool`: the agent gets a checkout of w2agent (without `evals/`) next to the site.
- `docs-only`: same checkout, but the prompt forbids installing, building or running it. The scorer flags any violation.

## Release-gate bar

- Zero overwritten user files (no deleted baseline files, no file with under 20% of its original lines left).
- Zero calls to unpublished package names (an install or exec of a w2agent package that returns an npm 404).
- The `tool` arm must beat the `docs-only` arm on audit score.

## Layout

```
evals/agent-onboarding/
  run.mjs       build a run dir and launch the harness
  score.mjs     score a run dir (or the pristine fixture)
  fixtures/     synthetic sites
  prompts/      tool.md, docs-only.md
  test/         node --test unit tests
```

A run dir holds `workspace/site/` (what the agent edits), `workspace/w2agent/` (the exported checkout), `baseline/` (the pristine fixture), `transcript.jsonl`, `stderr.log` and `run.json`. The scorer adds `result.json`, `summary.md` and `audit.json`.

## Run

Prerequisites: Node >= 22, network, `pnpm build` done (the scorer audits with `packages/cli/dist/index.js`), and `claude` / `codex` installed and logged in. A real run spends money on the harness.

```sh
pnpm build
pnpm eval:agents --harness claude --arm tool --out evals/agent-onboarding/results/claude-tool
node evals/agent-onboarding/score.mjs --run evals/agent-onboarding/results/claude-tool
```

`run.mjs` options: `--harness claude|codex`, `--arm tool|docs-only`, `--fixture`, `--ref <rev>` (export an older commit of w2agent for the agent), `--w2agent <path>`, `--model`, `--timeout <min>`, `--out <dir>` (default: a fresh dir in the OS temp dir), `--dry-run` (build the workspace, print the argv and env, do not launch).

`score.mjs` options: `--run <dir>`, `--cli <path>` (audit with another CLI build), `--out <dir>` (default: the run dir), `--timeout <min>` (limit per install, build and start step). `--baseline --fixture <name> --out <dir>` scores the untouched fixture with no transcript.

To score an older commit, check it out in a worktree, build it, and pass its CLI with `--cli`. Use `--ref` on `run.mjs` to give the agent that same commit. The result records the scorer's `cliRef`.

If the agent breaks the site (install, build, start or audit fails), the result is `site.ok: false` with the failing stage and an output tail, and the score is null.

Results are gitignored and never committed (`evals/**/results/`).

## Confounds

- Both harnesses load the operator's own global instructions, settings and plugins. Results depend on whose machine runs them. Compare runs from the same machine and config.
- Codex runs in a `workspace-write` sandbox that blocks writes outside the workspace. A full `pnpm build` of the monorepo fails on a tool cache under the home directory, so a codex agent must build only the CLI packages.
- Claude has no write containment here. The scorer only flags Write/Edit calls, shell redirects and `cd` outside the workspace. For codex it reports "sandbox-enforced".
- The scorer installs the site with `npm install --ignore-scripts` and flags changed `package.json` scripts (`scriptsChanged` in `result.json`), but `npm run build` and `npm run start` still run the site's own scripts.
