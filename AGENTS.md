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
dependencies, MIT. CI: Windows, macOS and Linux with Node 22, 24 and 26 (a pull request runs six of the nine
jobs; main, a weekly run and a manual run, all nine).

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
else, point `T3SM_HOME` at a scratch folder under `.spike/` (git-ignored) so the real state folder is never used,
and point `HOME` and `USERPROFILE` at a scratch home too: `status`, `doctor`, `scan` and discovery read `~/.claude*`
and the other agents' folders from the home folder, so `T3SM_HOME` alone still reads the real ones. Bash
`T3SM_HOME=$PWD/.spike/state HOME=$PWD/.spike/home USERPROFILE=$PWD/.spike/home node bin/t3sm.mjs status`, PowerShell
`$env:T3SM_HOME="$PWD/.spike/state"; $env:HOME="$PWD/.spike/home"; $env:USERPROFILE="$PWD/.spike/home"; node bin/t3sm.mjs status`.
`update --check` looks up releases online: leave it out of manual runs unless a human asks.

## Project map

- `bin/t3sm.mjs`, `bin/entry.mjs`: launcher. A checkout runs `src/` directly; an installed package runs `dist/`.
- `src/cli/`: `main.ts` (dispatch), `help.en.ts` / `help.pt.ts` (the usage and every command's help, styled by
  `helpText.ts`), `helpTopics.ts` (`t3sm help <topic>`: `HELP_TOPICS`, read from `docs/help/` in a checkout and
  `dist/help/` when installed), `flags.ts` (the options each command accepts), `commands/*.ts` (one per command),
  `screen.ts` / `applyScreen.ts` / `failures.ts` / `ui.ts` (the command screens on the UI kit), `errors.ts` (error to
  exit code and user message, drawn as a panel).
- `src/assistant/`: the guided set-up (`t3sm start`): `steps.ts` (the 11 steps, the decisions gate, `resumePoint`),
  `core.ts` (context, questions, step header), `runner.ts`, `deps.ts` (the real dependencies), its own catalogues
  (`messages.en.ts`, `messages.pt.ts`).
- `src/i18n/`: `lang.ts` (the language: English first, Portuguese by `--lang` or the locale; `resolveLang`, `fmt`), the
  commands' catalogues (`messages.en.ts`, `messages.pt.ts`: identical keys), `cli.ts` (`cliT`, `makeCliUi`) and
  `words.ts`; `src/ops/` and `src/plan/` word things through it without importing the CLI.
- `src/ui/`: the terminal kit, zero dependencies: `caps` (colour depth, Unicode, TTY, cursor), `style` (semantic tokens,
  symbols with ASCII fallbacks), `text` (display width, wrapping, truncation), `components` (app and step header,
  panel, kv, table, callout), `layout` (wrapping and list helpers the screens share), `progress` (bar and spinner),
  `list` (the interactive review list), `locale` (numbers, dates, relative times), `terminal`, `organizePreview`.
- `src/core/`: `types.ts` (shared types: `HarnessId`, sessions, plan, journal entries, config), `paths.ts` (all
  path identity: `normalizeCwd`, `sameCwd`, Claude folder encoding), `worktree.ts` (linked git worktrees and their main
  checkout), `journal.ts` (append-only, fsync'd;
  `recoverPendingMtimes`), `compact.ts` (`t3sm journal compact`: drops old runs' file-time entries; backup, then
  rename), `lock.ts`, `fsutil.ts` (`atomicWrite`, `publishNoClobber`), `config.ts`, `activity.ts`
  (the 10-minute and 30-day windows), `glob.ts`, `uuid.ts`, `pid.ts`, `version.ts` (install stamp: what build an install root holds),
  `sysroot.ts` (Windows programs by their absolute System32 path, never a bare name).
- `src/sources/`: one adapter per agent (`claude`, `codex`, `pi` native; `opencode` convert), `types.ts`
  (`SourceAdapter`, `Env`, adapter errors), `registry.ts`, shared JSONL scanning and discovery cache.
- `src/plan/`: `planner.ts` (one action per session), `ownership.ts` (which account owns a copy or a project),
  `dedupe.ts` (mirror copies), `report.ts` (`plan.md` and summaries).
- `src/apply/`: `apply.ts` (orchestration; `applyTypes.ts` its deps and result, `checks.ts` the read-only checks,
  `rehomeFolders.ts`, `projects.ts`, `steps.ts` write-phase helpers), `importer.ts` (waves: bump, park, scan, import,
  restore, verify; `exposure.ts` what T3 Code could import, `budget.ts` its metadata budget, `restore.ts` putting file
  times back, `busy.ts`), `waves.ts`, `materialize.ts` and `claudeWriter.ts` (converted transcripts).
- `src/ops/`: `accounts`, `discoverAccounts`, `doctor` (`doctorCheck` a check and its wording, `doctorChecks`,
  `doctorDeps`), `merge` (`mergeBranch`, `mergeCache`), `revision` (the write, import and swap steps merge and follow
  share), `follow` (rehome copies follow their original), `quarantine` (and dedupe), `rollback` (`rollbackTypes`,
  `rollbackEntries`, `rollbackMerges`, `rollbackInstances`, `rollbackRuns`), `sync`,
  `watch` (the watcher, its single-instance endpoint, token and heartbeat), `watcherControl` (`stopWatcher`: the stop
  request, then a verified pid), `successor` (starting the next watcher), `notify`, `plugin`, `elevated`,
  `watcherHealth` (the watcher's state from its heartbeat: one classification for `status` and `doctor`),
  `syncStatus`, `schedule`, `update` (install kind, the release spec, the git/npm runner), `updater` (the update engine:
  install, restart, health check, rollback), `autoUpdate` (the watcher's daily check; it starts `t3sm update --auto-run`
  in a separate process). `t3sm update` and that child are the only things that start npm.
- `src/t3/`: the only way to T3 Code: `runtime.ts` (find the server, loopback check, `t3` CLI), `auth.ts` (session
  tokens), `rpc.ts`, `api.ts`, `decode.ts` (strict response decoders), `compat.ts` (tested versions), `errors.ts`.
- `test/`: mirrors `src/`. Fakes: `test/apply/fake-t3.ts`, `test/ops/helpers.ts`, `test/plan/helpers.ts`. Fixtures
  are generated in code (`test/fixtures/*/generate.ts`, `opencode/build.ts`). `test/safety/`, `test/e2e/` (gated).
- `scripts/release.js` (`--check`, version bump), `scripts/build-assets.js` (all README art, deterministic),
  `scripts/build.js` (`npm run build`: dist/ by stripping types with Node alone; no TypeScript needed, so a global
  install from git works).
- `src/cloud/`: `t3sm cloud` (user guide: `docs/help/cloud.md`): `client.ts` (the user's `claude` child and its
  control requests), `decode.ts` (strict decoders), `transcript.ts` (cloud entries to a local transcript),
  `checkout.ts` (clone, branch, worktree), `state.ts` (where each session stands), `pull.ts` (preview and the
  journaled write).
- `src/organize/`: `t3sm organize`: `plan.ts` (pure), `history.ts` (the history rule), `sessions.ts`, `titles.ts`, `rename.ts`
  (`projects rename --suggest`), `apply.ts` (apply and undo), `types.ts`.
- `docs/`: user docs; `docs/help/` holds the help topics (`t3sm help <topic>`, English and `.pt.md`, copied into
  `dist/help/` by the build); `docs/spikes/` records measured T3 Code behaviour; `docs/testing-0.3.md` (and `.pt.md`)
  is the owner's hands-on guide to verify the release live.
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
- User-facing text goes through the catalogues (`src/i18n/messages.*.ts`, `src/assistant/messages.*.ts`, the help
  texts): English and European Portuguese with identical keys, plain words, what happened, then what to do. Show home
  as `~`, mask emails. `--json`, `plan.md`, `journal.jsonl` and `logs/sync.log` stay English.

## Safety invariants (never break these)

Each names where it is enforced, then the test that pins it.

1. Journal (fsync'd) before any file-time change; no journal, no change. `src/core/journal.ts` (`Journal`),
   `src/apply/importer.ts` (`runWaves`); `test/apply/importer.test.ts` ("written before any utimes").
2. Restore moved file times in `finally`, on errors and Ctrl+C. `src/apply/importer.ts` (`runWaves`),
   `src/apply/restore.ts` (`restoreAll`, `restoreSync`); `test/apply/importer.test.ts` ("importSessions throws").
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
11. Child processes never inherit `CLAUDE_CONFIG_DIR`. `src/t3/auth.ts` (`childEnv`), `src/ops/doctorDeps.ts`;
    `test/t3/auth.test.ts`. Two children get it set on purpose to one account's own home, never inherited: the
    plugin install (`src/ops/plugin.ts`) and the `claude` child of `t3sm cloud` (`src/cloud/client.ts`,
    `cloudChildEnv`: unset for `~/.claude`), approved by the owner on 2026-11-26; `test/cloud/cloud.test.ts`.
12. Writes ask: a writing command on a non-terminal without `--yes` exits 2; `--dry-run` writes nothing.
    `src/cli/commands/*.ts`; `test/cli/ops.test.ts`, `test/apply/dry-run.test.ts`.
13. Unattended `sync` stays conservative and never asks: at most `sync.maxUnattendedImports`, no new instances, no
    quarantine or dedupe, merges only with `sync.autoMerge`. It organizes only the threads it has just imported
    (archive, title, reopen), writes a copy from a refused folder only to a destination that already exists in T3
    Code, and never creates the General folder or a project for such a copy, never pins or unpins, never deletes a
    project and never changes a T3 Code setting; sessions of an unanswered question wait (`needsAttention`).
    It may follow rehome copies whatever `sync.autoMerge` says (a copy whose original grew, neither file in use, the
    copy untouched since t3sm wrote it: a new revision carrying the old thread's title and settled state, the old
    thread archived only after it, at most `FOLLOWS_PER_CYCLE`; a copy continued itself is a conflict, never written),
    and it applies the history rule to imported threads only (every `import:` thread, whether t3sm or T3 Code's own
    import made it; a conversation started in T3 Code is only ever moved by T3 Code's own auto-settle option), after an
    import to the projects that got new threads and once a day to every project (at most `HISTORY_PER_CYCLE` changes,
    never a thread the user changed by hand; spec §5.1.4 and §5.2). While T3 Code's own auto-settle option is on (read,
    never changed), that daily pass also marks the imported threads the rule keeps for the minimum per project, once
    T3 Code's option could reach them within a week (an unsettle: the "active" override, which T3 Code's option never
    settles; it also sets T3 Code's `unsettledAt`, which moves the thread in the working-shelf sort; a mark cannot be
    undone). The watcher may also, once a day, start the update child (`t3sm update --auto-run --yes`, a
    separate detached process: never inside the watcher) for a newer patch or minor release when `update.auto` is on,
    and restart itself into a new install. Approved by the owner on 2026-11-14 and, for following, the history rule and
    automatic updates, on 2026-11-15. `src/ops/sync.ts` (`filterForSync`, `DEFAULT_MAX_UNATTENDED_IMPORTS`),
    `src/ops/follow.ts` (`followRehomed`), `src/ops/autoUpdate.ts`; `test/ops/sync.test.ts`, `test/ops/follow.test.ts`.
14. Only an unknown T3 Code response shape or an orchestration protocol other than 2 aborts (exit 4) before the first write; an untested version warns once and proceeds.
    `src/t3/decode.ts` (decoders throw `ShapeError`), `src/t3/compat.ts` (`compatGate`); `test/t3/decode.test.ts`.
15. Never kill processes by image name or pattern (`taskkill /IM node.exe`, `pkill node`): only PIDs you started. The
    product stops its watcher the same way: `stopWatcher` asks over the watcher's authenticated endpoint first and
    kills only the heartbeat's pid, and only once that process's command line is a t3sm watcher (`isT3smWatcher`) and
    it started when the heartbeat says (pid reuse guard). `src/ops/watcherControl.ts`;
    `test/ops/watcherControl.test.ts`.

## Testing rules

- Test first: write the failing test, watch it fail, then fix. Every bug fix gets a regression test.
- Use temp folders (`mkdtemp` under `os.tmpdir()`) and the fakes; inject `now()` instead of sleeping. Never read or
  write a real `~/.claude*`, `~/.codex`, Pi or OpenCode folder, or a real T3 Code, from a unit test.
- Fixtures are synthetic: invented text, `C:/work/demo` or `~/code/app` paths, `a***@example.com`. Never paste real
  session content, paths, names or emails into code, fixtures, logs, issues, commits or pull requests.
- Live tests (`test/e2e/live.test.ts`, read-only, and the five `test/e2e/*.live.test.ts`, which need Windows) skip
  unless `T3_E2E=1`. The five write synthetic files into the real `~/.claude` and the running T3 Code and clean up in
  `finally`. Run them only when a
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
  `docs/switching-from-vscode.md` / `.pt.md`, `docs/testing-0.3.md` / `.pt.md`, every help topic `docs/help/*.md`
  with its `.pt.md` twin, and every `docs/migrate/*.md` with its `.pt.md` twin.
- Every command or option you show must exist; run it. Status tables say only what was run (live, fixtures,
  planned).
- After changing the art or the CLI's plan summary, run `npm run assets` and commit `docs/assets/`.
- User-visible changes go under `## [Unreleased]` in `CHANGELOG.md`, in the house style of
  [docs/changelog-style.md](docs/changelog-style.md) (a 2-sentence summary; Keep a Changelog sections in order; short
  bullets that open with a bold headline); `npm run release:check` enforces it and must print OK.

## Commits and pull requests

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`), small and focused, one concern
  each. Stage files by explicit path, never `git add -A`, when other work is in the tree.
- CI must be green (`ci-ok`). Fill in `.github/pull_request_template.md`.
- No tool attribution in pull requests: a PR title or description never says "Generated with Claude Code" (or any
  other tool). It describes the change, nothing else.

## Ask a human before

- Anything that writes real session data, t3sm's real state folder or a real T3 Code: `apply`, `dedupe`,
  `quarantine`, `merge --all` / `--session`, `rollback`, `doctor --repair`, `accounts --init [--force]`,
  `accounts --apply`, `accounts --rename`, `journal compact`, `sync` (without `--dry-run`) and `sync --watch`,
  `schedule install` / `remove` / `restart`, `projects set` / `unset`, every write step of the guided assistant, and
  the live tests.
- `t3sm update` without `--check` or `--dry-run`: it reinstalls the user's global t3sm with npm; `update --auto on|off`
  changes config.json.
- Pushing, tagging, publishing or running `node scripts/release.js <version>`.
- Changing a safety invariant above, or the tests that pin one.
- Adding a runtime dependency, or any network call beyond T3 Code on loopback. The one approved exception
  (2026-11-26): `t3sm cloud` runs the user's `claude` and `git` (clone, fetch), only when the user starts it; the
  watcher and `sync` never do.

## Common traps

- **Stale `dist/`**: a checkout runs `src/`; `dist/` matters only for the installed package (`bin/entry.mjs`).
- **`CLAUDE_CONFIG_DIR` in your shell** points `claude` and T3 Code at another account. Remove it before tests and
  never pass it to a child process; open T3 Code from the OS launcher, not from such a shell.
- **Windows `rename` replaces an existing file** (POSIX too). Use `publishNoClobber` for anything not just created.
- **Bash heredocs and `echo` mangle backslashes** in Windows paths: use quoted heredocs (`<<'EOF'`) or an editor.
- **Timing**: file times have coarse resolution on some file systems and the test timeout is 60 s; compare times
  with tolerance as the existing tests do, and never depend on wall-clock speed.
