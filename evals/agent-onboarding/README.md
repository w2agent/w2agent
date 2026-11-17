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

A run dir holds `workspace/site/` (what the agent edits), `workspace/w2agent/` (the exported checkout), `transcript.jsonl`, `stderr.log` and `run.json`. The scorer compares against the repo's `fixtures/<name>/`, not a copy in the run dir, because the agent can reach files next to its workspace. The scorer adds `result.json`, `summary.md` and `audit.json`.

## Run

Prerequisites: Node >= 22, network, `pnpm build` done (the scorer audits with `packages/cli/dist/index.js`), and `claude` / `codex` installed and logged in. A real run spends money on the harness.

```sh
pnpm build
pnpm eval:agents --harness claude --arm tool
node evals/agent-onboarding/score.mjs --run <dir printed by run.mjs>
```

Use the default output dir (a fresh dir in the OS temp dir). `run.mjs` refuses an `--out` that is not empty or sits inside any git work tree: agents load `AGENTS.md` / `CLAUDE.md` from parent repos and could read the scorer and prompts there.

`run.mjs` options: `--harness claude|codex`, `--arm tool|docs-only`, `--fixture`, `--ref <rev>` (export an older commit of w2agent for the agent), `--w2agent <path>`, `--model`, `--timeout <min>`, `--out <dir>` (default: a fresh dir in the OS temp dir; must be empty or new, and outside any git repo), `--dry-run` (build the workspace, print the argv and env, do not launch).

`score.mjs` options: `--run <dir>`, `--cli <path>` (audit with another CLI build), `--out <dir>` (default: the run dir), `--timeout <min>` (limit per install, build and start step). `--baseline --fixture <name> --out <dir>` scores the untouched fixture with no transcript.

Score the before and after runs with one fixed scorer CLI (`--cli <path>`), so the rubric does not drift between them. Use `--ref` on `run.mjs` to give the agent an older commit of w2agent. The result records `scorer.cliRef` (HEAD of the checkout holding the CLI) and `scorer.cliDirty` (uncommitted changes under its `packages/`).

`result.json` and `summary.md` print `<run>`, `<workspace>` and `~` in place of machine paths.

`transcript.rawScan` is an advisory scan of the raw transcript. It lists npm and HTTP 404 signatures (any string in any event, with the call's command) and `w2agent` install/exec mentions found in agent-authored text only (tool inputs, codex commands), so installs hidden in agent-written scripts show up when the script body is in the transcript. Codex `file_change` events carry only paths, so a script codex wrote that way stays invisible; read it from disk before cleanup. Each list holds at most 50 hits; `counts` has the totals. It does not change `unpublishedAttempts`.

A human classifies each hit as a probe (`npm view` 404), an HTTP 404 from the local site, docs text, or a real install/exec. Only a real install/exec of an unpublished name counts against the gate.

If the agent breaks the site (install, build, start or audit fails), the result is `site.ok: false` with the failing stage and an output tail, and the score is null.

`evals/**/results/` stays in `.gitignore` as a safety net; do not write results into the repo.

## Confounds

- Both harnesses load the operator's own global instructions, settings and plugins. Results depend on whose machine runs them. Compare runs from the same machine and config.
- Codex runs in a `workspace-write` sandbox that blocks writes outside the workspace except `/tmp` and `$TMPDIR`. A full `pnpm build` of the monorepo fails on a tool cache under the home directory, so a codex agent must build only the CLI packages.
- Claude has no write containment here. For both harnesses the scorer flags Write/Edit calls, codex `file_change` paths, shell redirects, `tee`, `cp`, `mv`, `rm`, `sed -i`, `mkdir` and `cd` that land outside the workspace (relative paths resolve against the tracked cwd). Flags are advisory and heuristic: quotes and backslash escapes are honoured, heredoc bodies are not parsed. The claude cwd model assumes every successful `cd` carries into the next Bash call; Claude Code does not always carry it, so a site command can be flagged as run inside `w2agent/`. Check the call's output before counting a docs-only violation.
- The scorer installs the site with `npm install --ignore-scripts` and flags changed `package.json` scripts (`scriptsChanged` in `result.json`), but `npm run build` and `npm run start` still run the site's own scripts.
