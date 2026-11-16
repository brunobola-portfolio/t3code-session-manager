# Install

## Requirements

- **Node.js 22.18 or newer** (`node --version`). t3sm has no runtime dependencies.
- **git** on `PATH`, only to install from GitHub or from a checkout (npm then clones the repository and builds it).
- **T3 Code** ([t3.codes](https://t3.codes), open source), installed and opened at least once, running whenever t3sm talks to it. Open it from the Start menu or
  your desktop launcher, never from a terminal that sets `CLAUDE_CONFIG_DIR` (it would read that folder as its
  default account; `t3sm doctor` checks this).
- The agents whose history you want to bring in, with their sessions where they normally keep them
  ([harnesses.md](harnesses.md)). t3sm needs no login of its own and never calls a model.
- For `dedupe`, `quarantine` and conversions: a file system with hard links for the account folders and the state
  folder (NTFS, APFS, ext4 and the like; not exFAT/FAT32).

Tested on Windows 11. macOS and Linux run the unit tests in CI; see [harnesses.md](harnesses.md) for what was verified
where.

## Install the `t3sm` command (recommended)

One line, the same on Windows, macOS and Linux:

```bash
npm install -g t3code-session-manager
t3sm
```

npm downloads the release from the registry and puts `t3sm` on your `PATH`. Plain `t3sm` starts the guided set-up;
`t3sm --help` lists every command, grouped by what you want to do. The background sync (`t3sm schedule install`) needs
this installed command, because it must stay where it is. CI installs the exact package the registry gets (`npm pack`)
on Windows, macOS and Linux.

Every release on npm is published by the GitHub Actions workflow of its `vX.Y.Z` tag, with
[provenance](https://docs.npmjs.com/generating-provenance-statements): `npm audit signatures` (run in a folder that
depends on it) or the package page on npmjs.com shows which commit and workflow built it.

### From GitHub instead

```bash
npm install -g --install-links github:brunobola-portfolio/t3code-session-manager#v0.3.1
```

npm clones the release (the `#v…` suffix is npm's syntax for a git tag) and builds it with Node alone (no TypeScript
download). Keep `--install-links`: without it, npm 11 leaves a global install from git as a link to its own temporary
clone, which it then deletes, so `t3sm` is not found afterwards. CI runs this exact line too. An install from GitHub
keeps updating from GitHub; `t3sm update --source npm` moves it to the registry.

## Install from a folder on this computer

To install a checkout you have locally (a release not on GitHub yet, or your own build), install its release tag
with npm. Make sure the checkout is clean and at the tag first:

```powershell
git -C D:\Work\t3code-session-manager status --short                  # prints nothing: no local changes
git -C D:\Work\t3code-session-manager describe --tags --exact-match   # prints the tag, such as v0.3.0
npm install -g --install-links D:\Work\t3code-session-manager
t3sm --version
```

npm runs the package's own build (`prepare`, which writes `dist/` inside the checkout; `dist/` is git-ignored) and
copies the result into its global folder. Once t3sm is installed, later releases from that folder are one command:
`t3sm update --from D:\Work\t3code-session-manager` installs the newest `vX.Y.Z` tag on its `main` and remembers the
folder, so the background watcher follows it from then on (see [Update](#update)). On macOS and Linux use a path such
as `~/work/t3code-session-manager`.

## Upgrading from 0.2.x

0.2.x has no `--from` and its watcher cannot be asked to stop, so do the first upgrade by hand, in this order:

1. Install the new version with the install line above (or from a folder, as just shown). The running 0.2.x watcher
   keeps running the old code meanwhile; that is harmless.
2. `t3sm schedule install --watch --dry-run`, then `t3sm schedule install --watch --yes` (or answer `y`). The new
   t3sm stops the old watcher by its process id, after checking that the process is a t3sm watcher started when its
   heartbeat says (never by name), recreates the scheduler entry with the 15-minute keep-alive and starts the new
   watcher.
3. `t3sm status` and `t3sm doctor`: the watcher line shows the new version (`t3sm status --json`: `watcher.version`).

If you used the plain schedule (`t3sm schedule install` without `--watch`), run that again instead: there is no
resident watcher to stop. From then on updates are automatic.

## Update

```bash
t3sm update
```

It looks up the newest release where t3sm came from (the npm registry with `npm view`; an install from GitHub with
`git ls-remote`: t3sm's only network call; installing then downloads the release with npm, and the optional `/t3sm`
plugin install in `t3sm start` goes through `claude plugin` after your yes), shows the change
(`0.3.0 -> 0.3.1 (patch)`), asks, and installs that exact version (`npm install -g t3code-session-manager@<version>`,
or the `vX.Y.Z` tag from GitHub). Then it stops the
background watcher (through its own control, never by name), starts it again on the new version and waits up to 2
minutes for it; if it does not start, the previous version is reinstalled. What is new is printed after the update,
from the CHANGELOG it installed; `t3sm changelog` shows it again later (`--since <version>` for several releases).
t3sm never installs an older version than the one you have. Every update is journaled. The state folder
(`~/.t3code-session-manager`: config, journal, plans) carries over between versions.

```bash
t3sm update --check            # only look: installed, newest, patch/minor/major, source, automatic updates
t3sm update --dry-run          # what would be installed; changes nothing
t3sm update --from D:\Work\t3code-session-manager   # from a checkout on this computer (its vX.Y.Z tags on main)
t3sm update --source npm       # update from the npm registry
t3sm update --source github    # update from GitHub's release tags
t3sm update --auto off         # no automatic updates (on: the default)
```

**Automatic updates.** Once a day the background watcher (`t3sm schedule install --watch`) looks for a newer release
of the same source. A patch or minor release (0.x minors included) is installed by itself, the same way, in a
separate hidden process; a major release is only announced (a notification, and `t3sm update --check`): run
`t3sm update` to install it. An update that fails or is interrupted shows in `t3sm status` as a need; one that was
rolled back (the previous version runs again) as worth knowing. The automatic check never tries a rolled-back version
again; `t3sm update` can still install it on purpose. Offline, nothing happens until the network is back.
`t3sm update --auto off` turns this off.

**From a folder.** `--from <folder>` takes a local checkout (a drive path such as `D:\Work\t3code-session-manager` on Windows; a network
folder is refused) and installs its newest `vX.Y.Z` tag on `main` (`master` when there is no `main`), showing that
tag's CHANGELOG first. The folder is remembered for later updates once the new version is in; `--source npm` or
`--source github` switches back. Version 0.1.0 has no `update` command, and 0.2.x's only installs from GitHub: from them, install once by
hand ([Upgrading from 0.2.x](#upgrading-from-02x)).

## Run it with npx (no install)

```bash
npx -y t3code-session-manager doctor
```

Every command works this way: replace `doctor` with `plan`, `apply`, and so on. The first run downloads the package
(a few seconds); later runs reuse npm's cache. Without a version, `npx` runs the newest release; pin one with
`t3code-session-manager@<version>`. Fine for a try; use the installed command for background sync.

## From a clone

```bash
git clone https://github.com/brunobola-portfolio/t3code-session-manager
cd t3code-session-manager
npm install          # dev tools only (TypeScript); builds dist/
npm link             # optional: puts `t3sm` on your PATH, pointing at this folder
t3sm doctor          # or, without npm link: node bin/t3sm.mjs doctor
```

In a clone, `bin/t3sm.mjs` always runs the TypeScript sources directly (Node 22.18+ strips types natively), even when
`dist/` exists; an installed package runs `dist/`. With `npm link`, `t3sm` runs this folder's sources, so
`git pull` is the update (`t3sm update` says so). `npm unlink -g t3code-session-manager` removes the link.

## Claude Code plugin

The repository is also a Claude Code plugin marketplace with one skill, `t3code-sessions`. With it you can ask Claude
Code things like "bring my sessions into T3 Code" or "which account will this project use in T3 Code?". The skill
runs `doctor` and `plan`, summarises `plan.md` (the Project accounts table and the warnings), and runs anything that
writes only after you say yes in the conversation. Inside Claude Code:

```
/plugin marketplace add brunobola-portfolio/t3code-session-manager
/plugin install t3sm@t3code-session-manager
```

The skill uses `t3sm` when it is installed, otherwise the pinned `npx` command.

To update the plugin: `/plugin marketplace update t3code-session-manager`.

## Uninstall

1. Stop the background sync, if you installed it: `t3sm schedule remove` (it stops the running watcher the safe way,
   then removes the Windows task and its file, the LaunchAgent, or on Linux the `# t3sm` crontab lines; it exits 1
   with the watcher's pid if that is still running). Do this before `npm uninstall`, or the scheduler keeps starting a
   command that no longer exists.
2. Optional: undo runs you do not want to keep. `t3sm runs` lists them, `t3sm rollback --run <id>` undoes one
   (converted files and merge revisions are deleted while unchanged, quarantined folders move back, project defaults
   are restored). Imported threads stay in T3 Code; delete or archive them there if you like.
3. Delete the state folder `~/.t3code-session-manager/`. It holds the config, the journal, plans, logs and caches,
   including `cache/opencode/` (stripped copies of your OpenCode conversations). Without the journal, rollback is no
   longer possible.
4. Quarantine folders: `<account home>/session-manager-quarantine/` (for example `~/.claude/session-manager-quarantine/`)
   hold what `dedupe` and `quarantine` moved. Roll those runs back to restore them, or delete the folders when you are
   sure you do not need the copies.
5. `npm uninstall -g t3code-session-manager` for a global install; `/plugin uninstall t3sm@t3code-session-manager`
   and `/plugin marketplace remove t3code-session-manager` for the plugin.
