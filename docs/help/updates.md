# Updates: how t3sm updates itself, and when it fails

## What it means

Once a day the background watcher looks for a newer t3sm. A patch or minor release is installed by itself; a major
release is only announced. After an install, the watcher must start on the new version within 2 minutes, or the
previous version is put back. t3sm never downgrades.

It updates from where it was installed: the npm registry for `npm install -g t3code-session-manager`, GitHub's release
tags for an install from GitHub, or a checkout on this computer after `t3sm update --from <folder>`.

## Why it fails

- No network, a proxy, or git and npm missing: the check is skipped and tried again later.
- The new version did not start properly: it was rolled back, so the previous version runs again. `t3sm status`
  shows this as worth knowing, not as a need; the automatic check skips that version, and `t3sm update` can still
  install it on purpose.
- The computer slept or restarted during the update: it was interrupted.

## What to do

- `t3sm update --check` shows the installed and the newest version, the last check, and how to go back after an
  interrupted update.
- `t3sm update` installs the newest release after showing what is new; `t3sm changelog` shows what changed.
- `t3sm update --auto off` stops automatic updates (`--auto on` turns them back on).
- `t3sm update --source npm` moves an install from GitHub to the npm registry; `--source github` goes back.
