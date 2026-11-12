# t3sm plan 20261111-120000-abcd

Generated 2026-11-11T12:00:00.000Z for T3 Code 0.0.30. Nothing has been written yet: review this, then run `t3sm apply`.

## Summary

| Action | Sessions |
| --- | ---: |
| Import as is | 4 |
| Convert, then import | 1 |
| Skip | 37 |

| Account / instance | Import | Convert | Skip |
| --- | ---: | ---: | ---: |
| Claude · Org (claude-org) | 2 | 1 | 8 |
| claudeAgent | 2 | 0 | 29 |

| Harness | Sessions |
| --- | ---: |
| claude | 41 |
| pi | 1 |

## Accounts

| Instance id | Name | Home |
| --- | --- | --- |
| `claude-org` | Claude · Org | `C:/Users/demo/.claude-org` |

## Projects to create (1)

| Project | Root | Account | Source |
| --- | --- | --- | --- |
| demo | `C:/work/demo` | Claude · Org (claude-org) | vscode-pin |

## Project accounts

Which subscription each project opens by default. Review this table: it decides where new threads in T3 Code start.

| Project root | Account | Source |
| --- | --- | --- |
| `C:/work/demo` | Claude · Org (claude-org) | vscode-pin |
| `C:/work/other\|pipe` | claudeAgent | recent-activity |

## Project defaults to set

| Project root | Default instance |
| --- | --- |
| `C:/work/demo` | Claude · Org (claude-org) |

## Duplicates across accounts

| Relation | Copies |
| --- | ---: |
| identical (mirror) | 1 |
| prefix (shorter mirror) | 1 |
| case-variant (same session, other path case) | 1 |
| backup (.bak folders) | 1 |

Diverged forks (both histories are kept and imported): 1

- `00000000-0000-4000-8000-000000000002` (claude, claude-org)

Label only in a mirror copy (the title or tag lives in the discarded copy): 1

- `00000000-0000-4000-8000-000000000004` (claude, claudeAgent)

## Warnings

- Project C:/work/old is archived in T3 Code and will be reused.
- 2 mirror copies present. Run `t3sm dedupe` before `t3sm apply` so T3 cannot import stale copies under the wrong account.
- 1 session in .bak folders: `t3sm quarantine` moves them aside, reversibly.
- 1 session continued outside T3 Code after import. The imported thread is stale; `t3sm merge` creates a revision thread with the new messages and archives the old one.
- 1 session larger than 32 MiB; T3 Code reads only the first 32 MiB of each.
- 1 session with a duplicate inside the activity window.

## Skipped by reason

| Reason | Sessions |
| --- | ---: |
| already-in-t3 | 22 |
| cwd-missing | 1 |
| duplicate | 1 |
| mirror-copy | 1 |
| backup-copy | 1 |
| active | 1 |
| non-uuid-id | 1 |
| no-session-id | 1 |
| subagent | 1 |
| only-hidden | 1 |
| over-4gib | 1 |
| no-cwd | 1 |
| cwd-unreadable | 1 |
| excluded | 1 |
| harness-unavailable | 1 |
| compare-failed | 1 |

### already-in-t3 (22)

Already imported into T3 Code.

- `00000000-0000-4000-8000-0000000007d0` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007d1` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007d2` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007d3` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007d4` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007d5` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007d6` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007d7` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007d8` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007d9` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007da` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007db` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007dc` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007dd` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007de` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007df` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007e0` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007e1` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007e2` · claude · claudeAgent · `C:/work/demo`
- `00000000-0000-4000-8000-0000000007e3` · claude · claudeAgent · `C:/work/demo`
- ... and 2 more (see plan.json)

### cwd-missing (1)

The project folder no longer exists on disk.

- `00000000-0000-4000-8000-000000000834` · claude · claude-org · `C:/work/demo`

### duplicate (1)

Same session kept under another path (case variant); the other copy is imported.

- `00000000-0000-4000-8000-000000000898` · claude · claudeAgent · `C:/work/demo`

### mirror-copy (1)

An identical or shorter mirror of a session kept in another account.

- `00000000-0000-4000-8000-0000000008fc` · claude · claude-org · `C:/work/demo`

### backup-copy (1)

Lives in a .bak backup folder.

- `00000000-0000-4000-8000-000000000960` · claude · claudeAgent · `C:/work/demo`

### active (1)

Modified in the last 10 minutes, so it may be in use; try again later.

- `00000000-0000-4000-8000-0000000009c4` · claude · claude-org · `C:/work/demo`

### non-uuid-id (1)

The session id is not a UUID, which T3 Code cannot import.

- `00000000-0000-4000-8000-000000000a28` · claude · claudeAgent · `C:/work/demo`

### no-session-id (1)

The transcript carries no session id.

- `00000000-0000-4000-8000-000000000a8c` · claude · claude-org · `C:/work/demo`

### subagent (1)

A sub-agent transcript, shown inside its parent session.

- `00000000-0000-4000-8000-000000000af0` · claude · claudeAgent · `C:/work/demo`

### only-hidden (1)

Holds only hidden or system records, nothing to show.

- `00000000-0000-4000-8000-000000000b54` · claude · claude-org · `C:/work/demo`

### over-4gib (1)

Larger than 4 GiB, too big to import.

- `00000000-0000-4000-8000-000000000bb8` · claude · claudeAgent · `C:/work/demo`

### no-cwd (1)

No working directory recorded, so the project is unknown.

- `00000000-0000-4000-8000-000000000c1c` · claude · claude-org · `C:/work/demo`

### cwd-unreadable (1)

The working directory could not be read from the transcript.

- `00000000-0000-4000-8000-000000000c80` · claude · claudeAgent · `C:/work/demo`

### excluded (1)

Matches an `exclude` pattern in config.json.

- `00000000-0000-4000-8000-000000000ce4` · claude · claude-org · `C:/work/demo`

### harness-unavailable (1)

No T3 Code provider instance exists for this harness.

- `00000000-0000-4000-8000-000000000d48` · claude · claudeAgent · `C:/work/demo`

### compare-failed (1)

Could not compare it with its duplicate (file busy); it will be retried on the next plan.

- `00000000-0000-4000-8000-000000000dac` · claude · claude-org · `C:/work/demo`

## Residual limits

- T3 Code shows at most 200 visible messages per imported thread.
- Tool activity (commands, file edits) is not part of the imported timeline, only the conversation text.
- Imported threads show the import time as their last activity.
