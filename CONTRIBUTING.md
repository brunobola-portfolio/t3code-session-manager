# Contributing

Thanks for helping. Issues, ideas and pull requests are all welcome.

## Before you start

- **Bugs:** open an issue with the output of `t3sm doctor --json` (read it first: emails are masked and your home is
  shown as `~`, but folder names are yours), the command you ran, its output and exit code, your OS and T3 Code
  version.
- **A new agent (harness):** read [docs/adding-a-harness.md](docs/adding-a-harness.md). If you cannot write it, the
  **Harness request** issue template collects what someone else needs to.
- **Larger changes:** open an issue first, so we agree on the shape before you write it.
- **Looking for something to do:** [ROADMAP.md](ROADMAP.md) lists what is planned and where help is wanted.
- **Working with a coding agent:** it should read [AGENTS.md](AGENTS.md) (Claude Code reads it through `CLAUDE.md`).

## Development

```bash
git clone https://github.com/brunobola-portfolio/t3code-session-manager
cd t3code-session-manager
npm install                    # TypeScript and @types/node only; also builds dist/
npm run typecheck
npm test                       # node --test over test/**/*.test.ts, Node 22.18+ runs the .ts files directly
npm run build                  # dist/, what the published bin runs
node bin/t3sm.mjs --help
npm run assets                 # regenerate docs/assets/*.svg
npm run release:check          # versions (lockfile too), install pins, repo URLs and the changelog agree
```

Point `T3SM_HOME` at a scratch folder while you experiment, so your real state folder (journal, plans, config) is
not touched: `T3SM_HOME=$PWD/.spike/state node bin/t3sm.mjs plan`. `.spike/` is ignored by git.

**A checkout always runs `src/`.** `bin/t3sm.mjs` runs the TypeScript sources when `src/cli/main.ts` is next to it
and the package is not inside `node_modules`, so a stale `dist/` never shadows your changes; an installed package
runs `dist/cli/main.js` (`bin/entry.mjs` decides). With neither, it asks you to run `npm run build`. The tests always
import `src/`.

## Live tests against a real T3 Code (`T3_E2E=1`)

`test/e2e/*.live.test.ts` are skipped unless `T3_E2E=1`. They talk to the T3 Code running on your machine:

| File | What it does |
| :-- | :-- |
| `live.test.ts` | Read-only: token, `server.getConfig`, `agentSessions.scan` |
| `apply.live.test.ts` | The full apply path: 3 synthetic old transcripts plus one that must be parked, one wave, mtimes restored, re-apply is a no-op (Windows) |
| `convert.live.test.ts` | One synthetic OpenCode-style session converted, imported, and resumed with `claude --resume -p` (Windows; spends a few tokens) |
| `merge.live.test.ts` | Import, a hand-made terminal continuation, merge, rollback (Windows) |

Rules, because these write to your real Claude account folder and your real T3 Code:

- Run them only on your own machine, with T3 Code open and **`CLAUDE_CONFIG_DIR` unset**: the writing ones refuse
  to start when it is set.
- They write synthetic transcripts into your **real** `~/.claude/projects/`, in the encoded folder of a disposable
  project folder under `.spike/` (for example `.spike/apply-e2e`), only after checking that `~/.claude` is T3 Code's
  `claudeAgent` home. They refuse to start when that encoded folder, the project folder or a T3 project for it already
  exists (a leftover), so they never write next to files they did not create. In `finally` they remove everything they
  created: the T3 project with its threads, the transcripts, the empty encoded folder, the temp folders. If a run is
  killed, check for leftovers named after `.spike/*-e2e` in `~/.claude/projects/` and in T3 Code, and remove them by
  hand before the next run.
- Never point them at real sessions or change them to do so, and never run them in CI.

```bash
T3_E2E=1 node --test --test-timeout=180000 test/e2e/apply.live.test.ts
```

In PowerShell: `$env:T3_E2E=1; node --test --test-timeout=180000 test/e2e/apply.live.test.ts`.

## Ground rules

- **Zero runtime dependencies.** Node's standard library only (`node:sqlite` for OpenCode).
- **Never write what is not ours.** No writes to T3 Code's database or settings file, to another agent's folder, or
  to a native transcript's content. `test/safety/boundaries.test.ts` checks the first two.
- **Journal before change, restore in `finally`.** Every file time t3sm moves is journaled first; a new write path
  needs a rollback path and a test for it.
- **Reads are safe, writes ask.** A command that writes must refuse on a non-terminal without `--yes` (exit 2).
- **Synthetic fixtures only.** No real paths, names, emails, tokens or project names in tests, fixtures, docs or
  screenshots: use `C:/work/demo`, `~/code/app`, `a***@example.com`. Before a pull request, check your changes against
  your own private data, with a denylist kept **outside** the repository (never commit it):

  1. Write one Perl-style pattern per line in, say, `~/.t3sm-denylist`: your names and usernames, email addresses,
     employer and client names, real folder and project names. Write `.{1,2}` where a word has an accented letter, so
     the accented and unaccented spellings both match.
  2. Run it over every file git would publish. It must print nothing:

     ```bash
     git grep -n -I -i -P --untracked -f ~/.t3sm-denylist -- .
     git grep -n -I -i -P --untracked "@(gmail|outlook|hotmail|icloud)\.com" -- .
     ```

- **Cross-platform.** CI runs Ubuntu, macOS and Windows on Node 22 and 24. Path handling goes through
  `src/core/paths.ts`.
- **Honest docs.** The status tables say only what was run. Mark anything unverified as such.
- **Changelog.** Describe user-visible changes under `## [Unreleased]` in `CHANGELOG.md`.

## Pull requests

Fill in the template. CI must be green (`ci-ok`): typecheck, tests, build, the release check and the assets check. If
you changed the art or the CLI's plan summary, run `npm run assets` and commit `docs/assets/`: CI regenerates the
images and fails on any difference (the terminal demo is rendered with the CLI's own formatters).

Commit messages in conventional style: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

## Releasing (maintainer)

See [docs/launch.md](docs/launch.md#release-routine): `node scripts/release.js X.Y.Z`, a release pull request, then
a `vX.Y.Z` tag on `main`, which the Release workflow checks and publishes.

Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
