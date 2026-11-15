# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-11-15

t3sm 0.3 brings every conversation into T3 Code and keeps it there: the ones you start in T3 Code are recognised, the
ones you deleted there can come back, copies of home-folder conversations follow their original, each project shows
its recent history, the background sync updates and restarts itself, and every screen is redesigned, in English or
European Portuguese.

### Added

- **Sessions started in T3 Code are recognised.** The plan skips a session T3 Code started while its thread is still
  there (active or archived, any account) as already in T3 Code (note `started-in-t3`), and never moves its file time.
  When that thread was deleted, T3 Code refuses to import the session again: after a yes to the new question `orphaned`
  (setting `organize.sessions.orphaned`, `copy` or `skip`, default `copy`) t3sm brings it back as a faithful copy with a
  new session id in the same folder (a folder T3 Code refuses: the rehome target); `skip` keeps it out
  (`orphaned-in-t3`). One whose T3 thread is unknown is skipped as `t3-native-unknown` and never copied, so a live
  conversation is never duplicated. t3sm still never opens T3 Code's database, not even to read.
- **Copied conversations follow their original.** A conversation from a folder T3 Code refuses (the home folder) is in
  T3 Code as a copy inside a project folder. When you keep working on the original outside T3 Code (VS Code, from the
  home folder), `t3sm sync` now brings the new messages in, whatever `sync.autoMerge` says: once the original and the
  copy have been idle for 10 minutes, it writes a new copy of the grown conversation next to the first one, imports it
  as a new thread with the old thread's title and settled state, and only then archives the old thread (T3 Code has no
  way to pin a thread, so a pin is not carried). At most 10 per cycle. A copy that was also continued in T3 Code
  (before or during the import) is left alone and reported as a conflict, with both titles, in `sync`'s summary, in
  `sync-status.json` (titles and session ids only) and in `t3sm status` until you archive the copy's thread in T3 Code;
  a compacted conversation is refused (`compacted`, reported once until it changes); with T3 Code closed it waits for
  the next cycle. `t3sm rollback --run <run>` of the sync run removes the new copy, brings the old thread back and
  archives the new one, and a later cycle does not redo what was rolled back. When a later sync run followed that
  conversation again, roll the later run back first: until then the earlier one is kept whole and the rollback names
  the later run. `sync`'s summary and `logs/sync.log` report it (`followed=`, `follow-conflicts=`, `follow-deferred=`,
  `follow-failed=`).
- **The history rule: each project shows its recent history.** Conversations active in the last 90 days are shown
  inside their project; a project with fewer recent ones still shows its 10 most recent; older ones are settled, so
  they stay in their project on its Settled shelf, oldest first so the shelf keeps the order of your history
  (`organize.history`: `days` 1..3650 or `"all"`, `minPerProject` 0..1000; defaults 90 and 10; the 0.2 values `all`,
  `days:N` and `off` still read). The activity date is T3 Code's own: the newest user message or run, else when the
  conversation was created. Conversations started in T3 Code and pinned ones count toward the 10 but are never moved,
  and a conversation you settled, showed, pinned or archived by hand is left as you set it. A settle is journaled and
  undone like every other organize change (`t3sm organize --undo`).
  - `t3sm organize --history <days|all|off> --min <n>` uses another rule for one run (config.json is not changed).
  - `--auto-settle <1..90|off>` now also sets T3 Code's own auto-settle (for conversations started there) to a number
    of days (before: only off; 0, 91 or a word is refused, exit 2).
  - `t3sm sync` applies the rule once a day to every project and, right after an import, to the projects that got new
    conversations: at most 200 changes per cycle (the rest follows on the next cycles), journaled in the cycle's run
    (`t3sm rollback` undoes it), never moving a conversation you changed by hand, and never changing T3 Code's setting.
  - The guided assistant asks "Show the last 90 days, and at least 10 per project?" (Enter keeps it; n to type other
    days and another minimum), also when the rule would only settle conversations, and says how many would be shown
    and how many settled; then it offers to set T3 Code's own option to the same days (default yes), or, for more
    than 90 days or all, to leave it as it is or turn it off.
- **Automatic updates, and a new `t3sm update`.** Once a day the background watcher looks up the newest release of the
  source t3sm came from (GitHub's `vX.Y.Z` tags, or the tags on `main` of a checkout on this computer): a newer patch
  or minor release (0.x minors included) is installed by itself, in a separate hidden process
  (`t3sm update --auto-run --yes`), with the same stop, restart, 2-minute health check and rollback as by hand; a
  major release is only announced (one notification per version). Offline nothing happens and it tries again an hour
  later; the automatic check never tries a rolled-back version again (`t3sm update` can still install it on purpose); a
  failed or interrupted update shows in `t3sm status` as a need until an update installs, a rolled-back one as worth
  knowing (the previous version runs again). A git checkout or npx is never updated by itself. Looking up the releases
  (`git ls-remote`, or `npm view` when git cannot) is t3sm's only network call; installing a release downloads it with
  npm, and the optional `/t3sm` plugin install goes through `claude plugin` after your yes.
  - `t3sm update` looks up the newest release, shows the change and what is new (from a folder: that tag's CHANGELOG;
    from GitHub: after the install), asks (or needs `--yes`), installs it with a progress line per step, and installs a
    major release only this way.
  - New options: `--check` (read-only: installed, newest, patch/minor/major, source, automatic updates on or off, last
    check, an interrupted update and how to go back; exit 0 offline too), `--from <folder>` (a local checkout,
    remembered once the new version is in; a network folder is refused), `--source github` (back to GitHub),
    `--auto on|off`. `--dry-run` now shows what would be installed instead of the npm command.
  - `update.auto` in `config.json` (`{ "update": { "auto": true } }`, default on).
  - The engine installs only a release strictly newer than the one installed (never a downgrade), restarts the watcher
    into it, waits up to 2 minutes for the new version's heartbeat, reinstalls the previous version if none comes, and
    journals every update. Only a restart that happened counts against the new version: when the old watcher would
    not stop or the scheduler call failed, the update stays installed (the reason in the journal and on screen, never
    skipped) and `t3sm status` shows the watcher's own state. Every update journals its outcome (`update` entries in
    `journal.jsonl`; the source, the previous version and the skipped versions in `<state>/update.json`, an attempt in
    progress in `<state>/update.pending.json`). When the watcher
    starts, an update that was interrupted (t3sm killed mid-way) is journaled and reported.
- **`t3sm changelog [--since <version>]`**: the release notes of the installed version, or of every release after
  `<version>`, from the CHANGELOG.md the package ships, drawn like a help page. Read-only.
- **The background watcher moves to a new t3sm by itself.** Its heartbeat (`<state>/sync-status.json`) now names its
  `version`, install `stamp` and `installRoot`; after every cycle it checks the install again and, when a newer t3sm
  (or a rebuilt one) is there, complete and left alone for 30 seconds, stops cleanly (`stoppedAt`,
  `reason: "restart"`), frees its single-instance endpoint and starts the new one, hidden (`logs/sync.log`:
  `restart from=<old> to=<new>`). On macOS it exits 75 so that launchd starts the new one. Before, an old watcher kept
  running the old code until the next logon. `npm run build` writes `dist/build.json` (`{version, builtAt}`).
  `doctor` and `status` judge the watcher with the same rules: they warn when it still runs another version than the
  one installed after it had a cycle to notice (a 0.2.1 watcher always counts), or when it stopped to restart into a
  new install (by itself, or for an update or `schedule restart`) and no new watcher followed within 20 minutes, and
  say to run `t3sm schedule restart`. A watcher that ended without a clean stop is marked stopped once a stop or
  `schedule remove` / `install` finds it gone, so it is not reported for ever.
- **A 15-minute keep-alive.** `t3sm schedule install --watch` adds a second trigger: every 15 minutes on Windows (Task
  Scheduler) and cron (a `*/15` line next to `@reboot`) a watcher is started if none runs; one already running is left
  alone, and `sync --watch --quiet` then prints nothing. With cron the watcher is also started at once.
- **`t3sm schedule restart`.** Stops and starts the scheduled watcher without reinstalling (exit 2 when nothing is
  installed). `schedule install --watch` now stops the running watcher first, recreates the entry and starts the new
  one; `schedule remove` removes the entry, then stops it too; each of the three exits 1 (with the pid when known) if
  the running watcher could not be stopped. They stop it under the state lock: while a run holds it (a cycle in the
  middle of an import) nothing is stopped or changed ("Another t3sm run is in progress."). A stop request reaches the
  watcher's running cycle like Ctrl+C, so it stops after the current step instead of being killed after 30 s. On
  Windows the watcher is also started directly after `schtasks /Run`, which Task Scheduler can drop while the old
  task instance is still exiting. All three ask first (a
  terminal) or need `--yes`; `--dry-run` shows what would happen and changes nothing.
- **`t3sm status`** says whether t3sm needs you. It leads with one level, "All good", "Needs you (N)" or "Working" (a
  t3sm run is in progress), then lists what needs you first, each with the command that settles it: a background
  watcher that is not running, cannot start (`startup-error` or `socket-dir-unsafe` in `logs/sync.log`), still runs
  an older t3sm after an upgrade, or keeps failing; a `config.json` that cannot be used; an update that failed or
  was interrupted; conversations waiting for your decision (with the count, also from the newest plan);
  conversations that keep failing to import (by reason, with names); rehome copies continued twice (both named:
  continue the one you want in T3 Code and archive the other); copies waiting for a folder; organize changes the last
  organize run could not make. Worth knowing, never a need: an update that was rolled back ("t3sm 0.3.3 was rolled
  back; 0.3.2 is running": t3sm recovered by itself), an update in the last 7 days ("Updated to 0.3.1 yesterday
  - what's new: t3sm changelog"), a newer release (a major one is only announced, never installed by itself), projects
  held while a conversation is in use and since when, conversations started in T3 Code that t3sm leaves out. Then the
  last and next sync, the last organize run, the plugin per account and whether T3 Code is running. Strictly read-only
  (no lock, no write, never connects to T3 Code). It **exits 10 when something needs you** (0 otherwise), and `--json`
  (version 2: `level`, `items`, `watcher.version`/`stale`, `update`, `runInProgress`, ...) prints the same with stable
  keys.
- **`t3sm help [<topic>]`**: what a message means, why it happens and what to do, with the exact commands, in English
  or European Portuguese. `t3sm help` lists the topics (`not-imported`, `t3-native`, `orphaned`, `held`, `decisions`,
  `history`, `updates`, `watcher`, `cwd-unreadable`, `instance-unavailable`, `project-mismatch`, `convert`,
  `errors`); every screen that shows a problem names its topic, and `t3sm help <command>` is the same as
  `t3sm <command> --help`. The topics ship with t3sm (`dist/help/`), so they match the installed version;
  `docs/troubleshooting.md` is now their index.
- **Global `--lang en|pt` and `--no-color`**, on every command, anywhere on the command line.
- **`t3sm organize`** tidies the history t3sm imported into T3 Code. It shows one line per kind of change (how many,
  why, how to undo) and one before/after table per project, then asks: archive automated conversations (Agent SDK) and
  those of a project t3sm created in a temp or system folder, give conversations whose title is a technical first
  message a readable one, apply the history rule, pin the projects with the most recent activity
  (`organize.pinRecent`), and delete empty projects t3sm created (never one created in the last 24 hours, nor one
  whose conversations still wait to import because one was in use). It only touches imported conversations and
  projects t3sm created (pinning aside), never a conversation started in T3 Code, and never anything you changed in T3
  Code after t3sm did. `--dry-run` writes nothing, `--only <folder>` limits it to one project, `--no-archive-folders`
  leaves the conversations of projects t3sm created in temporary or system folders unarchived, `--no-delete` keeps the
  empty projects, `--no-pin <ids>` never pins the named projects. Every change is journaled. Ctrl+C, a kill (SIGTERM)
  or closing the terminal stops it after the change in progress (exit 130); what was done is journaled and can be
  undone, and running it again continues.
- **Interactive review list.** On a terminal, `t3sm organize` also offers `d` (details) at its question: the planned
  changes as a list grouped by kind, moved through with the arrow keys (`j`/`k`, PgUp/PgDn), Space to uncheck, `/` to
  filter, `a`/`n` for all/none, `?` for help, Enter to confirm, Esc to go back. Unchecked changes are not applied. It
  falls back to plain output without a terminal or with `--plain`, and draws no colour with `NO_COLOR`.
- **`t3sm organize --undo [<run>]`** reverts an organize run: without a run id it offers the newest one and asks (with
  `--yes` the run id is required). It lists each change by the conversation's or project's title. Only what T3 Code
  still shows as t3sm left it goes back, and a deleted empty project is re-created. A run that also imported
  conversations (a `sync` that organized what it imported) is refused with exit 2 and the hint to use
  `t3sm rollback --run <run>`, which undoes all of it. `t3sm rollback --run <run>` also reverts organize runs, exactly
  as `--undo` does, and `t3sm runs` counts the organize changes of each run (`organized N`) and what an undo reverted
  (`reverted N`).
- **`t3sm projects rename --suggest`** proposes clean names (`parent/name` for generic folders such as `src`, the name
  length limit, a parent folder when the name is taken) for the projects t3sm created whose title is still the one
  t3sm gave them, shows each before -> after and asks. Journaled like organize: `t3sm organize --undo <run>` puts the
  old titles back. `apply` now journals the title it gives each project it creates.
- **The guided assistant (`t3sm start`) has two new steps, now 11 in all.** *Decisions* asks what to do with the
  sessions the plan holds back (home folder and other refused folders, temporary and system folders, automated
  sessions, sessions whose T3 Code thread was deleted): one panel per question with the real numbers, the default, why,
  and the `config.json` key to change it later. Your answers (and, for conversations copied into other projects, any
  destination you change or leave out, saved as `organize.overrides`) are written to `config.json` only after a yes.
  The decisions are a gate: whenever a step has a fresh plan with new questions, the assistant asks them first ("2 new
  questions before the import") and comes back. *Organize* comes after the full import: the per-project before/after
  table, one question per part, T3 Code's own option, and a final "Here is what I will do" before it runs
  `t3sm organize --yes`.
- **`/t3sm:status`, `/t3sm:sync`, `/t3sm:organize` and `/t3sm:import` inside T3 Code.** The `t3sm` Claude Code plugin
  now ships these four commands (in `commands/`); T3 Code shows them in its "/" menu. Each runs the read-only form first
  (`status`, `sync --dry-run`, `organize --dry-run`, `plan`), shows it, and writes only after you say yes. They run t3sm
  with `CLAUDE_CONFIG_DIR` removed. `/t3sm:sync` and `/t3sm:import` explain that the conversation running them is
  "in use", so its own project waits for the next cycle (run them from the General project to include it);
  `/t3sm:organize` has no such hold and says it may retitle that conversation or show it inside its project. `t3sm
  doctor` has a new `t3sm-plugin` check and `t3sm status` a "t3sm plugin" line per Claude account (installed, missing
  or outdated; read-only). The last step of `t3sm start` offers, per account that lacks it and only after a yes
  (default no), to install it with `claude plugin marketplace add` and `claude plugin install`, run for that account
  only with its own `CLAUDE_CONFIG_DIR`; the offer says how to remove it
  (`claude plugin uninstall t3sm@t3code-session-manager`). `npm run release:check` verifies the command files.
- **Optional system notifications** (`notify` in the config: `attention` by default, `all`, or `off`). When `sync`
  needs you (undecided questions, an account signed out, over the unattended limit, repeated failures, an incompatible
  T3 Code, a failed update), the watcher and the scheduled `sync --quiet` raise one operating-system notification per
  reason per 24 hours (`lastNotified` in `sync-status.json`); `all` also announces what an import brought in. Text
  holds counts and project names only, never conversation text, in your language; nothing is sent during `--dry-run`.
- **A warning in a shell run as Administrator** (Windows): `t3sm start` (the schedule and the /t3sm commands),
  `t3sm schedule` (the scheduled sync) and `t3sm update` (t3sm itself, with that user's npm) say once that what they
  install is for that user only. Nothing is blocked.
- **`--verbose` on `apply` and `sync`**: one line per import wave, as before 0.3, above the progress bar.

### Changed

- **Every screen is redesigned, in your language.** English is the default; t3sm speaks European Portuguese on a
  Portuguese system. Without `--lang`, it uses `T3SM_LANG`, then config.json `"language"`, then the system's language
  (`LC_ALL`, `LC_MESSAGES`, `LANG`, then the operating system's locale), else English; saving the language in
  `t3sm start` applies to every command. `--json`, `plan.md`, the journal and `logs/sync.log` stay English. Every
  confirmation asks in your language (`Escreve sim para continuar`: `sim` or `s` goes ahead; in the assistant
  `[S/n/?/v/q]`, English keeping `[Y/n/?/b/q]`). Without a `"language"` in config.json, a new General folder follows
  the system's language (`~/T3 Geral` on a Portuguese system); one that already exists in T3 Code is kept.
  - Usage errors, refusals (`--yes` needed), "no plan yet", the run's notices and doctor's findings in `t3sm start`
    come in your language too; reasons, sources and states are words ("latest session", "signed in"), never internal
    codes, and dates are local ("15/11 às 11:56"), never raw ISO or log lines (`schedule status`, `update --check`).
    Portuguese names T3 Code's shelf as T3 Code does: "Settled" ("passar para Settled"); "Arrumar" is only organize.
  - `t3sm status`: one line ("✓ All good", "! Needs you (3)", "● Working"), each item as a callout with its command,
    then the details aligned.
  - `t3sm doctor`: a table of checks (each named in words), every problem in full with what to do, and the verdict in
    a panel; `doctor --json` keeps the English `message` and `fix` and gains an optional `data` field on the checks a
    screen words itself (`merge-pending`, `harness:<agent>`).
  - `plan` (and `apply` before it asks): a panel with the counts aligned, the imports by account and the top skip
    reasons in words; `plan.md` is unchanged.
  - `apply` and `sync`: one progress bar ("Importing 5 conversations · 4 projects", with rate and time left) instead
    of a line per wave, and a result panel (what was imported, what waits, the run and how to undo it). Conversations
    that could not be imported are a table (a list under 100 columns, so nothing is cut): project, conversation (its
    title, never its id), why in words (never a code such as `not-imported`) and what to do, then the
    `t3sm help <topic>` that explains the reason. `sync --quiet` and `sync --watch` still draw no progress.
  - `organize`: one before/after table per project (shown now -> after, settled, retitled, archived) instead of two
    columns side by side, the history rule in words and a progress bar instead of a line every 500 changes.
  - `projects`, `accounts`, `runs`, `rollback`, `merge`, `quarantine` and `dedupe`, `schedule`, `update`, `changelog`
    and `scan` use the same tables, aligned rows, warnings with their command and short summaries. A table that would
    cut a column on a narrow window becomes one block per row instead; paths show your home folder as `~`.
  - `--help` for `t3sm` and every command is drawn by one renderer, in both languages: the usage forms, the options as
    a two-column list, the examples and the global options. Every option a help text shows is one its command accepts
    (a test checks it).
  - Errors are a panel: what happened, what to do and the command that helps; exit codes are unchanged.
  - Every screen fits widths from 40 to 200 columns, works without colour (`NO_COLOR`, `--no-color`, pipes,
    `TERM=dumb`) and without Unicode (ASCII symbols), and never relies on colour alone. Panels and warnings never cut
    their title (a long one wraps at a word), and aligned rows stack only the row whose value cannot fit beside its
    label. Progress text folds line and paragraph separators and other invisible characters to a space, and keeps
    emoji joined by a zero-width joiner whole.
- **The guided assistant (`t3sm start`) is redesigned.** Every step starts with a rail of the 11 steps ("Step 3 of 11 ·
  Accounts"); the welcome shows the version and how many Claude accounts t3sm knows. A returning user sees a checklist
  of the steps (✓ done, ◉ next, ○ later), what happened last time and where it continues. The check lists every check
  in a compact grid and keeps "Worth knowing" for what concerns you (the warning that T3 Code has no Pi or Codex
  instance only when the plan would skip such sessions, with how many). Accounts, projects and the pilot's suggestions
  are tables; the plan, each decision and "Here is what I will do" are panels; the import shows the command's own
  progress bar, then its result and the conversations that could not be imported. It never says "All done" while
  projects wait: it says how many wait, counted from the import's own run (the journal's `run-end` now records `held`,
  and `t3sm runs --json` shows it). The last screen is one panel: what changed, how to undo it, what happens next. All
  its text is rewritten in English and European Portuguese.
- **t3sm works with any T3 Code version.** A version t3sm was not tested with no longer stops the command (exit 4): it
  prints one warning (`Warning: T3 Code <version> has not been tested with t3sm ... every change is journaled and can
  be undone with t3sm rollback.`) and proceeds. `--allow-untested` is still accepted and only hides the warning;
  `doctor` reports `t3-version` as a warning for any untested version, and the guided assistant no longer asks before
  continuing. A changed response shape (strict decoding) or a server on another orchestration protocol still stops
  with exit 4. T3 Code `0.1.10-nightly.20261113.4630` is now in the tested list.
- **The plan sorts sessions by folder and kind.** Conversations in the home folder or in another folder T3 Code
  refuses (Downloads, Documents/Codex, T3 Code's own) are never planned as a plain import any more: they go, as a copy,
  to the project they worked in (or a "General" project, `~/T3 General`), or are skipped. Sessions in temporary or
  system folders and automated (Agent SDK) sessions are skipped by default. Until you answer these questions
  (`t3sm start`), such sessions are skipped as `undecided`; `plan.md` lists them under "Decisions pending", and
  `organize.overrides` in config.json can import, skip or move one folder (an override never imports an automated
  session: `organize.sessions.automated` decides those). Projects in ordinary folders are planned as before.
- **Claude conversations from refused folders are copied whole.** `apply` writes the copy into the target project's
  folder of the same account: every record kept as it is (tools, thinking, titles), only the working folder and the
  session id changed, plus a provenance record linking it to the original, which is never modified. It is journaled
  first and removed by `t3sm rollback` while untouched. A conversation still in use waits for the next run; until the
  copy is imported, a copy t3sm wrote is refreshed in place when the original grows (never a second copy). Once in T3
  Code, the copy follows its original through `t3sm sync` (see Added); `t3sm merge` lists such a conversation as
  skipped (`rehomed-copy`) instead of offering it.
- **`sync` honours your decisions and organizes what it imports**, still without asking anything. Sessions of a
  category you have not decided yet are not imported; `sync-status.json` gains `needsAttention` (reason, the command
  to run, since when, and the numbers behind it in `facts`), `undecided` and `heldRehome`, and an over-the-limit cycle
  says so there too instead of only in the log. After an import it archives, retitles and reopens only the threads it
  just imported (in the same run, so `t3sm rollback <run>` undoes both). It writes a copy from a refused folder only
  into a destination that already exists in T3 Code, and never creates the General folder, pins, deletes a project or
  changes a T3 Code setting. A new project folder is still created, with its clean name.
- **A project held because a conversation is in use no longer looks lost.** `apply` and `sync` create its project
  right away (empty, with its default account; creating a project imports nothing) and say what holds it:
  `demo waits: 'Fix the build' is in use (written 3 min ago); imported after 10 minutes idle`. Its sessions still wait until
  the conversation has been idle for 10 minutes. `apply --dry-run` lists the same under "held (in use)", and
  `sync-status.json` keeps the held projects for `t3sm status`; the sync log only counts them (`held-projects=N`).
- **Undo lines name the run the way `t3sm rollback` accepts it.** The result of `apply` and `sync` said
  `t3sm rollback <id>`, which the command refuses; it now says `t3sm rollback --run <id> --archive-threads`, the same
  undo the guided assistant gives.
- **Docs, in English and European Portuguese.** The README (`README.pt.md`) gains the history rule, automatic updates
  and the one network call, the new screens (`docs/assets/screen-*.svg`, light, dark and narrow, drawn by t3sm's own
  renderers on synthetic data) and the organize picture; `docs/install.md` covers installing from a folder, upgrading
  from 0.2.x, updates and uninstalling; `docs/configuration.md` the history rule, `update.auto` and the language order;
  `docs/architecture.md` the sessions started in T3 Code, the watcher lifecycle, the stop protocol and the update
  engine; the switching guide and the Claude Code migration guide follow; `docs/testing-0.3.md` (and `.pt.md`) is a
  hands-on guide to verify this release on your own machine.

### Fixed

- **`/t3sm:sync` ran `t3sm sync --yes`, which `sync` refuses (exit 2).** The command file and the skill now run
  `t3sm sync`, the unattended command that never asks, after the user's yes.
- **`t3sm apply` creates the General folder.** Conversations copied from a folder T3 Code refuses go to the General
  folder (`~/T3 General` / `~/T3 Geral`) or to a `rehome:<folder>` override's folder, but nothing created that folder,
  so their project could not be made. An interactive `apply` now creates a missing destination folder before writing
  the copies, journals it, and `rollback` removes it again while it is empty. A folder T3 Code refuses, a temporary or
  system folder, or one that cannot be created is reported (`cannot create <folder>: <reason>`) and fails only its own
  conversations; so is a relative folder. A folder whose project T3 Code already has but that is gone is created
  again. `apply --dry-run` and the confirmation list the folders a run would create. `sync` still never creates one.
- **`rehome:<folder>` overrides and `organize.generalFolder` are checked.** `config.json` rejects one that is not
  absolute or that names a folder T3 Code refuses; the plan skips, with a warning, the sessions of one that names a
  temporary or system folder.
- **A newer T3 Code's organize values no longer stop every command.** A thread settle state t3sm does not know, or an
  auto-settle value outside 1..90, used to fail the strict response check (exit 4) for imports and sync too. They are
  now read as unknown: organize leaves such a thread, and that setting, alone; everything else works as before.
- **A converted conversation is refreshed even while Windows scans it.** Refreshing a converted transcript t3sm wrote
  earlier failed (`write-failed: EPERM`) when the file was still open for a moment (t3sm's own hash of it, an antivirus
  scan or the search indexer). That refusal is now retried for about 5 s, like t3sm's other atomic writes, and the file
  is checked again before each attempt: one resumed meanwhile is still left alone.
- **A timed-out `t3` CLI call ends its whole process tree on a busy Windows machine.** `taskkill` gets 30 s instead of
  5 s: on a loaded machine it took over 8 s, was stopped first, and left the CLI's child process running.
- **Lock: no steal mutex left behind.** When two t3sm runs recovered a crashed run's lock at the same moment, the one
  that lost could put the winner's `lock.steal` back just after the winner had released it. Nothing was ever run twice,
  but the leftover file made a later recovery wait up to 30 s. Releasing now also removes a copy of its mutex that
  another run has moved aside.
- **The plan note for a copy continued outside T3 Code** no longer says it came from a folder T3 Code refuses when it
  is the copy of a conversation deleted in T3 Code.
- **A watcher left behind after an upgrade.** Upgrading t3sm used to leave the old watcher running the old code until
  the next logon, with no safe way to stop it. It now restarts itself into the new install, and
  `t3sm schedule install --watch`, `restart` and `remove` stop it safely (see Security).
- **Account names, masked.** `t3sm scan` and the doctor checks of the Claude accounts and the t3sm plugin name each
  account by its display name instead of its id (two accounts with the same name get their id after it). A display
  name that holds an email address is masked wherever t3sm shows it (screens, `--json`, `plan.md`), the way emails
  are (`d***@example.com`); `t3sm accounts --show-emails` shows it whole, like the emails.
- **`t3sm schedule status`** words the watcher's restart, an update, the daily update check and a start-up stop
  ("the watcher restarted into t3sm 0.3.1") instead of printing the log's raw word; the row is "Last logged".
- **Error panels** keep the lines of the message (a `config.json` error lists one problem per line, then the hint),
  without Markdown backticks.
- **In Portuguese**, why `t3sm rollback` kept a merge, skipped a default or left a thread for review, and why
  `t3sm accounts --apply` left an account out, are worded in Portuguese; following a copy is "seguir" everywhere.
  Paths inside those reasons show the home folder as `~`.
- **Narrow windows:** a command wider than the line wraps at its own spaces instead of being cut inside a run or
  session id; the note of the status and check headlines wraps below instead of being cut; a panel title made of
  parts ("Plan … · T3 Code 0.1.9") breaks between them.
- **`t3sm start`:** `b` at the first question of the decisions, when a later step sent you there, goes back to the
  step shown before instead of bouncing straight back into the same question.

### Security

- **The watcher is stopped by its own authenticated endpoint, never by name.** A stop request carries a random token
  the running watcher wrote to `<state>/watcher.token` (owner-only). Only when that is not answered (a 0.2.1 watcher, a
  hung one) is the heartbeat's process killed, and only after its command line proves it is a t3sm watcher
  (`node ... t3sm sync ... --watch`) and it started when the heartbeat says (a reused pid is never killed). t3sm never
  kills a process by image name or pattern. A socket in an unsafe or foreign directory is neither asked nor believed.
- **One network call, said plainly.** t3sm contacts T3 Code on loopback only, plus the release lookup
  (`git ls-remote` / `npm view` of its own repository) for updates; installing a release downloads it with npm, and the
  optional `/t3sm` plugin install goes through `claude plugin` after your yes. An update installs only a strictly newer
  `vX.Y.Z` release of the remembered source, from GitHub or from a local folder (a network path is refused), through
  npm and git called with argument arrays, a time limit, no `CLAUDE_CONFIG_DIR` and no git prompt.
- **Text read from t3sm's own files is shown without control characters** (`t3sm status`, progress text), so a crafted
  title or path cannot move the cursor or rewrite the terminal; a version that is not a release version is shown as
  unknown.
- **Notifications and status hold counts, project names and titles only**, never conversation text; `sync-status.json`
  and the logs stay free of session content.

### Known limits

- `SETTLE_BACKDATE` is off: T3 Code dates a settle when it happens, so the Settled shelf shows when t3sm settled a
  conversation, not its real age; t3sm settles oldest first so the order still follows your history. The live spike
  that would turn it on (S8, `test/e2e/followup.live.test.ts`) has not been run yet.
- `FOLLOW_MODE` is `revision`: a copy that follows its original becomes a new thread (the old one is archived) rather
  than growing in place, until the same spike (S7) shows T3 Code can grow a thread.
- Automatic updates were tested with unit tests and fakes; the live update, restart and rollback cycle on a real
  machine is described in `docs/testing-0.3.md`.

## [0.2.1] - 2026-11-12

### Fixed

- **`npm install -g github:…` works on npm 11.** npm prepares a git dependency with an inner `npm install` that
  inherits global mode, so the clone never got TypeScript and the build failed (`'tsc' is not recognized`); and even a
  successful global install from git was left as a link to npm's temporary clone, which npm then deletes. The build
  now needs only Node (`scripts/build.js` strips the types with `node:module`), and the install line, `t3sm update`
  and the release notes add `--install-links`, so npm copies the package. CI now runs the README install line on
  Windows, macOS and Linux.

## [0.2.0] - 2026-11-12

### Added

- **`t3sm update`**: updates an npm-installed t3sm to the newest release in one command. It asks first, waits while
  another t3sm run is in progress, runs `npm install -g github:<repository>#semver:*` (npm fetches the release; t3sm
  itself contacts nothing and never checks for updates on its own), prints the old and new versions, and says when
  the background sync needs `t3sm schedule install` again. In a git checkout or from npx it only explains how to
  update. `--dry-run` prints the npm command. Coming from 0.1.0, which has no `update`: run the install line from the
  README once; from then on `t3sm update` is enough.

### Changed

- **`t3sm --help`** groups the commands by what you want to do (start, import, accounts and projects, keep in sync,
  clean up and undo, maintenance) with one short line each; every command's own `--help` keeps the full options.
- **Docs**: the quick start is now "install once, then run `t3sm`", the same on Windows, macOS and Linux; the step-by-step
  commands use the short `t3sm` form, and `npx` stays as the no-install alternative.

## [0.1.0] - 2026-11-12

First public release.

### Added

- **`t3sm doctor`**: checks Node, the state folder, `config.json`, the lock, interrupted runs, the shell's
  `CLAUDE_CONFIG_DIR`, T3 Code (running, version, CLI, a read-only session), its Claude instances and the account each
  is signed in to (emails masked), whether T3 Code's default instance has an explicit home, undiscovered accounts,
  backup and quarantine folders, transcripts left with a future file time, each agent and the background sync.
  `--repair` restores file times left by an interrupted run.
- **`t3sm scan`** and **`t3sm plan`**: inventory of Claude Code, Codex, Pi and OpenCode sessions, and an import plan
  with a readable `plan.md` (summary, accounts, projects to create, the Project accounts table, duplicates across
  accounts, warnings, every skip with its reason, residual limits). Besides the report, only `config.json` (on the
  first run) and a discovery cache are written, all in t3sm's own folder.
- **`t3sm apply`**: creates missing instances and projects, sets per-project default accounts, converts OpenCode
  sessions, and imports through T3 Code's own importer in waves, beyond its 30-day window and 100-per-call limit.
  File times are journaled before they move, parked transcripts go 7 days into the future, a wave stops when the
  clock jumps (sleep), a locked file holds only its project, everything is restored after each wave and after a
  crash. T3 Code's default Claude instance is pinned to `~/.claude` when its settings name no folder. `--only <folder>` for a pilot; `--dry-run` runs every check and prints
  what would be done, writing nothing.
- **Accounts**: discovery from `~/.claude*` folders, shell aliases and functions (PowerShell, bash, zsh, fish), VS Code
  pins, the current shell and T3 Code instances; ownership by account folder, duplicates resolved by content,
  project defaults by route, VS Code pin, recent activity or default. `t3sm accounts` (emails masked,
  `--show-emails`; `--init`, `--apply`, `--rename`). In `config.json` only `version`, `accounts` and `defaultAccount`
  are required; every other key has a default.
- **`t3sm dedupe`** and **`t3sm quarantine`**: move mirror copies and `.bak` folders to a reversible quarantine with
  hard links (never copy-and-delete, never over an existing file).
- **`t3sm sync`**, **`sync --watch`** and **`t3sm schedule`**: unattended, cautious incremental imports (never more
  than 200 sessions per cycle by default) from Task Scheduler, a LaunchAgent or cron, or a watcher started at logon.
- **`t3sm merge`**: brings work continued in a terminal into T3 Code as a new thread from a new session file and
  archives the old thread, on positive evidence only; compacted sessions are skipped, and terminal work on a side
  branch is listed, never merged. `sync` reports both; merging in `sync` is off by default (`sync.autoMerge`).
- **`t3sm runs`** and **`t3sm rollback`**: undo a run (converted files, merges, quarantines, project defaults;
  imported threads listed or archived with `--archive-threads`); `--yes` requires `--run <id>`. A rollback never leaves a session without an
  active thread.
- **OpenCode** conversion (tested with 1.19.5), reading a stripped private copy of its database.
- A **Claude Code skill** (`t3code-sessions`) and plugin marketplace that run t3sm and ask before every write.
- Docs: switching guide from VS Code (English and Portuguese), migration guides per source, configuration
  reference, accounts, architecture, troubleshooting per doctor check, adding a harness.
- **`t3sm start`**: a guided assistant for people who would rather not learn the commands (also plain `t3sm` on a
  terminal). Nine short steps (check, accounts with optional names and colours, plan and the project-to-account table
  with a way to change a project's account, clean-up, a pilot import of one project with an offer to undo it, the
  full import, background sync, a summary with run ids). It only runs t3sm's own commands, asks before every write
  (Enter means no), and `?`, `b` and `q` work at every question. Each write question says how to undo that change,
  and every exit after a write lists what was done, with run ids and how to undo each. A step whose command found
  another t3sm run holding the lock (a background sync) is reported as not done, never with the other run's id. It
  resumes where you stopped (a partial or interrupted full import, a pilot still to check, a clean-up half done),
  worked out from the journal, plan, config and scheduler. English by default; Portuguese with `--lang pt`, `T3SM_LANG=pt` or
  `"language": "pt"` in `config.json` (new optional key). Only the assistant is translated. Not on a terminal it
  prints the quick start. At any confirmation prompt, Ctrl+C or closed input now answers "no" instead of ending with
  an error. Every message now spells "T3 Code" the same way.
- **`t3sm projects`**: every project folder with its account, the reason (route, VS Code pin, recent activity,
  default), the sessions waiting, whether it is in T3 Code and whether a session is in use; with T3 Code closed it
  shows what the machine knows and says so. `projects set "<folder>" <account>` writes an exact-folder route (in place,
  or right before the first wildcard route matching the folder, so no other folder's account changes) and, when the folder is already a T3 Code project, sets its default account there
  (journaled, undone by `t3sm rollback --run <id>`); `projects unset "<folder>"` removes the route. The folder always
  ends on the account asked for (a route of its own in another spelling, or shadowed by an earlier wildcard, is
  rewritten and moved); a folder whose name contains `*` or `?` is refused.
- **Codex compressed sessions**: rollouts Codex CLI 0.167+ compressed to `rollout-*.jsonl.zst`, which T3 Code cannot
  read, are decompressed in memory (Node's built-in zstd; Codex's files are never changed), converted with the same
  message rules as T3 Code's Codex importer (tool calls as one-line summaries, reasoning left out) and imported as
  Claude threads in the project's account. A session T3 Code already holds as a Codex thread stays that one thread
  once Codex compresses it (and a converted one is not imported again as a Codex thread). Sessions over 512 MiB
  decompressed, or with a line over 64 MiB, are skipped (`too-large`); every zstd frame is decoded and must be complete,
  so corrupt or cut-short files are read errors, never partial conversions. A second file of the same session is listed
  as `duplicate` (a plain `.jsonl` wins; among compressed copies the parent rollout). `config.json`
  `codex.convertCompressed` (default `true`) turns it off. `plan.md` says how many are converted; `doctor`
  (`harness:codex`) counts sessions importable natively, convertible, skipped, read errors and already in T3 Code.
  Verified with fixtures, read-only discovery of 108 real compressed files and one synthetic compressed session
  converted and imported live.

### Known limits

- T3 Code shows at most 200 visible messages per imported thread, without tool activity, with the import time as the
  last activity.
- Compressed Codex sessions and OpenCode sessions are converted, so they continue as Claude threads, not in their
  original agent. Plain (uncompressed) Codex imports and Pi imports were not run live.
- Tested live: T3 Code `0.1.9-nightly.20261110` and `0.1.9-nightly.20261111` on Windows 11. `0.1.8` is supported from
  reading its source; stable releases are not tested yet. macOS and Linux are covered by unit tests in CI only.
- No full-size `apply` has been timed yet; first-run figures will be added here after the pilot.
- Roadmap: the largest modules (merge, rollback, apply, doctor, importer, the OpenCode adapter, sync) are to be split
  after 0.1.0; journal compaction; OneDrive conflict-copy handling.
