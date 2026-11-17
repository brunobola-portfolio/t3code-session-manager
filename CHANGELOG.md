# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Each entry follows [docs/changelog-style.md](docs/changelog-style.md).

## [Unreleased]

See what you have with `t3sm stats`, open the plan as a page you can filter with `t3sm plan --html`, and make the
journal smaller with `t3sm journal compact`. Everything new is read-only or asks first, and nothing is sent anywhere.

### Added

- **`t3sm stats` shows what you have.** Sessions per agent, per Claude Code account and per month, plus what t3sm
  imported and converted; read-only, no T3 Code needed, nothing is sent anywhere. `--json` for scripts.
- **`t3sm plan --html` also writes plan.html.** One file to open in a browser, next to plan.md, with filters by
  project, account, action and skip reason and a search box; it loads nothing from the network.
- **`t3sm journal compact` makes journal.jsonl smaller.** It folds runs that ended more than 90 days ago
  (`--older-than <days>`), never one with anything pending, keeps the old journal as a backup next to it, and asks
  first; `--dry-run` shows how much it saves.

## [0.4.1] - 2026-11-16

Every release is now staged on npm with provenance and goes live only after a maintainer approves it with 2FA. The
README shows the version on npm.

### Changed

- **Releases are staged on npm and approved with 2FA.** GitHub Actions builds each one from its tag with provenance,
  through npm's Trusted Publisher and no stored token; `npm audit signatures` verifies what you install.
- **The README shows the version on npm.** A badge links to the package page.

## [0.4.0] - 2026-11-16

t3sm is on npm: `npm install -g t3code-session-manager` installs it without git, and it keeps itself up to date from
there. Installs from GitHub keep working and can move over with `t3sm update --source npm`.

### Added

- **t3sm is published on npm, with provenance.** Each release is built by GitHub Actions from its tag and signed, so
  `npm audit signatures` and the package page show which commit made it.
- **Updates come from where t3sm was installed.** An install from npm updates from the registry, the daily check
  included; `t3sm update --source npm` or `--source github` chooses, and `t3sm update --check` names the source.

### Changed

- **The README and the guides install from npm.** Installing from GitHub or from a checkout stays documented as an
  alternative.

## [0.3.1] - 2026-11-16

Fixes from the first real run of 0.3.0, and a way to bring back a conversation whose T3 Code thread you deleted. If you
ran `t3sm start` with 0.3.0, run it again: the questions come back.

### Added

- **`t3sm recover <id>` brings back a deleted conversation.** For one started in T3 Code whose thread is gone when t3sm
  cannot tell by itself. It asks first, imports a faithful copy, and `t3sm rollback --run <id> --archive-threads`
  undoes it.

### Fixed

- **Your answers in `t3sm start` are saved as you give them.** Before, Enter at the final "Save?" question saved
  nothing, so the import left those conversations out.
- **An upgrade from 0.2 asks the history question again.** A 0.2 `config.json` kept every conversation visible and
  never met the 0.3 rule (90 days, at least 10 per project); it is asked once more, starting from what you had.
- **Changing T3 Code's own auto-settle option works, and is asked in clearer words.** Before, it failed with
  `missing required scope: settings:write`; only the runs that change a T3 Code setting ask for that permission.
- **The minimum per project holds against T3 Code's own auto-settle.** While that option is on, t3sm marks the
  conversations it keeps for the minimum a week before the option could put them away. A mark cannot be undone; see
  `t3sm help history`.
- **`t3sm status` says "keep failing to import" only when it is true.** Conversations the newest plan skips for
  another reason (started in T3 Code, already there, in use) are no longer listed.

## [0.3.0] - 2026-11-15

t3sm 0.3 brings every conversation into T3 Code and keeps it there, each project showing its recent history. The
background sync now updates and restarts itself, and every screen is redesigned, in English or European Portuguese.

### Added

- **Conversations started in T3 Code are recognised.** They are never imported twice, and one whose thread you deleted
  comes back as a faithful copy after your yes (`organize.sessions.orphaned`). See `t3sm help t3-native`.
- **Copies of home-folder conversations follow their original.** Keep working in VS Code or a terminal and
  `t3sm sync` brings the new messages in as a new revision of the thread; `t3sm rollback` undoes it.
- **Each project shows its recent history.** The last 90 days, and at least 10 per project; older conversations move
  to the Settled shelf, oldest first. Choose it in `t3sm start` or with `t3sm organize --history`; see
  `t3sm help history`.
- **Automatic updates.** Once a day the background watcher installs a newer patch or minor release, checks that it
  runs and rolls back if not. `t3sm update` does it by hand and `t3sm changelog` shows what is new; see
  `t3sm help updates`.
- **`t3sm organize` tidies the history it imported.** It archives automated conversations, gives readable titles,
  applies the history rule and pins recent projects, after a preview you can review item by item;
  `t3sm organize --undo` reverts a run.
- **`t3sm status`, help topics and `/t3sm` commands inside T3 Code.** `status` says in one line whether t3sm needs you
  and what to run, `t3sm help <topic>` explains every message, and the plugin adds `/t3sm:status`, `:sync`,
  `:organize` and `:import`.

### Changed

- **Every screen is redesigned, in your language.** English or European Portuguese (`--lang`, or your system's
  language), with tables, panels and progress bars that fit 40 to 200 columns and work without colour or Unicode.
- **The guided set-up (`t3sm start`) now has 11 steps.** It asks what to do with sessions from refused, temporary or
  automated folders, then organizes after the import, each step shown with real numbers before your yes.
- **The background sync looks after itself.** It restarts into a new t3sm after an upgrade, is kept alive every 15
  minutes, follows your decisions and can notify you when it needs you; `t3sm schedule restart` restarts it by hand.
- **Any T3 Code version works.** An untested version prints one warning instead of stopping; only an unknown response
  shape still stops before the first write.

### Fixed

- **Copies from folders T3 Code refuses reach their project.** `t3sm apply` now creates the General folder they go to.
  Also: `/t3sm:sync` no longer fails, Windows file locks are retried, and narrow windows wrap instead of cutting text.

### Security

- **The watcher is stopped through its own authenticated endpoint, never by process name.** t3sm talks only to T3 Code
  on loopback and to its own release source, and strips control characters from any text it shows.

## [0.2.1] - 2026-11-12

Installing from GitHub works on npm 11.

### Fixed

- **`npm install -g` from GitHub works on npm 11.** The build now needs only Node, and the install line adds
  `--install-links` so npm keeps a real copy; CI runs that line on Windows, macOS and Linux.

## [0.2.0] - 2026-11-12

One command to update t3sm, and a shorter help screen.

### Added

- **`t3sm update` updates t3sm in one command.** It asks first and runs npm for you. Coming from 0.1.0, run the README
  install line once; from then on `t3sm update` is enough.

### Changed

- **`t3sm --help` groups the commands by what you want to do.** Each command's own `--help` keeps the full options.
- **The quick start is "install once, then run `t3sm`".** The same on Windows, macOS and Linux; `npx` stays as the
  no-install way.

## [0.1.0] - 2026-11-12

First public release: Claude Code, Codex, Pi and OpenCode sessions in T3 Code as resumable threads, each under its own
Claude account.

### Added

- **`t3sm plan` and `t3sm apply` import your sessions.** The plan is a readable `plan.md`; the import uses T3 Code's own
  importer in waves, beyond its 30-day and 100-session limits, with every file time journaled and restored.
- **Each conversation under the right Claude account.** Accounts are found in `~/.claude*` folders, shell aliases and
  VS Code; `t3sm accounts` and `t3sm projects` show and change which account a project uses.
- **`t3sm start`, a guided assistant.** Short steps from the first check to the background sync, asking before every
  write and saying how to undo it, in English or Portuguese; a Claude Code skill does the same from a chat.
- **`t3sm sync` and `t3sm schedule` keep T3 Code up to date.** Cautious unattended imports (at most 200 per cycle), and
  `t3sm merge` brings work continued in a terminal into its thread.
- **Codex and OpenCode sessions are converted.** Compressed Codex rollouts and OpenCode conversations become Claude
  threads; the agents' own files are never changed.
- **Every change can be undone.** `t3sm runs` and `t3sm rollback` undo a run, `t3sm doctor` checks the set-up and
  repairs file times after a crash, and `dedupe` and `quarantine` move copies aside reversibly.
