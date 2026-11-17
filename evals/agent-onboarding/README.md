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
  run.mjs       build a run dir and run the harness in a VM
  score.mjs     score a run dir (or the pristine fixture) in a VM with no staged credentials
  sandbox.mjs   container runtime wrapper (VMs, volumes, copy in/out)
  credentials.mjs  reads and strips the host login, redaction
  scorer-vm.mjs    the host side of score.mjs
  sandbox/      Dockerfile for the VM image
  fixtures/     synthetic sites
  prompts/      tool.md, docs-only.md
  test/         node --test unit tests
```

A run dir holds `workspace/site/` and `workspace/w2agent/` as built before the run, `transcript.jsonl`, `stderr.log` and `run.json`. The scorer compares against the repo's `fixtures/<name>/`, not a copy in the run dir, because the agent can reach files next to its workspace. The scorer adds `result.json`, `summary.md` and `audit.json`.

## Run

Both the agent and the scorer run in Apple `container` VMs. Nothing the agent writes executes on the host.

Prerequisites:

- macOS with Apple `container` installed and its system service started (`container system start`).
- `claude` and/or `codex` installed and logged in on the host. The runner reads the login itself (Claude: macOS Keychain, else `~/.claude`; Codex: `~/.codex/auth.json`). The access token must outlive the run, otherwise the runner refuses and tells you to refresh the login.
- Node >= 22 and network.
- The first run builds the sandbox image (about 6 minutes). Later runs reuse it; the tag is a hash of the Dockerfile and its build args. Only `container` is supported.

A real run spends money on the harness.

```sh
node evals/agent-onboarding/run.mjs --harness claude --arm tool   # or: pnpm eval:agents --harness claude --arm tool
node evals/agent-onboarding/score.mjs --run <dir printed by run.mjs>
node evals/agent-onboarding/run.mjs --cleanup
```

`run.mjs` builds the workspace on the host, copies it into a fresh VM volume, stages a short-lived copy of your login, runs the harness, and deletes the VM. The volume stays for scoring. `run.mjs --cleanup` deletes ALL `w2a-eval-*` VMs and volumes, including unscored runs and runs in progress. Use it only when nothing else is running; to remove one VM, use `container delete --force <name>`. Do not use `--out` inside a git work tree: `run.mjs` refuses it, and it refuses a non-empty `--out`.

`run.mjs` options: `--harness claude|codex`, `--arm tool|docs-only`, `--fixture`, `--ref <rev>` (export an older commit of w2agent for the agent), `--w2agent <path>`, `--model`, `--timeout <min>`, `--out <dir>` (default: a fresh dir in the OS temp dir), `--claude-credentials <file>` and `--codex-auth <file>` (login files when yours are not in the default place, for example a custom `CLAUDE_CONFIG_DIR`), `--dry-run` (build the workspace and print the sandbox plan, start nothing).

`score.mjs` refuses if the agent VM still exists. It starts a second VM on the same volume with no credentials, copies in a fresh `git archive` of the w2agent ref plus this directory's scorer code (not `test/`), builds the CLI inside, and runs the whole scorer there. Only `result.json`, `summary.md` and `audit.json` come back. Then the scorer VM and, after a successful score, the volume are deleted.

`score.mjs` options: `--run <dir>`, `--ref <rev>` (w2agent revision the scorer CLI is built from; default: this checkout's HEAD, so every run is scored by the same code, not the revision the agent was given), `--out <dir>` (default: the run dir), `--timeout <min>` (limit per install, build and start step; the whole VM also has a deadline of 3 times this plus 20 minutes), `--keep` (keep the volume), `--claude-credentials` / `--codex-auth` (same as above; used only to redact the copied-out files). `--baseline --fixture <name> --out <dir>` scores the untouched fixture through a scorer VM on a fresh volume.

Score the before and after runs from the same checkout (or the same `--ref`), so the rubric does not drift between them. The result records `scorer.cliRef`, `scorer.evalsRef` and `scorer.evalsDirty` (the scorer code is copied from this checkout's working tree).

Run dirs: `workspace/site/` and `workspace/w2agent/` stay on the host as built, but the agent's edits live in the volume. `run.json` holds the VM and volume names. `result.json` and `summary.md` print `<run>`, `<workspace>` and `~` in place of paths.

## Sandbox and threat model

Isolated:

- No host mount. The workspace goes in and the three result files come out over `container exec` pipes.
- The agent gets a fresh HOME. It does not see your CLAUDE.md, settings, plugins or Codex config.
- The harness env is an allowlist (HOME, PATH, LANG, cache dirs). Host API keys and shell env never enter the VM.
- VMs run with `--cap-drop ALL`, CPU and memory caps, a size-capped volume and a tmpfs `/tmp`.
- The login copy has no refresh token and must stay valid for the whole run, so the agent cannot mint new tokens.
- The scorer VM is never given staged credentials. It builds from a fresh `git archive`, outside the agent's workspace. It is not credential-free in an absolute sense: the agent could have copied its own token into the workspace volume, and the scorer VM runs that workspace.
- Transcript, stderr, `result.json`, `summary.md` and `audit.json` are redacted for every staged token value and size-capped. The counts are recorded (`redactions` in `run.json`, `redaction` in `result.json`). If the host login cannot be read at score time, the outputs are still written and `redaction` says `skipped`.

Residuals:

- The network is on: the model API and npm need it. The agent can read its own access token and send it anywhere until it expires (about hours for Claude, about days for Codex).
- The guest can reach services on the host's bridge gateway.
- Redaction removes the exact staged token values plus anything shaped like an Anthropic token (`sk-ant-...`) or a JWT, so a token rotated since the run is still caught. If the host login cannot be read at score time, `result.json` records `redaction.exact: "unavailable: ..."` and only the patterns apply. Encoded copies (base64, split, reversed) are not caught. Treat run dirs as secret-bearing until the token expires.
- Agent-written lifecycle scripts (`npm run build`, `start`) run in the scorer VM and could tamper with scoring. The VM has no credentials and no host mount, but its result files are written by the same VM.
- Consider a dedicated eval account, so a leaked token costs nothing else.

`transcript.rawScan` is an advisory scan of the raw transcript. It lists npm and HTTP 404 signatures (any string in any event, with the call's command) and `w2agent` install/exec mentions found in agent-authored text only (tool inputs, codex commands), so installs hidden in agent-written scripts show up when the script body is in the transcript. Codex `file_change` events carry only paths, so a script codex wrote that way stays invisible; read it from disk before cleanup. Each list holds at most 50 hits; `counts` has the totals. It does not change `unpublishedAttempts`.

A human classifies each hit as a probe (`npm view` 404), an HTTP 404 from the local site, docs text, or a real install/exec. Only a real install/exec of an unpublished name counts against the gate.

If the agent breaks the site (install, build, start or audit fails), the result is `site.ok: false` with the failing stage and an output tail, and the score is null.

`evals/**/results/` stays in `.gitignore` as a safety net; do not write results into the repo.

## Confounds

- Both harnesses run with a fresh HOME inside the VM, so they load no operator config. Results still depend on the model, the account and the harness versions pinned in the image.
- Codex runs with `--dangerously-bypass-approvals-and-sandbox` (its Linux sandbox does not nest in the VM), like Claude's bypass mode. The VM is the boundary.
- Neither harness has write containment inside the VM. For both the scorer flags Write/Edit calls, codex `file_change` paths, shell redirects, `tee`, `cp`, `mv`, `rm`, `sed -i`, `mkdir` and `cd` that land outside the workspace (relative paths resolve against the tracked cwd). Flags are advisory and heuristic: quotes and backslash escapes are honoured, heredoc bodies are not parsed. The claude cwd model assumes every successful `cd` carries into the next Bash call; Claude Code does not always carry it, so a site command can be flagged as run inside `w2agent/`. Check the call's output before counting a docs-only violation.
- The scorer installs the site with `npm install --ignore-scripts` and flags changed `package.json` scripts (`scriptsChanged` in `result.json`), but `npm run build` and `npm run start` still run the site's own scripts.
