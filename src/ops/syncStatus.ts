// <state>/sync-status.json: what an unattended `sync` leaves for a person to see (spec 4.7) next to the watcher's
// heartbeat (pid, startedAt, lastCycleAt, lastResult, nextCycleAt; src/ops/watch.ts).
//   needsAttention  one reason at a time, with the command that fixes it; `since` is the first time the SAME reason was
//                   seen (it is not reset by every cycle) and goes back to null as soon as the reason is gone.
//   undecided       sessions waiting for an organize question, per question key.
//   heldRehome      copies from refused folders waiting for a destination folder that does not exist in T3 yet.
//   failures        consecutive failing cycles (three raise `repeated-failures`).
//   lastNotified   reason -> ISO time of the last system notification (src/ops/notify.ts: one per reason per 24 h).
//   followConflicts rehome copies continued both in T3 Code and outside it (src/ops/follow.ts): both titles and the
//                   session ids of the original and the copy, never a path. Replaced by every cycle that ran the
//                   follow step; absent when there is none.
//   lastHistoryAt   ISO time of sync's last complete daily pass of the history rule (src/ops/sync.ts): the next one runs
//                   24 h later; absent when none ran yet, or when a pass left changes for the next cycle.
//   updateFailure   the last t3sm update that failed, was rolled back or was interrupted ({ from, to, outcome, at }:
//                   versions only, never the error, which may name a folder; that is in the journal). A failed or
//                   interrupted one raises `update-failed` (the lowest reason) until an update installs
//                   (recordUpdateOutcome); a rolled-back one never does (t3sm recovered: `status` shows it as info).
// Written by both a one-shot `sync` and the watcher: every write merges into what the file holds, and nothing is written
// when nothing changed (a quiet cycle leaves the file alone). Never holds paths, the heartbeat's `lastResult` included
// (sync.resultSummary keeps a held project's name, title and time only); held conversation titles are kept for
// `t3sm status`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../core/fsutil.ts";
import { parseSemver } from "../core/semver.ts";
import { cliT } from "../i18n/cli.ts";

export type AttentionReason = "undecided" | "over-limit" | "signed-out" | "t3-incompatible" | "repeated-failures" | "update-failed";
/**
 * The values an attention reason is about, recorded next to its English `detail` so a screen or a notification words
 * it in any language (src/ops/notify.ts attentionText) without reading the English back. Absent in files written by
 * t3sm 0.3.0 and older.
 */
export interface AttentionFacts { n?: number; q?: number; limit?: number; version?: string; from?: string; to?: string; outcome?: string }
export interface NeedsAttention { reason: AttentionReason; detail: string; command: string; since: string; facts?: AttentionFacts }

/** Only the known facts, of the right type (the file may come from another version). */
function factsOf(v: unknown): AttentionFacts | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: AttentionFacts = {};
  for (const k of ["n", "q", "limit"] as const) if (typeof o[k] === "number" && Number.isFinite(o[k])) out[k] = o[k] as number;
  for (const k of ["version", "from", "to", "outcome"] as const) if (typeof o[k] === "string") out[k] = o[k] as string;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A failing streak of `n` cycles: needs a person (repeated-failures). */
export function streakAttention(n: number): Omit<NeedsAttention, "since"> {
  return { reason: "repeated-failures", detail: cliT("en", "notify.failures", { n }), command: "t3sm doctor", facts: { n } };
}

/** A rehome copy and its original, both continued (nothing done): titles and session ids only, never a path. */
export interface FollowConflictEntry { originalId: string; copyId: string; originalTitle: string; copyTitle: string }

/**
 * A project held because one of its conversations is in use: names and time only, never a path. `since`: when a cycle
 * first saw the project held (kept while later cycles still see it; recordSyncStatus sets it), absent in older files.
 */
export interface HeldEntry { project: string; title: string | null; modifiedAt: string; since?: string }

export interface SyncStatusFields {
  /** Replaced by every cycle that looked (an empty list clears it). */
  held: HeldEntry[];
  needsAttention: NeedsAttention | null;
  undecided: Record<string, number>;
  heldRehome: number;
  failures: number;
  /** Present only when there is at least one. */
  followConflicts?: FollowConflictEntry[];
}

/** Highest first: the one reason a person sees when several apply (a specific cause beats a generic streak). */
export const ATTENTION_PRIORITY: readonly AttentionReason[] = ["t3-incompatible", "signed-out", "repeated-failures", "over-limit", "undecided", "update-failed"];
const rank = (r: AttentionReason): number => ATTENTION_PRIORITY.indexOf(r);

/** Consecutive failing cycles that raise `repeated-failures`. */
export const REPEATED_FAILURES = 3;

const FILE = "sync-status.json";
const REASONS: ReadonlySet<string> = new Set(ATTENTION_PRIORITY);

async function readRaw(stateDir: string): Promise<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse(await readFile(join(stateDir, FILE), "utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

function fieldsOf(raw: Record<string, unknown>): SyncStatusFields {
  const na = raw["needsAttention"] as Partial<NeedsAttention> | null | undefined;
  const ok = na && typeof na === "object" && typeof na.reason === "string" && REASONS.has(na.reason) && typeof na.since === "string"
    && typeof na.detail === "string" && typeof na.command === "string";
  const u = raw["undecided"];
  const undecided: Record<string, number> = {};
  if (u && typeof u === "object") for (const [k, n] of Object.entries(u)) if (typeof n === "number") undecided[k] = n;
  const h = raw["held"];
  const held: HeldEntry[] = [];
  if (Array.isArray(h)) for (const e of h as unknown[]) {
    const o = e as Record<string, unknown> | null;
    if (o && typeof o === "object" && typeof o["project"] === "string" && typeof o["modifiedAt"] === "string") {
      held.push({ project: o["project"], title: typeof o["title"] === "string" ? o["title"] : null, modifiedAt: o["modifiedAt"], ...(typeof o["since"] === "string" ? { since: o["since"] } : {}) });
    }
  }
  const fc = raw["followConflicts"];
  const followConflicts: FollowConflictEntry[] = [];
  if (Array.isArray(fc)) for (const e of fc as unknown[]) {
    const o = e as Record<string, unknown> | null;
    if (o && typeof o === "object" && typeof o["originalId"] === "string" && typeof o["copyId"] === "string" && typeof o["originalTitle"] === "string" && typeof o["copyTitle"] === "string") {
      followConflicts.push({ originalId: o["originalId"], copyId: o["copyId"], originalTitle: o["originalTitle"], copyTitle: o["copyTitle"] });
    }
  }
  return {
    held,
    needsAttention: ok ? (() => {
      const a = na as NeedsAttention;
      const facts = factsOf(a.facts);
      return { reason: a.reason, detail: a.detail, command: a.command, since: a.since, ...(facts ? { facts } : {}) };
    })() : null,
    undecided,
    heldRehome: typeof raw["heldRehome"] === "number" ? raw["heldRehome"] : 0,
    failures: typeof raw["failures"] === "number" ? raw["failures"] : 0,
    ...(followConflicts.length > 0 ? { followConflicts } : {}),
  };
}

export async function readSyncStatus(stateDir: string): Promise<SyncStatusFields> {
  return fieldsOf(await readRaw(stateDir));
}

/** Whether a sync cycle ever recorded `undecided` in the file (a 0.2.1 watcher never does). */
export async function recordsUndecided(stateDir: string): Promise<boolean> {
  return "undecided" in (await readRaw(stateDir));
}

/** What one cycle saw. `attention` undefined: the cycle could not tell (an error): keep what the file says. */
export interface Observed {
  attention?: Omit<NeedsAttention, "since"> | null;
  undecided?: Record<string, number>;
  heldRehome?: number;
  held?: HeldEntry[];
  /** Set when the follow step ran (an empty list clears the field); undefined: keep what the file says. */
  followConflicts?: FollowConflictEntry[];
  /** "failed": one more failing cycle; "ok": the streak ends; "unchanged": neither (aborted). */
  cycle: "failed" | "ok" | "unchanged";
}

/** Deep equality of JSON values, whatever the key order (objects compared by sorted keys). */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Merges one cycle into the file. Returns what the file holds now. */
export async function recordSyncStatus(stateDir: string, o: Observed, now: Date): Promise<SyncStatusFields> {
  const raw = await readRaw(stateDir);
  const prev = fieldsOf(raw);
  const failures = o.cycle === "failed" ? prev.failures + 1 : o.cycle === "ok" ? 0 : prev.failures;
  let attention: Omit<NeedsAttention, "since"> | null | undefined = o.attention;
  // A failing streak competes with the cycle's own reason by rank (ATTENTION_PRIORITY): the more specific, actionable cause wins.
  if (failures >= REPEATED_FAILURES) {
    const streak = streakAttention(failures);
    if (!attention || rank(streak.reason) < rank(attention.reason)) attention = streak;
  }
  // A failed update (the lowest reason) shows whenever nothing else needs a person; a cycle that could not tell keeps the
  // file's. A rolled-back one is not a need (the previous version runs): it never raises the reason.
  const failure = updateFailureOf(raw);
  if (attention === null && failure !== null && failure.outcome !== "rolled-back") attention = updateFailedAttention(failure);
  let needsAttention: NeedsAttention | null;
  if (attention === undefined) needsAttention = prev.needsAttention;
  else if (attention === null) needsAttention = null;
  else if (attention.reason === "update-failed" && failure !== null) needsAttention = { ...attention, since: failure.at };
  else needsAttention = { ...attention, since: prev.needsAttention?.reason === attention.reason ? prev.needsAttention.since : now.toISOString() };
  const next: SyncStatusFields = {
    needsAttention,
    undecided: o.undecided ?? prev.undecided,
    heldRehome: o.heldRehome ?? prev.heldRehome,
    // A project still held keeps the time a cycle first saw it held; a new one is held since now.
    held: o.held ? o.held.map((h) => ({ ...h, since: prev.held.find((p) => p.project === h.project)?.since ?? h.since ?? now.toISOString() })) : prev.held,
    failures,
  };
  const conflicts = o.followConflicts ?? prev.followConflicts ?? [];
  if (conflicts.length > 0) next.followConflicts = conflicts;
  // A cycle that looked always leaves the `undecided` key (even {}): `status` reads its presence as "a 0.3 cycle
  // recorded the questions" (a 0.2.1 watcher never writes it), so a file without it must get it now.
  if (!same(prev, next) || (o.undecided !== undefined && !("undecided" in raw))) {
    const out: Record<string, unknown> = { ...raw, ...next };
    if (next.followConflicts === undefined) delete out["followConflicts"];
    await atomicWrite(join(stateDir, FILE), JSON.stringify(out, null, 2) + "\n");
  }
  return next;
}

/** The watcher's heartbeat, written over its own fields only: what a cycle recorded stays. */
export async function writeHeartbeatMerged(stateDir: string, heartbeat: object): Promise<void> {
  const raw = await readRaw(stateDir);
  const keep: Record<string, unknown> = {};
  for (const k of ["needsAttention", "undecided", "heldRehome", "held", "failures", "lastNotified", "followConflicts", "lastHistoryAt", "updateFailure"]) if (k in raw) keep[k] = raw[k];
  await atomicWrite(join(stateDir, FILE), JSON.stringify({ ...keep, ...heartbeat }, null, 2) + "\n");
}

/** When sync's daily history pass last completed (epoch ms); null when never, or unreadable. */
export async function readLastHistoryAt(stateDir: string): Promise<number | null> {
  const v = (await readRaw(stateDir))["lastHistoryAt"];
  const at = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** Records (or, with null, clears) sync's daily history pass, merged into what the file holds. */
export async function markHistoryPass(stateDir: string, at: Date | null): Promise<void> {
  const raw = await readRaw(stateDir);
  const out: Record<string, unknown> = { ...raw };
  if (at === null) {
    if (!("lastHistoryAt" in raw)) return;
    delete out["lastHistoryAt"];
  } else out["lastHistoryAt"] = at.toISOString();
  await atomicWrite(join(stateDir, FILE), JSON.stringify(out, null, 2) + "\n");
}

/** reason -> ISO time of the last system notification (invalid entries dropped). */
export async function readLastNotified(stateDir: string): Promise<Record<string, string>> {
  const v = (await readRaw(stateDir))["lastNotified"];
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, t] of Object.entries(v)) if (typeof t === "string") out[k] = t;
  return out;
}

/** Records a notification for `reason`, merged into what the file holds (the cycle's fields and the heartbeat stay). */
export async function markNotified(stateDir: string, reason: string, at: Date): Promise<void> {
  const raw = await readRaw(stateDir);
  const lastNotified = { ...(await readLastNotified(stateDir)), [reason]: at.toISOString() };
  await atomicWrite(join(stateDir, FILE), JSON.stringify({ ...raw, lastNotified }, null, 2) + "\n");
}

// ---------- update-failed ----------

/** The last update that did not install (versions and time only: never the error, which may name a folder). */
export interface UpdateFailure { from: string; to: string; outcome: "failed" | "rolled-back" | "interrupted"; at: string }

/** The last update that did not install, as recorded by recordUpdateOutcome; null when none (or unreadable). */
export async function readUpdateFailure(stateDir: string): Promise<UpdateFailure | null> {
  return updateFailureOf(await readRaw(stateDir));
}

/** The words `status` and the attention reason use for a failed, rolled-back or interrupted update. */
export function updateFailureText(f: UpdateFailure): string {
  return updateFailedAttention(f).detail;
}

function updateFailureOf(raw: Record<string, unknown>): UpdateFailure | null {
  const f = raw["updateFailure"] as Partial<UpdateFailure> | null | undefined;
  if (!f || typeof f !== "object" || typeof f.from !== "string" || typeof f.to !== "string" || typeof f.at !== "string") return null;
  if (f.outcome !== "failed" && f.outcome !== "rolled-back" && f.outcome !== "interrupted") return null;
  // A version that is not a release version is unknown: the failure is still reported, the text never carries it.
  const v = (x: string): string => (parseSemver(x) !== null ? x : "unknown");
  return { from: v(f.from), to: v(f.to), outcome: f.outcome, at: f.at };
}

function updateFailedAttention(f: UpdateFailure): Omit<NeedsAttention, "since"> {
  const detail = f.outcome === "rolled-back" ? `t3sm ${f.to} did not start properly, so ${f.from} was put back`
    : f.outcome === "interrupted" ? `The update of t3sm from ${f.from} to ${f.to} was interrupted`
    : `Updating t3sm from ${f.from} to ${f.to} failed; ${f.from} is still installed`;
  return { reason: "update-failed", detail, command: "t3sm update --check", facts: { from: f.from, to: f.to, outcome: f.outcome } };
}

/**
 * After an update (`t3sm update`, the watcher's `update --auto-run` child, or an interrupted one found at the watcher's
 * start): a failed, rolled-back or interrupted one is kept in `updateFailure`. A failed or interrupted one raises
 * `update-failed` now when nothing else needs a person (later cycles keep it, see recordSyncStatus); a rolled-back one
 * never does, and clears an older failure's `update-failed` (status ranks it info, and `--json` must agree). An installed
 * one clears both. `since` is the failure's time. Merged into what the file holds; nothing is written when nothing
 * changes. Throws on a write error.
 */
export async function recordUpdateOutcome(
  stateDir: string, u: { outcome: "installed" | "failed" | "rolled-back" | "interrupted"; from: string; to: string; error?: string }, now: Date,
): Promise<void> {
  const raw = await readRaw(stateDir);
  const prev = fieldsOf(raw).needsAttention;
  const out: Record<string, unknown> = { ...raw };
  if (u.outcome === "installed") {
    if (!("updateFailure" in raw) && prev?.reason !== "update-failed") return;
    delete out["updateFailure"];
    if (prev?.reason === "update-failed") out["needsAttention"] = null;
  } else {
    const failure: UpdateFailure = { from: u.from, to: u.to, outcome: u.outcome, at: now.toISOString() };
    out["updateFailure"] = failure;
    if (u.outcome === "rolled-back") { if (prev?.reason === "update-failed") out["needsAttention"] = null; }
    else if (prev === null || prev.reason === "update-failed") out["needsAttention"] = { ...updateFailedAttention(failure), since: failure.at };
  }
  if (!same(raw, out)) await atomicWrite(join(stateDir, FILE), JSON.stringify(out, null, 2) + "\n");
}
