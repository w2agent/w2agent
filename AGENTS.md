# AGENTS.md

## Asked to use w2agent on a site? Start here

- Do not edit this repository. Work in the site's own project.
- Follow [docs/AGENT-PLAYBOOK.md](docs/AGENT-PLAYBOOK.md), or load [skills/w2agent/SKILL.md](skills/w2agent/SKILL.md).
- Run the CLI. Do not read `packages/core` to learn it. `w2agent schema` prints every command, flag and value as JSON.
- Flags, JSON documents and exit codes: [docs/CLI-AGENT-MODE.md](docs/CLI-AGENT-MODE.md).

Everything below is for people changing w2agent itself.

## Architecture

pnpm workspace with Turborepo. Node 18+ and pnpm 9.

- `packages/core/`: audit engine, generators, platform adapters. Published as `w2agent-core`.
- `packages/cli/`: the CLI. Published as `w2agent`. Depends on core through `workspace:*`.
- `packages/astro`, `packages/docusaurus`, `packages/nuxt`: installable framework integrations.
- `packages/wordpress`: PHP plugin (no build step).
- `packages/shopify-app`: Shopify app (Remix).
- `packages/github-action`: GitHub Action.
- `docs/`: user and design docs. `skills/w2agent/`: the agent skill. `.claude-plugin/` and `plugin.json`: plugin manifests.

## Commands

Run from the repo root.

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies. |
| `pnpm build` | Build core and cli (and every other package that has a build). |
| `pnpm test` | All unit tests. Builds first. |
| `pnpm --filter w2agent-core test -- -t "pattern"` | One core test or a group of tests by name. |
| `pnpm --filter w2agent-core test:integration` | Integration tests. They build real platform projects and audit them. |
| `pnpm test:agent-surfaces` | Validates `SKILL.md`, the plugin manifests and the version pins. Needs a built CLI (`pnpm build` first). |
| `pnpm dev` | Watch mode. |
| `pnpm --filter w2agent-core gen:guides` | Regenerate `guides.generated.ts` after editing `skills/w2agent/references/checks/*.md`. The build fails when it is stale. |
| `pnpm lint` | Biome check (what CI runs). |

`pnpm lint:fix` and `pnpm format` run Biome with `--write` over everything Biome sees, including untracked directories. Prefer `pnpm exec biome check --write <paths>` on the files you changed.

CI runs `pnpm lint`, `pnpm test` and `pnpm test:agent-surfaces` on Node 22.

## Tests

- Unit tests use Vitest and live next to each package. Add a test for every bug fix and new behavior.
- Change a core check or generator: run the single-test command above first, then `pnpm test`.
- Integration tests are slower. Run them when you touch platform adapters or `integrate`.

## CLI contract

- Changing a CLI flag, command or JSON output? Keep `w2agent schema` and [docs/CLI-AGENT-MODE.md](docs/CLI-AGENT-MODE.md) in sync. Agents depend on both.
- Keep the playbook and the skill consistent with the CLI. They are public and read by agents with no other context.

## Docs conventions

- This file is the single source of contributor instructions. `CLAUDE.md` only imports it (`@AGENTS.md`). Do not copy content into other agent files.
- Everything in this repository is public. No machine paths, internal hostnames, private repo names or business strategy.
- Repo URL: `https://github.com/interskh/w2agent`.
- Use `npx w2agent@<version>` with an explicit version in user-facing docs.
- Other contributor details (adding platforms, test architecture): [CONTRIBUTING.md](CONTRIBUTING.md).

## Release

Packages: `w2agent-core` and `w2agent`. A GitHub release triggers `.github/workflows/publish.yml`. It runs build and test, then publishes both packages to npm.

1. Bump `version` in `packages/cli/package.json` (and in `packages/core/package.json` when core changed).
2. Update the pinned `w2agent@<version>` in `README.md`, `README_CN.md`, `docs/AGENT-PLAYBOOK.md` and `skills/w2agent/SKILL.md`.
3. Update `version` in `.claude-plugin/plugin.json` and the root `plugin.json`.
4. Run `pnpm test:agent-surfaces`. It fails until every pin matches the CLI version.
5. Merge, then `gh release create vX.Y.Z`.
