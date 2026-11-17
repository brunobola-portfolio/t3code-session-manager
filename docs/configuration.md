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

`"en"` or `"pt"`, optional. The language of everything t3sm prints for people: every command's screens and questions,
the guided assistant, `--help`, `t3sm help` and the system notifications. `t3sm start` offers to save the language
you chose with `--lang` here (it asks first). The order, first match wins:

1. `--lang en|pt` on the command line (any command, anywhere on the line);
2. the `T3SM_LANG` variable (`en` or `pt`; anything else is ignored);
3. this key;
4. `LC_ALL`, then `LC_MESSAGES`, then `LANG` (a value that starts with `pt`, such as `pt_PT.UTF-8`, gives Portuguese;
   any other language gives English; empty, `C` and `POSIX` are skipped);
5. the operating system's locale as Node reports it (`Intl.DateTimeFormat().resolvedOptions().locale`; on Windows,
   which sets no `LANG`, this is the system's language);
6. English.

`--json`, `plan.md`, `journal.jsonl` and `logs/sync.log` are always English, whatever the language. Without this key,
a new General folder follows the language too (`~/T3 Geral` on a Portuguese system); one that already exists in T3 Code
is kept.

### `organize`

Optional; each field defaults on its own, and an invalid value is a `ConfigError` naming the key. Controls how
imported history is organized in T3 Code. Paths may start with `~` (kept as written, expanded where used).

| Key | Values | Default | What it changes |
| :-- | :-- | :-: | :-- |
| `folders.home` | `import`, `skip`, `rehome` | `rehome` | Sessions started in the home folder |
| `folders["t3-refused"]` | `import`, `skip`, `rehome` | `rehome` | Sessions in folders T3 Code refuses as projects |
| `folders.temp` | `import`, `skip`, `rehome` | `skip` | Sessions in temporary folders |
| `folders.system` | `import`, `skip`, `rehome` | `skip` | Sessions in system folders |
| `sessions.automated` | `skip`, `import` | `skip` | Automated (non-interactive) sessions |
| `sessions.orphaned` | `copy`, `skip` | `copy` | Sessions started in T3 Code whose thread was deleted there (T3 Code will not import them again): `copy` brings each back as a faithful copy with a new session id, in its own folder (a folder T3 Code refuses: the rehome target), whatever the folder category; an `overrides` rule still applies (`skip` keeps it out, `rehome:<folder>` sends the copy there); waits for its question (`orphaned`) until answered. A session started in T3 Code whose thread is still there (active or archived) is skipped as already in T3 Code; one whose thread id is unknown is never copied |
| `generalFolder` | folder path | `~/T3 Geral` (PT) / `~/T3 General` (EN) | Folder that receives rehomed sessions without a project: an absolute folder (or `~/...`) T3 Code accepts; `t3sm apply` creates it when missing (never `sync`) |
| `overrides` | list of `{ "match": glob, "action": "import" \| "skip" \| "rehome:<folder>" }` | `[]` | Per-folder exceptions to the folder rules above. An override never imports an automated session: `sessions.automated` decides those. `rehome:<folder>` must name an absolute folder (or `~/...`) T3 Code accepts as a project, not a temporary or system one; `t3sm apply` creates it when missing |
| `names.maxLength` | integer 16-120 | 40 | Longest project name |
| `history` | `{ "days": 1-3650 or "all", "minPerProject": 0-1000 }`; the 0.2 values `all`, `off` and `days:N` (N 1-3650) still read | `{ "days": 90, "minPerProject": 10 }` | The history rule (below): which imported conversations stay shown inside each project. `all` reads as `{days: "all", minPerProject: 10}`, `days:N` as `{days: N, minPerProject: 10}`, `off` turns the rule off. `t3sm organize --history <days|all|off> --min <n>` overrides it for one run; `t3sm sync` applies it once a day and after each import |
| `titles` | boolean | `true` | Give imported threads readable titles |
| `aiTitles` | `{ "enabled": boolean, "maxPerRun": 1-500 }` | `{ false, 50 }` | Titles written by T3 Code: `enabled` makes every `t3sm organize` run ask T3 Code to write the titles that stay technical, with its own text model (it spends your provider's tokens), at most `maxPerRun` per run, the most recent first. `--ai-titles`, `--ai-titles-max <n>` and `--no-ai-titles` choose for one run. `t3sm sync` and `t3sm start` never ask for them |
| `archiveAutomated` | boolean | `true` | Archive imported automated threads |
| `pinRecent` | `{ "enabled": boolean, "count": 1-20 }` | `{ true, 5 }` | Pin the most recent projects |
| `decided` | list of keys | `[]` | Questions already asked (`home`, `t3-refused`, `temp`, `system`, `automated`, `orphaned`, `archiveAutomated`, `titles`, `history`, `pinRecent`, `notify`); never asked again |

**The history rule** (`organize.history`), per project:

- every conversation active in the last `days` days is shown inside its project;
- if fewer than `minPerProject` are shown, the most recent settled ones are shown until `minPerProject` are (every
  shown conversation counts, including the ones started in T3 Code and pinned ones);
- every other imported conversation is settled: it stays in its project, on the Settled shelf.

The activity date is T3 Code's own: the newest of the user's last message and the last run's request, start and end,
else when the conversation was created (a date in the future counts as now). Changes go oldest first, so the Settled
shelf keeps the order of the history. Only imported conversations (`import:` threads, from t3sm or T3 Code's own
import) are moved; one you started in T3 Code is only moved by T3 Code's own auto-settle option. One you settled,
showed, pinned or archived by hand (anything t3sm did not journal as its own last change) is never touched again.
`"days": "all"` shows everything; `"minPerProject": 0` keeps only the days. Example:

```json
"organize": { "history": { "days": 90, "minPerProject": 10 } }
```

T3 Code's own option for conversations started there (`sidebarAutoSettleAfterDays`, 1-90 days or off) is not part of
this key and is changed only by `t3sm organize --auto-settle <1..90|off>` (the guided assistant offers the same days,
or, for more than 90 days or `"all"`, to leave it or turn it off). `t3sm sync` never changes it.

### `notify`

`"attention"`, `"all"` or `"off"`, optional, default `"attention"`. Which `sync` results raise a notification:
only those that need you, all of them, or none.

### `update`

Optional; `{ "auto": true }` when absent.

| Field | Default | Range | Effect |
| :-- | :-: | :-: | :-- |
| `auto` | `true` | boolean | `true`: once a day the background watcher looks up the newest `vX.Y.Z` release of the source t3sm was last installed from (GitHub's tags, or the tags on `main` of a checkout on this computer: a drive path such as `D:\Work\t3code-session-manager` on Windows; a network path such as `\\server\share` is refused, though a mapped network drive or a network mount looks local and is not detected) and installs it by itself when it is a patch or minor release (0.x minors included) strictly newer than the installed one; a major release is only announced. After installing, the watcher is restarted into the new version; if no heartbeat of it arrives within 2 minutes, the previous version is reinstalled. `false`: never installs by itself |

Set it with `t3sm update --auto on|off`; `t3sm update --check` shows it, the newest release and the last check (no
checkout or npx install is ever updated by itself). Looking up the newest release (`npm view` on the npm registry, or
`git ls-remote` for an install from GitHub) is t3sm's only network call; installing a release downloads it with npm, and the optional
`/t3sm` plugin install in `t3sm start` goes through `claude plugin` after your yes. Every update is journaled (`update` entries in `journal.jsonl`); the source and the previous version are
kept in `<state>/update.json`.

## Environment variables

| Variable | Effect |
| :-- | :-- |
| `T3SM_HOME` | State folder (default `~/.t3code-session-manager`) |
| `T3SM_LANG` | `en` or `pt`: the language t3sm prints in; `--lang` wins over it, it wins over `language` in `config.json` and the system's language ([`language`](#language)) |
| `LC_ALL`, `LC_MESSAGES`, `LANG` | Read for the language when neither `--lang`, `T3SM_LANG` nor `language` decide |
| `CODEX_HOME` | Codex home (default `~/.codex`), as T3 Code reads it |
| `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR` | Pi session folder, as T3 Code reads it |
| `XDG_DATA_HOME` | OpenCode data folder (default `~/.local/share`, on Windows too) |
| `NO_COLOR` | No colour (the same as `--no-color`); `FORCE_COLOR` forces it on, `TERM=dumb` turns colour and cursor movement off |
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
