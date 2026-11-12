# Configuration

Everything t3sm keeps lives in one folder, the **state folder**: `~/.t3code-session-manager/` (set `T3SM_HOME` to
use another one). Its `config.json` is optional. Without it, every command uses the accounts it discovers; the first
`t3sm plan` saves what it found, and `t3sm accounts --init` writes the file on purpose (`--force` rewrites it).

The file is validated every time it is read. A mistake stops the command with exit code 2 and a list of the fields
that are wrong, for example `routes[0].account: unknown account "work"`. Fix the file, or delete it and run
`t3sm accounts --init`.

Only `version`, `accounts` and `defaultAccount` are required. Every other key is optional and takes the default
listed below when it is left out; inside `batch`, `schedule` and `sync` each field is optional on its own
(`"sync": { "autoMerge": true }` keeps the other `sync` defaults). A key that is present is still checked. t3sm writes
the file with every key spelled out.

## A minimal example

```json
{
  "version": 1,
  "accounts": [{ "id": "claudeAgent", "home": "~/.claude", "displayName": "Claude", "accentColor": null }],
  "defaultAccount": "claudeAgent"
}
```

## A complete example

```json
{
  "version": 1,
  "accounts": [
    { "id": "claudeAgent", "home": "~/.claude", "displayName": "Claude · Personal", "accentColor": "#B8641A" },
    { "id": "claude-work", "home": "~/.claude-work", "displayName": "Claude · Work", "accentColor": "#6A42C9" }
  ],
  "defaultAccount": "claudeAgent",
  "routes": [{ "match": "C:/work/clients/**", "account": "claude-work" }],
  "remap": [{ "from": "C:/old-disk/code", "to": "C:/work" }],
  "exclude": ["C:/work/scratch/**"],
  "includeBackups": false,
  "batch": { "filesPerProject": 50, "projectsPerWave": 5 },
  "schedule": { "everyMinutes": 15 },
  "sync": { "autoMerge": false, "watchDebounceMs": 30000, "maxUnattendedImports": 200 }
}
```

Paths can use `~`, forward slashes or backslashes (escaped in JSON: `"C:\\work"`). `~` is expanded when the file is
read, in account homes, in `remap` and in `routes` / `exclude` patterns that start with `~/`; t3sm writes the file back
the way you wrote it. On Windows and macOS, path comparisons ignore case.

## Keys

### `version`

Number, required, always `1`.

### `accounts`

Array, required, at least one entry. One entry per Claude account (one config folder). Each becomes a T3 Code
instance when you run `t3sm accounts --apply` or `t3sm apply`.

| Field | Type | Effect |
| :-- | :-- | :-- |
| `id` | string, letters, digits, `-`, `_`, starts with a letter, at most 64 | The T3 Code instance id. `claudeAgent` is T3 Code's own default instance and always means `~/.claude`. Never rename an id once it is in T3 Code: threads are keyed by it |
| `home` | string | The account's config folder (what `CLAUDE_CONFIG_DIR` points at). Two accounts cannot share a folder |
| `displayName` | string | The label in T3 Code's model picker. `t3sm accounts --rename <id> "<name>"` changes it in T3 Code and here |
| `accentColor` | `"#RRGGBB"` or `null` | The colour in the picker. `--rename … --color "#RRGGBB"` sets it (quote it: `#` starts a comment in shells) |

All four fields are required in each entry (`accentColor` may be `null`).

Discovered ids: an existing T3 Code instance keeps its id; `~/.claude` is `claudeAgent`; an account found through a
shell alias or function takes the alias name; any other folder `~/.claude-<name>` becomes `claude-<name>`.

### `defaultAccount`

String, required, one of the account ids. The last rule for a project's account (see `routes`) and the account used
for converted sessions of a project with no other evidence.

### `routes`

Array of `{ "match": "<glob>", "account": "<id>" }`, optional, default `[]`. The first route whose glob matches a project
folder decides that project's account. This is rule 1 of the project-account order (route, VS Code pin, most recent
session, `defaultAccount`). It sets:

- the **default account of the project in T3 Code**, so new threads there start on it;
- the account that **converted sessions** (OpenCode, compressed Codex sessions) of that project are written to.

It does not move an existing Claude session to another account: a session belongs to the account folder it was run
in, and its thread stays there. Glob syntax: `*` and `?` stay inside one folder name, `**` crosses folders; the glob
is matched against the whole project folder, so end it with `/**` to cover subfolders, or name the folder exactly.

### `remap`

Array of `{ "from": "<folder>", "to": "<folder>" }`, optional, default `[]`. For sessions whose recorded folder moved: the
first entry whose `from` is a whole-folder prefix of a session's folder replaces that prefix with `to` before
planning. `plan.md` flags every remapped session (note `remapped-cwd`).

- **Converted sessions** (OpenCode, compressed Codex sessions) are written with the new folder, so they land in the
  right project.
- **Native sessions** (Claude Code, uncompressed Codex, Pi): t3sm never edits a transcript, and T3 Code's importer only takes a
  transcript whose recorded folder is the project's folder ([spike S2](spikes/S2-import.md), §3). So a remap changes
  the plan (account choice, no `cwd-missing` skip), but expect T3 Code to skip those sessions: `apply` then reports
  them as failed (`not-imported`) and nothing else changes. This combination was not run live. For native sessions,
  recreating the old path (a directory junction on Windows, a symlink elsewhere) and planning without the remap is
  the reliable way; they then import into a project at the old path.

### `exclude`

Array of globs, optional, default `[]`. A session whose project folder (after `remap`) or transcript file matches one is
skipped (`excluded`). It is never moved or touched: while its project imports, an excluded file that T3 Code could
see is parked like any other.

### `includeBackups`

Boolean, optional, default `false`. Sessions inside backup folders in `projects/` (`.bak`, `.bak-YYYYMMDD-HHMMSS`) are skipped
as `backup-copy`. Set `true` to plan them like any other session (duplicates are still resolved). Usually
`t3sm quarantine` (moves the folders aside, reversibly) is the better answer.

### `batch`

Optional; each field defaults on its own. How much one import wave asks of T3 Code.

| Field | Default | Range | Effect |
| :-- | :-: | :-: | :-- |
| `filesPerProject` | 50 | 1–100 | Sessions of one project per wave (t3sm never goes above 90, under T3 Code's limit of 100 per call) |
| `projectsPerWave` | 5 | 1–50 | Projects per wave |

Smaller numbers mean shorter waves (less time with file times moved), larger ones fewer waves.

### `schedule`

`{ "everyMinutes": 15 }`, optional, default 15, range 1–1440. How often `t3sm schedule install` runs `t3sm sync`, and the watcher's safety
interval. On Linux (cron) use a value below 60 or a multiple of 60. Run `t3sm schedule install` again after a
change.

### `sync`

Optional; each field defaults on its own.

| Field | Default | Range | Effect |
| :-- | :-: | :-: | :-- |
| `autoMerge` | `false` | boolean | `false`: `sync` only reports sessions continued in a terminal (`t3sm merge` brings them in). `true`: `sync` merges them itself once they have been idle 10 minutes, at most 20 per cycle |
| `watchDebounceMs` | 30000 | 1000–600000 | `sync --watch` waits this long after the last change before running a cycle |
| `maxUnattendedImports` | 200 | 1–100000 | When more sessions than this are pending (conversions included), `sync` imports nothing and says to run `t3sm apply` once |

### `codex`

Optional; `{ "convertCompressed": true }` when absent.

| Field | Default | Range | Effect |
| :-- | :-: | :-: | :-- |
| `convertCompressed` | `true` | boolean | `true`: Codex sessions compressed by Codex CLI 0.167+ (`rollout-*.jsonl.zst`), which T3 Code cannot read, are decompressed in memory, converted into Claude Code transcripts in the project's account and imported as Claude threads. `false`: they are listed without being opened and skipped (`compressed`) |

### `language`

`"en"` or `"pt"`, optional, default `"en"`. The language of the guided assistant (`t3sm start`) only; every other
command prints English. `t3sm start --lang pt` offers to save it here (it asks first). Order: `--lang`, then the
`T3SM_LANG` variable, then this key, then English. The operating system's language is never used.

## Environment variables

| Variable | Effect |
| :-- | :-- |
| `T3SM_HOME` | State folder (default `~/.t3code-session-manager`) |
| `T3SM_LANG` | `en` or `pt`: language of the guided assistant (`t3sm start`); `--lang` wins over it, it wins over `language` in `config.json` |
| `CODEX_HOME` | Codex home (default `~/.codex`), as T3 Code reads it |
| `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR` | Pi session folder, as T3 Code reads it |
| `XDG_DATA_HOME` | OpenCode data folder (default `~/.local/share`, on Windows too) |
| `NO_COLOR` | No colour in the terminal summary |
| `CLAUDE_CONFIG_DIR` | Only read as a hint for account discovery. Never start T3 Code from a shell that sets it: `doctor` warns (`claude-env`) |

## Recipes

### Send one project to another account

```bash
t3sm projects set "C:/work/acme-portal" claude-work
```

That writes this route (replacing the folder's own route in place, or right before the first wildcard route matching
the folder, so it wins for that folder only and no other folder's account changes) and, when the folder is already a
T3 Code project and T3 Code is running, sets its default account there too (journaled; `t3sm rollback --run <id>`
undoes it). The route also decides which account the folder's OpenCode and compressed Codex sessions not imported yet
go to; Claude Code sessions keep the account they were recorded in. It covers that exact folder, not its sub-folders. `t3sm projects` lists every folder with its account and why; `t3sm projects unset "<folder>"` removes the
route. By hand:

```json
"routes": [{ "match": "C:/work/acme-portal", "account": "claude-work" }]
```

Run `t3sm plan`: the **Project accounts** table shows the project with source `route`. `t3sm apply` sets that
project's default in T3 Code (journaled; `t3sm rollback` restores the previous default). New threads there now start
on the work account; existing threads keep the account they were run with. A whole client folder:
`"C:/work/acme/**"`.

### Exclude a folder

```json
"exclude": ["C:/work/scratch/**", "**/tmp-*"]
```

`t3sm plan` lists those sessions under `excluded`. Nothing about them changes.

### Follow a moved repository

You moved `D:/projects/app` to `C:/work/app` and its old sessions show as `cwd-missing`:

```json
"remap": [{ "from": "D:/projects/app", "to": "C:/work/app" }]
```

Read the `remap` caveat above for native sessions first; try it on that one project with
`t3sm apply --only C:/work/app`.

### Turn auto-merge on (or back off)

```json
"sync": { "autoMerge": true }
```

With it on, a scheduled `sync` creates merge revisions and archives the old threads without asking. Each one is
journaled and reversible, but the default is off for a reason: set it back to `false` to go back to reports only.

### Name and colour the accounts in T3 Code's picker

```bash
t3sm accounts --rename claudeAgent "Claude · Personal" --color "#B8641A"
t3sm accounts --rename claude-work "Claude · Work" --color "#6A42C9"
```

### Gentler imports on a slow machine

```json
"batch": { "filesPerProject": 20, "projectsPerWave": 2 }
```
