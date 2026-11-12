# AGENTS.md

Guidance for coding agents working in this repository. Humans: start with [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

`t3sm` (t3code-session-manager) is a command-line tool that brings sessions from coding agents (Claude Code with one
or more accounts, Codex, Pi, OpenCode) into [T3 Code](https://t3.codes) as resumable threads, each under the Claude
account it was run with. It writes a plan first. Then T3 Code's own importer takes the old sessions, while t3sm
moves their file times for a moment: journaled, restored, reversible. How it works:
[docs/architecture.md](docs/architecture.md).

## Stack

TypeScript run directly by Node >= 22.18 (native type stripping), tests with `node:test`, zero runtime
dependencies, MIT. CI: Windows, macOS and Linux with Node 22 and 24.

## Setup and commands

Run from the repository root, with `CLAUDE_CONFIG_DIR` removed from your shell first:
Bash `unset CLAUDE_CONFIG_DIR`, PowerShell `Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue`.

```bash
npm ci                                  # TypeScript and @types/node only; `prepare` also builds dist/
npm run typecheck                       # tsc --noEmit over src/ and test/
npm test                                # every test/**/*.test.ts, about 10 s; live tests skip themselves
node --test test/core/paths.test.ts     # one file
node --test --test-name-pattern="sameCwd" test/core/paths.test.ts   # matching tests in one file
npm run build                           # dist/ (only the installed package runs it)
npm run release:check                   # versions, install pins, repo URLs and CHANGELOG agree; prints OK
npm run assets                          # regenerate docs/assets/*.svg; `git status docs/assets` must stay clean
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, test, build and the release check, plus the assets drift
check. Run all of them before you say a change is done.

Running the CLI from a checkout: `node bin/t3sm.mjs --help` and `--version` are safe as they are. For anything
else, point `T3SM_HOME` at a scratch folder under `.spike/` (git-ignored) so the real state folder is never used:
Bash `T3SM_HOME=$PWD/.spike/state node bin/t3sm.mjs plan`, PowerShell
`$env:T3SM_HOME="$PWD/.spike/state"; node bin/t3sm.mjs plan`.

## Project map

- `bin/t3sm.mjs`, `bin/entry.mjs`: launcher. A checkout runs `src/` directly; an installed package runs `dist/`.
- `src/cli/`: `main.ts` (dispatch, usage text, help per command), `commands/*.ts` (one per command), `errors.ts`
  (error to exit code and user message).
- `src/core/`: `types.ts` (shared types: `HarnessId`, sessions, plan, journal entries, config), `paths.ts` (all
  path identity: `normalizeCwd`, `sameCwd`, Claude folder encoding), `journal.ts` (append-only, fsync'd;
  `recoverPendingMtimes`), `lock.ts`, `fsutil.ts` (`atomicWrite`, `publishNoClobber`), `config.ts`, `activity.ts`
  (the 10-minute and 30-day windows), `glob.ts`, `uuid.ts`, `pid.ts`.
- `src/sources/`: one adapter per agent (`claude`, `codex`, `pi` native; `opencode` convert), `types.ts`
  (`SourceAdapter`, `Env`, adapter errors), `registry.ts`, shared JSONL scanning and discovery cache.
- `src/plan/`: `planner.ts` (one action per session), `ownership.ts` (which account owns a copy or a project),
  `dedupe.ts` (mirror copies), `report.ts` (`plan.md` and summaries).
- `src/apply/`: `apply.ts` (orchestration), `importer.ts` (waves: bump, park, scan, import, restore, verify),
  `waves.ts`, `materialize.ts` and `claudeWriter.ts` (converted transcripts).
- `src/ops/`: `accounts`, `discoverAccounts`, `doctor`, `merge`, `quarantine` (and dedupe), `rollback`, `sync`,
  `watch`, `schedule`, `update` (install kind, the npm release spec; `t3sm update` is the only command that starts npm).
- `src/t3/`: the only way to T3 Code: `runtime.ts` (find the server, loopback check, `t3` CLI), `auth.ts` (session
  tokens), `rpc.ts`, `api.ts`, `decode.ts` (strict response decoders), `compat.ts` (tested versions), `errors.ts`.
- `test/`: mirrors `src/`. Fakes: `test/apply/fake-t3.ts`, `test/ops/helpers.ts`, `test/plan/helpers.ts`. Fixtures
  are generated in code (`test/fixtures/*/generate.ts`, `opencode/build.ts`). `test/safety/`, `test/e2e/` (gated).
- `scripts/release.js` (`--check`, version bump), `scripts/build-assets.js` (all README art, deterministic),
  `scripts/build.js` (`npm run build`: dist/ by stripping types with Node alone; no TypeScript needed, so a global
  install from git works).
- `docs/`: user docs; `docs/spikes/` records measured T3 Code behaviour.
- Shipped in the package: `bin/`, `dist/`, `skills/` (the Claude Code skill), `.claude-plugin/` (its plugin
  manifests), `CHANGELOG.md`. Repository-only: `AGENTS.md`, `CLAUDE.md`, `ROADMAP.md`, `docs/`, `test/`.

## Code rules

- Erasable TypeScript only (`erasableSyntaxOnly`): no `enum`, runtime `namespace`, parameter properties or
  `import x = require()`. Node runs `src/` and `test/` as written, by stripping the types.
- Relative imports end in `.ts` (`import { x } from "./paths.ts"`); the build rewrites them.
- Zero runtime dependencies: Node's standard library only. Dev dependencies stay TypeScript and `@types/node`.
- Inject what touches the world (file system calls, clock `now()`, process env, T3 API, prompts) through a `deps`
  or `Env` object, so tests pass fakes. Pass the platform explicitly (`platform: NodeJS.Platform`) instead of
  reading `process.platform` deep inside; route every path comparison through `src/core/paths.ts`.
- No `any`: use `unknown` and narrow. Decode every external input (T3 responses, transcripts, config) strictly.
- Throw typed errors (`T3NotRunning`, `ShapeError`, `HarnessSchemaError`, `ConfigError`, ...) and map them to exit
  codes in `src/cli/errors.ts`. An adapter reports a bad session in `lastErrors`; it never throws for one session.
- User-facing text is plain English: what happened, then what to do. Show home as `~`, mask emails.

## Safety invariants (never break these)

Each names where it is enforced, then the test that pins it.

1. Journal (fsync'd) before any file-time change; no journal, no change. `src/core/journal.ts` (`Journal`),
   `src/apply/importer.ts` (`runWaves`); `test/apply/importer.test.ts` ("written before any utimes").
2. Restore moved file times in `finally`, on errors and Ctrl+C. `src/apply/importer.ts` (`runWaves`,
   `restoreSync`); `test/apply/importer.test.ts` ("importSessions throws").
3. Every writing command takes the lock, then recovers, before contacting T3 Code. `src/core/lock.ts`
   (`acquireLock`), `src/core/journal.ts` (`recoverPendingMtimes`); `test/core/journal.test.ts`,
   `test/ops/sync.test.ts`.
4. Park with a FUTURE file time, never a past one: Claude Code deletes old transcripts by file time. Files t3sm
   writes are never dated older than 20 days. `src/apply/importer.ts` (`PARK_AHEAD_MS`), `src/apply/materialize.ts`
   (`WRITTEN_MAX_AGE_MS`); `test/apply/importer.test.ts`, `test/apply/materialize.test.ts`.
5. Never bump, park, restore or import a file written in the last 10 minutes, and never move a time back once the
   file changed since t3sm set it. `src/core/activity.ts` (`ACTIVE_WINDOW_MS`), `src/core/journal.ts`
   (`recoverPendingMtimes`); `test/apply/importer.test.ts`, `test/core/journal.test.ts`.
6. Never overwrite, edit or delete a file t3sm did not write. New files and moves are journaled with their hash and
   undone by rollback. `src/core/fsutil.ts` (`publishNoClobber`: link, EEXIST refuses);
   `test/apply/materialize.test.ts`, `test/ops/quarantine.test.ts`, `test/ops/rollback.test.ts`.
7. Never open T3 Code's databases or write its settings file; change T3 Code only through `src/t3/` (`api.ts`:
   its CLI, RPC such as `server.updateSettings`, and HTTP routes); `test/safety/boundaries.test.ts`.
8. Never write into another agent's folder (Codex, Pi, OpenCode). `src/sources/opencode.ts` (`takeSnapshot`: a
   private stripped copy); `test/sources/opencode.test.ts`.
9. Session tokens live in memory only: never logged, printed, persisted or echoed in errors. `src/t3/auth.ts`
   (`issueSessionToken`, `revokeSession`), `src/t3/errors.ts` (`pinSecret`, `redact`); `test/t3/auth.test.ts`.
10. Accept only a loopback T3 Code origin. `src/t3/runtime.ts` (`parseLocalOrigin`); `test/t3/runtime.test.ts`.
11. Child processes never inherit `CLAUDE_CONFIG_DIR`. `src/t3/auth.ts` (`childEnv`), `src/ops/doctor.ts`;
    `test/t3/auth.test.ts`.
12. Writes ask: a writing command on a non-terminal without `--yes` exits 2; `--dry-run` writes nothing.
    `src/cli/commands/*.ts`; `test/cli/ops.test.ts`, `test/apply/dry-run.test.ts`.
13. Unattended `sync` stays conservative: at most `sync.maxUnattendedImports`, no new instances, no pinning, no
    quarantine or dedupe, merges only with `sync.autoMerge`. `src/ops/sync.ts` (`filterForSync`,
    `DEFAULT_MAX_UNATTENDED_IMPORTS`); `test/ops/sync.test.ts`.
14. An unknown T3 Code response shape or untested version aborts (exit 4) before the first write.
    `src/t3/decode.ts` (decoders throw `ShapeError`), `src/t3/compat.ts` (`compatGate`); `test/t3/decode.test.ts`.
15. Never kill processes by image name or pattern (`taskkill /IM node.exe`, `pkill node`): only PIDs you started.

## Testing rules

- Test first: write the failing test, watch it fail, then fix. Every bug fix gets a regression test.
- Use temp folders (`mkdtemp` under `os.tmpdir()`) and the fakes; inject `now()` instead of sleeping. Never read or
  write a real `~/.claude*`, `~/.codex`, Pi or OpenCode folder, or a real T3 Code, from a unit test.
- Fixtures are synthetic: invented text, `C:/work/demo` or `~/code/app` paths, `a***@example.com`. Never paste real
  session content, paths, names or emails into code, fixtures, logs, issues, commits or pull requests.
- Live tests (`test/e2e/*.live.test.ts`) skip unless `T3_E2E=1`; three of the four need Windows. They write
  synthetic files into the real `~/.claude` and the running T3 Code and clean up in `finally`. Run them only when a
  human asks, one file at a time, with `CLAUDE_CONFIG_DIR` removed, never in CI, never against real sessions:
  Bash `T3_E2E=1 node --test --test-timeout=180000 test/e2e/apply.live.test.ts`, PowerShell
  `$env:T3_E2E=1; node --test --test-timeout=180000 test/e2e/apply.live.test.ts`.
  Leftovers after a killed run: see CONTRIBUTING.md.
- A flaky test is a bug: find the race (usually a real clock or timer) and inject it. Never add retries or sleeps
  to make it pass, and never skip it to get green.
- A failing typecheck or test caused by another agent's uncommitted work is not yours: report it, do not fix it.

## Adding a harness

Read [docs/adding-a-harness.md](docs/adding-a-harness.md); `src/sources/opencode.ts` is the reference. In short:

1. A new agent is a convert adapter: `discover()` plus `read()` into a `CanonicalTranscript`.
2. Never change the agent's files, including side effects of reading (SQLite: copy it first).
3. Check the schema on every read; drift raises `HarnessSchemaError`, never a half-converted session.
4. Fixtures are built in code at test time; follow the test checklist in the guide.
5. Register it in `src/sources/registry.ts`, `HarnessId` (`src/core/types.ts`) and doctor's `HARNESS_BIN`;
   update the status tables honestly.

## Docs rules

- English only: `AGENTS.md`, `CLAUDE.md`, `ROADMAP.md`, `CONTRIBUTING.md` and the other contributor docs.
  English and European Portuguese, changed together: `README.md` / `README.pt.md`,
  `docs/switching-from-vscode.md` / `.pt.md`, and every `docs/migrate/*.md` with its `.pt.md` twin.
- Every command or option you show must exist; run it. Status tables say only what was run (live, fixtures,
  planned).
- After changing the art or the CLI's plan summary, run `npm run assets` and commit `docs/assets/`.
- User-visible changes go under `## [Unreleased]` in `CHANGELOG.md`; `npm run release:check` must print OK.

## Commits and pull requests

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`), small and focused, one concern
  each. Stage files by explicit path, never `git add -A`, when other work is in the tree.
- CI must be green (`ci-ok`). Fill in `.github/pull_request_template.md`.

## Ask a human before

- Anything that writes real session data, t3sm's real state folder or a real T3 Code: `apply`, `dedupe`,
  `quarantine`, `merge --all` / `--session`, `rollback`, `doctor --repair`, `accounts --init [--force]`,
  `accounts --apply`, `accounts --rename`, `sync` (without `--dry-run`) and `sync --watch`, `schedule install` /
  `remove`, `projects set` / `unset`, every write step of the guided assistant, and the live tests.
- `t3sm update` without `--dry-run`: it reinstalls the user's global t3sm with npm.
- Pushing, tagging, publishing or running `node scripts/release.js <version>`.
- Changing a safety invariant above, or the tests that pin one.
- Adding a runtime dependency, or any network call beyond T3 Code on loopback.

## Common traps

- **Stale `dist/`**: a checkout runs `src/`; `dist/` matters only for the installed package (`bin/entry.mjs`).
- **`CLAUDE_CONFIG_DIR` in your shell** points `claude` and T3 Code at another account. Remove it before tests and
  never pass it to a child process; open T3 Code from the OS launcher, not from such a shell.
- **Windows `rename` replaces an existing file** (POSIX too). Use `publishNoClobber` for anything not just created.
- **Bash heredocs and `echo` mangle backslashes** in Windows paths: use quoted heredocs (`<<'EOF'`) or an editor.
- **Timing**: file times have coarse resolution on some file systems and the test timeout is 60 s; compare times
  with tolerance as the existing tests do, and never depend on wall-clock speed.
