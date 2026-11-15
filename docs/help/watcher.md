# The watcher: background sync that is not running or late

## What it means

The watcher is the background sync (`t3sm schedule install --watch`): it imports new conversations a few minutes
after they go idle. `t3sm status` says when it is not running, runs an older t3sm, or its cycles stopped.

## Why it happens

- It was stopped, or it ended without a clean stop (the computer slept, the process was ended).
- t3sm was updated and the watcher did not restart into the new version.
- It stops at start-up (`config.json` cannot be used, or, on Linux and macOS, its socket directory is not safe):
  `logs/sync.log` says `startup-error` or `socket-dir-unsafe`.
- Its cycles keep failing (T3 Code incompatible, an account signed out).

## What to do

- `t3sm schedule restart` stops it safely and starts it again.
- `t3sm schedule status` shows the scheduler entry, the watcher's heartbeat and the last logged cycle.
- Nothing installed yet: `t3sm schedule install --watch`. A watcher you started by hand comes back with
  `t3sm sync --watch`.
- It stops at start-up, or its cycles keep failing: `t3sm doctor` says why.
- "Another t3sm run is in progress": a sync is in the middle of its work; the schedule commands stop the watcher only
  between runs, so try again in a moment.
