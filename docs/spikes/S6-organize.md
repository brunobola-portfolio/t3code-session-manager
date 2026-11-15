# Spike S6: organizing imported history (settle state, titles, pins, refused folders)

- **Tested live against:** T3 Code Nightly `0.1.10-nightly.20261113.4630` (`claudeAgent` instance on `~/.claude`),
  Windows 11 x64, on 2026-11-14. Approved by the maintainer for this run.
- **Method:** a throwaway script (not committed) using t3sm's own `src/t3/*` transport. Two disposable projects
  under `.spike/` (`org-live-a`, `org-live-b`), two synthetic Claude transcripts in `~/.claude/projects/<encoded>`
  whose folders did not exist before. Reads of T3 state used `statev2.sqlite` **read-only**; every change went
  through `orchestration.dispatchCommand` or `POST /api/projects/mutate`. One `claude --resume -p` turn (a few
  tokens).
- **Cleanup done:** both projects removed with `t3 project remove --force <id>`; transcripts, their encoded folders
  and the project folders deleted; absence checked afterwards.

## Result: PASS (all 9 checks)

| check | observed |
|---|---|
| `project.create` imports nothing by itself | 0 threads in the new project 8 s after creating it next to an existing in-window transcript |
| title at import | T3 used the transcript's `ai-title` (`"Spike: soma simples"`); for the copy it used `custom-title` |
| state at import | `settledOverride: "settled"`, `settledAt` set |
| `thread.unsettle` (`reason: "user"` is **required**; without it: `Defect: Missing key at ["reason"]`) | `settledOverride: "active"`, `settledAt: null` |
| auto-settle on (7 days), thread inactive for 20 days, after 75 s | still `active` (matches `isAutoSettlementCandidate`: `settledOverride !== null` is never auto-settled) |
| `thread.metadata.update { title }` | title changed |
| `project.update { pinned: true }` / `{ pinned: false }` | `pinned_at` set / cleared (HTTP 200) |
| `thread.settle` after unsettle | `settledAt` set again |
| faithful copy of a home-folder transcript: every record kept, only `cwd` and `sessionId` swapped to a project folder, plus a `custom-title` record | imported into that project (`importedCount 1`) |
| `claude --resume <copy> -p` from the project folder | answered from the copied history (`ALFA`), exit 0, the copy grew |

## Measured from the server bundle (same version, not run live)

- Sessions whose folder is the home folder exactly, `os.tmpdir()` exactly, `/tmp`, `/private/tmp`, or anything under
  `~/Downloads`, `~/Documents/Codex`, the T3 base dir or T3 worktrees are never imported
  (`AgentSessionScanner.isExcludedProjectPath`). This is why 38 home-folder sessions and one `Documents/Codex`
  session always ended `not-imported`.
- `thread.project.adopt-folder` moves a thread only between projects with the same folder.
- `sidebarAutoSettleAfterDays: null` turns auto-settle off; per-project overrides exist in
  `projectSettingsOverrides`.

## project.delete payload (from server bundle, not run live)

Read from `server.asar` (T3 Code 0.1.10-nightly.20261113.4630), never executed against a real T3.

- `POST /api/projects/mutate` accepts it: `ProjectMutation` is the union of `project.create`, `project.update` and
  `project.delete`, and the route handler passes the decoded mutation to `mutateProjectWithClone`.
- Schema: `{ type: "project.delete", commandId: CommandId, projectId: ProjectId, force?: boolean }`.
- Scope: `orchestration:operate` only (same as the other mutations; `requiredScopesForProjectMutation`).
- Behaviour (`ProjectService.delete`): unknown project -> `ProjectNotFoundError`; a project that still has threads
  (active or archived) and no `force: true` -> `ProjectNotEmptyError` and nothing is deleted; with `force: true` T3
  deletes every child thread first. A second delete of an already deleted project is idempotent. On success it
  returns the project (with `deletedAt`), so the same decoder as the other mutate calls applies.
- t3sm sends `{ type, commandId, projectId }` and never `force`, so a project that still holds a thread is refused by T3
  itself (HTTP error), on top of the journal rule that t3sm only deletes projects it created.

## Reading pin state

`GET /api/projects` already carries `pinnedAt` and `createdAt` per project (fixture `http-projects.json`), so
`T3Project.pinned` / `createdAt` come from that route; the orchestration shell's `projects` array is not needed.

## project.update { title } (from server bundle, not run live)

Read from `server.asar` (T3 Code 0.1.10-nightly.20261113.4630), never executed against a real T3: `project.update` takes
`ProjectUpdatePayload`, whose `title` is `optional(TrimmedNonEmptyString)`, so `POST /api/projects/mutate
{ type: "project.update", commandId, projectId, title }` renames a project (there is no separate `project.meta.update`
command; the event it emits is `project.meta-updated`, and a title in it sets the projection's `hasCustomTitle`).
`t3sm projects rename --suggest` sends exactly that and nothing else (`T3Api.setProjectTitle`).
