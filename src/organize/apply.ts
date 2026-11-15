// Applies an organize plan (spec §5) to T3 Code, journals every change, and undoes a run (`t3sm organize --undo`,
// `t3sm rollback <organize run>`). Callers: `t3sm organize` and `t3sm projects rename --suggest` (src/cli/commands),
// the assistant, sync.
// applyOrganize and undoOrganize REQUIRE the caller to hold the state-dir lock (acquireLock) and to have run
// recoverPendingMtimes first (a dry undo needs neither: it writes nothing).
//
// Contract (rulings R13, R14):
// - `organize-change` is journaled only AFTER T3 accepted the command. A crash in between leaves T3 changed but
//   unjournaled; the next plan sees that state and plans nothing for it.
// - Before each action the target must still be in the plan's `previous` state. Freshness: projects (and, for
//   project-delete, threads) are read again right before every project action and the auto-settle setting right before
//   its write; threads are read at the start and again every THREAD_BATCH thread actions (one thread read costs the
//   whole HTTP shell plus the archived snapshot). A target changed since the plan is skipped (`skippedChanged`).
// - A write that throws is confirmed by reading T3 again ONLY when T3 may have applied it: a reply that did not decode
//   (ShapeError after a 2xx), or a lost reply (RPC timeout / closed socket, HTTP without a response). Then, when T3
//   shows the planned value, the change is journaled, so a confirmed change is never left unjournaled. A refusal (HTTP
//   4xx/5xx, an RPC domain error such as ProjectNotFoundError, a bad value) is a plain failure, never journaled.
// - A journal append that fails stops the run with JournalWriteError naming what T3 Code already holds.
// - Settle-family values (settle, unsettle) are compared as the override T3 shows (`settleShown`): a backdated settle's
//   `{ settledAt }` is "settled"; a null `previous` is the side the change left (T3 cannot clear an override).
// - Undo goes newest first and acts only on targets still at the value t3sm set; anything else was changed by the user
//   since and stays (`skippedUserChanged`). Undo never writes `organize-change` (it journals `organize-undone`, and
//   `project-created` for a project it re-creates), never deletes or rewrites a journal line, so an undone target
//   differs from t3sm's last `next` and the planner leaves it alone from then on.
// - Any T3 Code version (owner's decision): organizeGate warns on an unverified one; strict decoding is the guard.

import type { JournalEntry, OrganizeKind } from "../core/types.ts";
import { newRunId, type Journal } from "../core/journal.ts";
import { ConfigError } from "../core/config.ts";
import { sameCwd } from "../core/paths.ts";
import type { T3Api, T3Project, T3Thread } from "../t3/api.ts";
import { organizeGate } from "../t3/compat.ts";
import { RpcClosed, RpcTimeout, ShapeError, T3HttpError, redact } from "../t3/errors.ts";
import { JournalWriteError } from "../ops/quarantine.ts";
import { changeKind, isObj, settleShown } from "./history.ts";
import { AUTO_SETTLE_TARGET } from "./plan.ts";
import type { OrganizeAction, OrganizePlan } from "./types.ts";

export interface ApplyOrganizeDeps {
  api: T3Api;
  journal: Journal;
  runId: string;
  /** One line per action: `[i/n] <kind> <target>: done | skipped (...) | failed (...)`. */
  onProgress?: (line: string) => void;
  /** run-start command (default "organize"). null: the caller owns the run and journals run-start / run-end (sync). */
  command?: string | null;
  now?: () => number;
  /** No warning on an unverified T3 Code version (`--allow-untested`). */
  allowUntested?: boolean;
  onNotice?: (line: string) => void;
  /** true once a stop signal arrived (Ctrl+C, a kill, the terminal closing): the run stops after the current action. */
  aborted?: () => boolean;
}

export interface ApplyOrganizeResult {
  done: number;
  /** Targets no longer in the state the plan expected (changed in T3 Code since): left alone. */
  skippedChanged: number;
  failed: { action: OrganizeAction; error: string }[];
  /** aborted: stopped by `aborted()` before the end (journaled as run-end "aborted"). */
  status: "ok" | "partial" | "aborted";
}

export interface OrganizeUndoItem {
  kind: OrganizeKind;
  target: string;
  /** reverted (or would be, in a dry run); user-changed: not at the value t3sm set; already: back at the old value. */
  status: "reverted" | "user-changed" | "already" | "failed";
  note?: string;
}

export interface UndoOrganizeDeps {
  api: T3Api;
  journal: Journal;
  now: () => number;
  /** Report what would be reverted; write nothing (T3 is only read). */
  dryRun?: boolean;
  allowUntested?: boolean;
  onNotice?: (line: string) => void;
  onProgress?: (line: string) => void;
  /** How workspace roots compare (default: this machine). */
  platform?: NodeJS.Platform;
}

export interface UndoOrganizeResult {
  /** The undo's own run id; null when nothing was written (dry run, or nothing left to undo). */
  runId: string | null;
  reverted: number;
  skippedUserChanged: number;
  alreadyRestored: number;
  failed: { kind: OrganizeKind; target: string; error: string }[];
  items: OrganizeUndoItem[];
}

const KINDS: ReadonlySet<string> = new Set<OrganizeKind>(["archive", "title", "unsettle", "settle", "pin", "unpin", "project-delete", "project-title", "auto-settle"]);
const THREAD_KINDS: ReadonlySet<OrganizeKind> = new Set<OrganizeKind>(["archive", "title", "unsettle", "settle"]);
const PROJECT_KINDS: ReadonlySet<OrganizeKind> = new Set<OrganizeKind>(["pin", "unpin", "project-delete", "project-title"]);
/** The journal entries of a run that only organized (what `organize --undo` reverts whole). */
const ORGANIZE_RUN_KINDS: ReadonlySet<string> = new Set(["run-start", "run-end", "organize-change", "organize-failed"]);
/** Thread actions between two reads of T3's thread list. */
export const THREAD_BATCH = 50;

/** T3 Code could not be read before the first revert (nothing was changed). */
export class OrganizeReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizeReadError";
  }
}

/** A failure reason as journaled and shown: secrets redacted, one line, at most 200 characters (code points: never half a pair). */
export const failureText = (error: string): string => {
  const one = [...redact(error).replace(/\s+/g, " ").trim()];
  return one.length > 200 ? `${one.slice(0, 199).join("")}…` : one.join("");
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Equality of journal values (primitives and plain objects such as project-delete's `{ title, workspaceRoot }`). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

/** T3 as read once at the start; updated with every change made since. */
interface World { threads: Map<string, T3Thread>; projects: T3Project[] }

async function loadWorld(api: T3Api, kinds: Iterable<OrganizeKind>): Promise<World> {
  const ks = [...kinds];
  // project-delete also needs the threads: T3 refuses to delete a project that holds one.
  const needThreads = ks.some((k) => THREAD_KINDS.has(k) || k === "project-delete");
  const needProjects = ks.some((k) => PROJECT_KINDS.has(k));
  return {
    threads: needThreads ? await threadMap(api) : new Map(),
    projects: needProjects ? await api.listProjects() : [],
  };
}

const threadMap = async (api: T3Api): Promise<Map<string, T3Thread>> => new Map((await api.listThreads()).map((t) => [t.id, t] as const));

/** Reads again what the next action is judged on (the freshness rule in the header). */
function refresher(api: T3Api, w: World): (kind: OrganizeKind) => Promise<void> {
  let threadActions = 0;
  return async (kind) => {
    if (THREAD_KINDS.has(kind)) {
      if (threadActions > 0 && threadActions % THREAD_BATCH === 0) w.threads = await threadMap(api);
      threadActions++;
    } else if (PROJECT_KINDS.has(kind)) {
      w.projects = await api.listProjects();
      if (kind === "project-delete") w.threads = await threadMap(api);
    }
  };
}

/** T3 may have applied a write that threw this: its reply did not decode, or never arrived. */
function mayHaveApplied(e: unknown): boolean {
  return e instanceof ShapeError || e instanceof RpcTimeout || e instanceof RpcClosed || (e instanceof T3HttpError && e.status === null);
}

/** Appends, turning a failure into a JournalWriteError that says what T3 Code already holds. */
async function appendOrStop(j: Journal, e: JournalEntry, what: string): Promise<void> {
  try {
    await j.append(e);
  } catch (err) {
    throw new JournalWriteError(`Could not write the journal (${msg(err)}) ${what}.`);
  }
}

type Current = { exists: true; value: unknown } | { exists: false };

/** The value of `kind` on `target` as organize journals it (see OrganizeAction's previous/next per kind). */
async function current(api: T3Api, w: World, kind: OrganizeKind, target: string): Promise<Current> {
  if (kind === "auto-settle") return { exists: true, value: await api.getServerSetting(AUTO_SETTLE_TARGET) };
  if (THREAD_KINDS.has(kind)) {
    const t = w.threads.get(target);
    if (!t) return { exists: false };
    return { exists: true, value: kind === "archive" ? t.archived : kind === "title" ? t.title : (t.settledOverride ?? null) };
  }
  const p = w.projects.find((x) => x.id === target);
  // A deleted project is the state `null` (listProjects drops deleted ones).
  if (kind === "project-delete") return { exists: true, value: p ? { title: p.title, workspaceRoot: p.workspaceRoot } : null };
  if (!p) return { exists: false };
  return { exists: true, value: kind === "project-title" ? p.title : p.pinned };
}

/** Reads T3 again for one target (after a write that threw). */
async function reread(api: T3Api, kind: OrganizeKind, target: string): Promise<Current> {
  return current(api, await loadWorld(api, [kind]), kind, target);
}

/** Sets `kind` on `target` to `value` through T3's API. project-delete only deletes (re-creating is undo's own step). */
async function write(api: T3Api, kind: OrganizeKind, target: string, value: unknown): Promise<void> {
  const bad = (): never => { throw new Error(`invalid ${kind} value ${JSON.stringify(value)}`); };
  switch (kind) {
    case "archive":
      if (typeof value !== "boolean") bad();
      return value ? api.archiveThread(target) : api.unarchiveThread(target);
    case "title":
      if (typeof value !== "string" || value.trim() === "") bad();
      return api.setThreadTitle(target, value as string);
    case "unsettle": case "settle": {
      // A backdated settle carries the date T3 Code records (sent only when backdating is on: src/t3/api.ts).
      if (isObj(value) && typeof value.settledAt === "string") return api.settleThread(target, value.settledAt);
      const shown = settleShown(kind, value);
      if (shown === "active") return api.unsettleThread(target);
      if (shown === "settled") return api.settleThread(target);
      return bad();
    }
    case "pin": case "unpin":
      if (typeof value !== "boolean") bad();
      return api.setProjectPinned(target, value as boolean);
    case "project-delete":
      if (value !== null) bad();
      return api.deleteProject(target);
    case "auto-settle":
      if (value !== null && typeof value !== "number") bad();
      await api.setAutoSettleAfterDays(value as number | null);
      return;
    case "project-title":
      if (typeof value !== "string" || value.trim() === "") bad();
      return api.setProjectTitle(target, value as string);
  }
}

/** Mirrors a change T3 accepted into the snapshot. */
function remember(w: World, kind: OrganizeKind, target: string, value: unknown): void {
  const t = w.threads.get(target);
  if (kind === "archive" && t) t.archived = value as boolean;
  else if (kind === "title" && t) t.title = value as string;
  else if ((kind === "unsettle" || kind === "settle") && t) t.settledOverride = settleShown(kind, value) as "settled" | "active";
  else if (kind === "pin" || kind === "unpin" || kind === "project-title") {
    const p = w.projects.find((x) => x.id === target);
    if (p && kind === "project-title") p.title = value as string;
    else if (p) p.pinned = value as boolean;
  } else if (kind === "project-delete" && value === null) w.projects = w.projects.filter((x) => x.id !== target);
}

/**
 * Runs `fn` (a write). When it throws an error after which T3 may have applied it (mayHaveApplied), reads T3 again and
 * returns true if T3 shows `want`. Returns the error message otherwise: a refusal is never confirmed.
 */
async function writeConfirmed(api: T3Api, kind: OrganizeKind, target: string, want: unknown, fn: () => Promise<void>): Promise<true | string> {
  try {
    await fn();
    return true;
  } catch (e) {
    if (!mayHaveApplied(e)) return msg(e);
    try {
      const c = await reread(api, kind, target);
      if (c.exists && same(c.value, want)) return true;
    } catch { /* report the write's own error */ }
    return msg(e);
  }
}

export async function applyOrganize(plan: OrganizePlan, d: ApplyOrganizeDeps): Promise<ApplyOrganizeResult> {
  organizeGate(d.api.version, { allowUntested: d.allowUntested ?? false, onNotice: d.onNotice });
  const r: ApplyOrganizeResult = { done: 0, skippedChanged: 0, failed: [], status: "ok" };
  if (plan.actions.length === 0) return r;
  const now = d.now ?? Date.now;
  const command = d.command === undefined ? "organize" : d.command;
  const j = d.journal;
  const w = await loadWorld(d.api, plan.actions.map((a) => a.kind));
  const refresh = refresher(d.api, w);

  let started = false;
  const begin = async (): Promise<void> => {
    if (started) return;
    if (command !== null) await appendOrStop(j, { t: "run-start", runId: d.runId, at: new Date(now()).toISOString(), command }, "before the first change; nothing was changed");
    started = true;
  };
  // Journaled before it is counted (the reason survives the run); a journal failure stops the run like any other write.
  const fail = async (a: OrganizeAction, error: string): Promise<string> => {
    const shown = failureText(error);
    await begin();
    await appendOrStop(j, { t: "organize-failed", runId: d.runId, kind: a.kind, target: a.target, projectId: a.projectId, error: shown },
      `after ${a.kind} ${a.target} failed (${shown}): the reason is not journaled`);
    r.failed.push({ action: a, error: shown });
    return `failed (${shown})`;
  };

  const one = async (a: OrganizeAction): Promise<string> => {
    let cur: Current;
    try {
      await refresh(a.kind);
      cur = await current(d.api, w, a.kind, a.target);
    } catch (e) { return await fail(a, `could not read T3 Code: ${msg(e)}`); }
    const stale = !cur.exists || !same(cur.value, a.previous)
      || (a.kind === "project-delete" && [...w.threads.values()].some((t) => t.projectId === a.target));
    if (stale) {
      r.skippedChanged++;
      return "skipped (changed in T3 Code since the plan)";
    }
    await begin();
    const ok = await writeConfirmed(d.api, a.kind, a.target, settleShown(a.kind, a.next), () => write(d.api, a.kind, a.target, a.next));
    if (ok !== true) return await fail(a, ok);
    remember(w, a.kind, a.target, a.next);
    await appendOrStop(j, { t: "organize-change", runId: d.runId, kind: a.kind, target: a.target, previous: a.previous, next: a.next },
      `after T3 Code accepted ${a.kind} ${a.target}: that change is in T3 Code but not journaled (the ${r.done} before it are)`);
    r.done++;
    return "done";
  };

  try {
    const n = plan.actions.length;
    for (const [i, a] of plan.actions.entries()) {
      if (d.aborted?.()) { r.status = "aborted"; break; }
      const outcome = await one(a);
      d.onProgress?.(`[${i + 1}/${n}] ${a.kind} ${a.target}: ${outcome}`);
    }
  } catch (e) {
    // The journal could not be written (JournalWriteError): stop; T3 may hold one change more than the journal.
    if (started && command !== null) await j.append({ t: "run-end", runId: d.runId, at: new Date(now()).toISOString(), status: "aborted" }).catch(() => {});
    throw e;
  }
  if (r.status !== "aborted") r.status = r.failed.length > 0 ? "partial" : "ok";
  if (started && command !== null) await j.append({ t: "run-end", runId: d.runId, at: new Date(now()).toISOString(), status: r.status });
  return r;
}

export interface UndoContext {
  api: T3Api;
  journal: Journal;
  /** Journals the undo's run-start once (first write) and returns its run id. */
  begin: () => Promise<string>;
  dryRun: boolean;
  platform: NodeJS.Platform;
  onProgress?: (line: string) => void;
  /** The whole journal (default: `entries`): finds projects an earlier undo of the same run re-created. */
  history?: JournalEntry[];
}

/** Projects re-created by earlier undos of `targetRunId` (runs whose run-start is `rollback <targetRunId>`). */
function recreatedBy(history: JournalEntry[], targetRunId: string): Set<string> {
  const undoRuns = new Set(history.filter((e) => e.t === "run-start" && e.command === `rollback ${targetRunId}`).map((e) => e.runId));
  return new Set(history.filter((e): e is Extract<JournalEntry, { t: "project-created" }> => e.t === "project-created" && undoRuns.has(e.runId)).map((e) => e.projectId));
}

/**
 * Reverts the `organize-change` entries of `targetRunId` among `entries` (journal order), newest first. Shared by
 * undoOrganize and rollbackRun, which own the run (run-start through `begin`, rolled-back, run-end).
 */
export async function undoOrganizeEntries(entries: JournalEntry[], targetRunId: string, c: UndoContext, items: OrganizeUndoItem[] = []): Promise<OrganizeUndoItem[]> {
  const mine = entries.filter((e): e is Extract<JournalEntry, { t: "organize-change" }> => e.t === "organize-change" && e.runId === targetRunId);
  if (mine.length === 0) return items;
  const valid = mine.filter((e) => typeof e.kind === "string" && KINDS.has(e.kind) && typeof e.target === "string" && e.target !== "");
  let w: World;
  try { w = await loadWorld(c.api, valid.map((e) => e.kind)); } catch (e) { throw new OrganizeReadError(`could not read T3 Code (${msg(e)})`); }
  const refresh = refresher(c.api, w);
  const recreated = recreatedBy(c.history ?? entries, targetRunId);
  const reverted = (): string => items.filter((x) => x.status === "reverted").map((x) => `${x.kind} ${x.target}`).join(", ") || "nothing";
  const begin = async (): Promise<string> => {
    try { return await c.begin(); } catch (err) {
      throw err instanceof JournalWriteError ? err : new JournalWriteError(`Could not write the journal (${msg(err)}) before the first revert; nothing was changed.`);
    }
  };
  /** Journals a revert T3 already holds; a failure stops the undo and says what is reverted (a rerun skips those). */
  const record = (e: JournalEntry, what: string): Promise<void> =>
    appendOrStop(c.journal, e, `after T3 Code accepted the undo of ${what}; reverted before it: ${reverted()}. Run the undo again: what is back already is skipped`);

  const one = async (e: Extract<JournalEntry, { t: "organize-change" }>): Promise<OrganizeUndoItem> => {
    // Labelled by what the change really is (a legacy follow carry, kind unsettle -> "settled", is a settle).
    const label = typeof e.kind === "string" ? changeKind(e.kind, e.next) : e.kind;
    const it = (status: OrganizeUndoItem["status"], note?: string): OrganizeUndoItem =>
      (note === undefined ? { kind: label, target: e.target, status } : { kind: label, target: e.target, status, note });
    if (!valid.includes(e)) return it("failed", "malformed organize-change journal entry");
    let cur: Current;
    try {
      await refresh(e.kind);
      cur = await current(c.api, w, e.kind, e.target);
    } catch (err) { return it("failed", `could not read T3 Code: ${msg(err)}`); }
    if (!cur.exists) return it("user-changed", "no longer exists in T3 Code");
    // A legacy follow carry (kind unsettle, next "settled") is a settle: its null previous means "shown".
    const kind = changeKind(e.kind, e.next);
    if (same(cur.value, settleShown(kind, e.previous))) return it("already");
    if (!same(cur.value, settleShown(kind, e.next))) return it("user-changed", `changed since: now ${JSON.stringify(cur.value)}`);

    if (e.kind === "project-delete") {
      const prev = e.previous;
      if (!isObj(prev) || typeof prev.title !== "string" || prev.title === "" || typeof prev.workspaceRoot !== "string" || prev.workspaceRoot === "") {
        return it("failed", "malformed organize-change journal entry (previous)");
      }
      const root = prev.workspaceRoot;
      const taken = (ps: T3Project[]) => ps.find((p) => sameCwd(p.workspaceRoot, root, c.platform));
      const there = taken(w.projects);
      if (there) return recreated.has(there.id) ? it("already") : it("user-changed", `a project for ${root} exists again`);
      if (c.dryRun) return it("reverted");
      const runId = await begin();
      let created: T3Project | undefined;
      try {
        created = await c.api.createProject(root, prev.title);
      } catch (err) {
        // T3 may have created it and the reply been lost: a project at that root now is the one just made.
        if (mayHaveApplied(err)) { try { created = taken(await c.api.listProjects()); } catch { /* report the create's own error */ } }
        if (!created) return it("failed", msg(err));
      }
      w.projects.push(created);
      const what = `${e.kind} ${e.target} (re-created as ${created.id})`;
      await record({ t: "project-created", runId, projectId: created.id, root, title: created.title }, what);
      await record({ t: "organize-undone", runId, targetRunId, kind: e.kind, target: e.target, previous: null, next: e.previous }, what);
      return it("reverted", `re-created as ${created.id}`);
    }

    if (c.dryRun) {
      remember(w, kind, e.target, e.previous);
      return it("reverted");
    }
    const runId = await begin();
    const ok = await writeConfirmed(c.api, kind, e.target, settleShown(kind, e.previous), () => write(c.api, kind, e.target, e.previous));
    if (ok !== true) return it("failed", ok);
    remember(w, kind, e.target, e.previous);
    await record({ t: "organize-undone", runId, targetRunId, kind: e.kind, target: e.target, previous: cur.value, next: e.previous }, `${e.kind} ${e.target}`);
    return it("reverted");
  };

  const n = mine.length;
  for (const [i, e] of [...mine].reverse().entries()) {
    const x = await one(e);
    items.push(x);
    c.onProgress?.(`[${i + 1}/${n}] undo ${x.kind} ${x.target}: ${x.status}${x.note ? ` (${x.note})` : ""}`);
  }
  return items;
}

/**
 * Refuses (ConfigError, exit 2) a run that did more than organize (a sync that imported, then organized what it
 * imported): undoing only its organize changes would journal `rolled-back` for the whole run while its imports and
 * files stay. `t3sm rollback --run <run>` undoes all of it.
 */
export function assertOrganizeOnly(entries: JournalEntry[], runId: string): void {
  if (entries.some((e) => e.runId === runId && !ORGANIZE_RUN_KINDS.has(e.t))) {
    throw new ConfigError(`This run also imported conversations; use \`t3sm rollback --run ${runId}\` to undo all of it.`);
  }
}

/** Reverts one organize run (`t3sm organize --undo <run>`); journals itself as `rollback <run>`, like `t3sm rollback`. */
export async function undoOrganize(runId: string, d: UndoOrganizeDeps): Promise<UndoOrganizeResult> {
  const j = d.journal;
  const all = await j.readAll();
  if (!all.some((e) => e.runId === runId)) throw new ConfigError(`No run ${runId} in the journal. Run \`t3sm runs\` to list them.`);
  if (all.some((e) => e.t === "run-start" && e.runId === runId && typeof e.command === "string" && e.command.startsWith("rollback"))) {
    throw new ConfigError("Cannot roll back a rollback run.");
  }
  assertOrganizeOnly(all, runId);
  organizeGate(d.api.version, { allowUntested: d.allowUntested ?? false, onNotice: d.onNotice });

  let rb: string | null = null;
  const begin = async (): Promise<string> => {
    if (rb === null) {
      const id = newRunId(new Date(d.now()));
      await j.append({ t: "run-start", runId: id, at: new Date(d.now()).toISOString(), command: `rollback ${runId}` });
      rb = id;
    }
    return rb;
  };
  let items: OrganizeUndoItem[];
  try {
    items = await undoOrganizeEntries(all, runId, {
      api: d.api, journal: j, begin, dryRun: d.dryRun ?? false, platform: d.platform ?? process.platform, onProgress: d.onProgress,
    });
  } catch (e) {
    if (rb !== null) await j.append({ t: "run-end", runId: rb, at: new Date(d.now()).toISOString(), status: "aborted" }).catch(() => {});
    throw e;
  }
  const failed = items.filter((x) => x.status === "failed").map((x) => ({ kind: x.kind, target: x.target, error: x.note ?? "failed" }));
  if (rb !== null) {
    const at = new Date(d.now()).toISOString();
    await j.append({ t: "rolled-back", runId: rb, targetRunId: runId, at });
    await j.append({ t: "run-end", runId: rb, at, status: failed.length > 0 ? "partial" : "ok" });
  }
  return {
    runId: rb,
    reverted: items.filter((x) => x.status === "reverted").length,
    skippedUserChanged: items.filter((x) => x.status === "user-changed").length,
    alreadyRestored: items.filter((x) => x.status === "already").length,
    failed,
    items,
  };
}
