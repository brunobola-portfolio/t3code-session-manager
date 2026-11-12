# Adding a harness

A harness is a coding agent whose sessions t3sm can bring into T3 Code. Adding one is a self-contained piece of work:
one adapter module, one fixture builder, one test file and a few lines of docs. The OpenCode adapter
(`src/sources/opencode.ts`) is the reference; this guide walks through it. If you would like a harness but cannot
write it, open a **Harness request** issue with what the brief below asks for.

## Native or convert

T3 Code's importer reads three sources itself: Claude Code, Codex and Pi. For those, t3sm's adapter only **discovers**
sessions exactly the way T3 Code's scanner does, so the plan can predict what T3 Code will import (mode `native`).

Every other agent is **converted** (mode `convert`): the adapter reads a session into a canonical transcript, t3sm
writes it as a Claude Code transcript in the project's account (`src/apply/claudeWriter.ts`), and T3 Code imports
that like any Claude session. The converted session then continues in Claude, in T3 Code or with `claude --resume`.
A new harness is almost always a convert adapter.

## The interface

`src/sources/types.ts`, abridged:

```ts
export interface SourceAdapter {
  id: HarnessId;                         // add yours to HarnessId in src/core/types.ts
  mode: "native" | "convert";
  isAvailable(env: Env): Promise<boolean>;
  availability?(env: Env): Promise<"absent" | "ok" | { drift: string } | { unreadable: string }>;
  discover(env: Env): AsyncIterable<DiscoveredSession>;
  read?(s: DiscoveredSession): Promise<CanonicalTranscript>;   // convert mode only
  watchRoots?(env: Env): Promise<string[]>;                     // folders `sync --watch` should watch
}
```

`Env` gives you the home folder, the platform, a clock (`now()`), the config, t3sm's state folder (keep caches under
`<stateDir>/cache/<id>/`), the process environment, and `readOnly` (for `doctor` and `sync --dry-run`: leave no
persistent state).

### `discover`

Yield one `DiscoveredSession` per conversation that has something to convert:

- `harness`, `nativeId` (the agent's own id), `cwd` (the working folder, as recorded), `startedAt` and `updatedAt`
  (ISO-8601; `updatedAt` is the session's last activity), `messageCount` (the same measure `read()` reports);
- `file`: the source file (`path`, `size`, `mtimeMs`, `atimeMs`). If every session shares one file (a database),
  give that file; per-session activity then comes from `updatedAt`;
- `flags`: `subagent`, `no-cwd`, `only-hidden` (no real user message), `active` (updated within the last 10 minutes,
  `ACTIVE_WINDOW_MS`);
- `accountId: null` and `cwdOffsetBytes: 0` for converted sessions (the account comes from the project's rules, and
  the converted file carries its folder on the first record).

Problems go to the adapter's `lastErrors`, never as exceptions: one unreadable session must not hide the others.

### `read`

Return a `CanonicalTranscript` and keep the contract documented on `SourceAdapter.read`:

- messages in conversation order, roles `user` and `assistant` only, timestamps ISO-8601 UTC;
- tool calls flattened into the text as `[tool <name>] <input> → <output>`, the part after the name at most 500
  characters with `…` when clipped; attachments as `[attachment: <name>]`; reasoning dropped;
- `activity` filled with the session's `updatedAt` and `messageCount` as this read saw them;
- throw `HarnessSchemaError` when the storage no longer has what you read (the session fails with a clear reason),
  `SourceBusyError` when the source kept changing while you read it, and `SessionActiveError` when the session was
  updated within 10 minutes (both are deferred to the next run, not failed).

### Never write the source

The adapter must not change the agent's files in any way, including side effects of reading. OpenCode keeps its
sessions in SQLite in WAL mode, and even a read-only SQLite connection writes the `-shm` index, so the adapter never
opens it: it stream-copies the database and its WAL into a private, owner-only temp folder, opens the copy, builds a
fresh database holding only the columns it reads (no tokens, credentials or secrets ever reach the kept file),
deletes the raw copy in `finally`, and sweeps leftovers on the next run. Do the same for anything that cannot be read
without side effects.

## Worked example: OpenCode

1. **Find the storage and record its schema.** OpenCode 1.19.5 keeps sessions in
   `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode/opencode.db`, also on Windows): tables
   `session`, `message` and `part`. [harnesses.md](harnesses.md#opencode-convert-mode) lists every table and column
   read, with what it means, and how each part type renders. Write the same section for your harness, with the version
   you tested and the date.
2. **Check the schema on every snapshot.** `OPENCODE_REQUIRED` names the tables and columns the adapter needs.
   Anything missing raises `HarnessSchemaError`: `availability()` returns `{ drift }`, `doctor` warns, and nothing is
   converted. A new agent version shows up as a warning, never as a half-converted session.
3. **Discover.** One query lists sessions with at least one message; flags come from `parent_id` (subagent),
   `directory` (no-cwd), the presence of a real user text (only-hidden) and `time_updated` (active). Unknown part types
   are counted and reported once.
4. **Read.** Messages by `time_created, id`; parts by `id`; each part type rendered or dropped by the table in
   harnesses.md. Consecutive messages of the same role are merged by the writer.
5. **Pin one snapshot per run** so every session of a run is read from one consistent state.
6. **Register** the adapter in `allAdapters()` (`src/sources/registry.ts`) and add its id to `HarnessId`
   (`src/core/types.ts`) and to doctor's binary map (`HARNESS_BIN` in `src/ops/doctor.ts`). Planner and apply decide
   convert or native per session through `isConvertSession(s)` (the session's `mode`, else `isConvertHarness(id)`);
   nothing else needs to know about your harness.

## Fixtures: synthetic only

- Build the fixture **at test time** from code (`test/fixtures/opencode/build.ts` creates the database from the
  recorded DDL in a temp folder). Do not commit binaries or real exports.
- Copy the **structure** from a real file; make every **value** up: `C:/work/demo` style paths, invented text, no
  names, emails, tokens, hostnames or real project names. Reviewers check this.
- Cover the awkward cases: accented text, empty sessions, a sub-agent, a session with only hidden content, an
  attachment, a tool call longer than 500 characters, a corrupt or unknown record.

## Test checklist

Model `test/sources/<id>.test.ts` on `test/sources/opencode.test.ts`:

- [ ] `discover` returns one session per conversation with the right flags; empty ones are ignored
- [ ] a session updated in the last 10 minutes is `active`; `read()` then throws `SessionActiveError`
- [ ] `read()` renders text, tools (clipped at 500), attachments and accents exactly; reasoning is dropped
- [ ] schema drift gives `HarnessSchemaError` in `lastErrors` and from `read()`, and `availability()` returns `drift`
- [ ] a source that keeps changing gives `SourceBusyError`
- [ ] the source is byte-identical before and after (and no side files appear next to it)
- [ ] nothing secret from the source reaches t3sm's cache (plant marker strings and search the cache bytes)
- [ ] `readOnly` discovery leaves nothing in the state folder
- [ ] `npm run typecheck` and `npm test` pass on your machine; CI runs Windows, macOS and Linux

## Docs and art

- [harnesses.md](harnesses.md): a section for the harness and a row in the status table. Mark it ⏳ until it has
  fixtures, 🟡 with fixtures and read-only checks on real data, ✅ only after a live run against T3 Code. Say what was
  and was not run.
- `README.md` and `README.pt.md`: the **Works with** table.
- `scripts/build-assets.js`: the `SOURCES` list if the harness should appear in the art, then `npm run assets`.
- `docs/migrate/<id>.md` and its `.pt.md` twin: what gets imported, what does not, commands, how to verify, how to
  undo.

Then open a pull request with the checklist above ticked.
