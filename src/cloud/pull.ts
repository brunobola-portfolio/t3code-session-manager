// `t3sm cloud pull` without the screens (spec 2026-11-26 §4.2-4.4). Three parts:
//
//   previewPull  - read-only: where each session's code and transcript would go (no git, no writes).
//   writePulls   - under the lock, after the recovery: per session, the transcript (network: `claude`), the checkout
//                  (network: git), then the local transcript, journaled before it is published and never over a file
//                  t3sm did not write (invariants 1, 4, 5, 6). Its run is the one the import then continues.
//   (the import) - the caller runs applyPlan with the same runId over the plan items of the written sessions.
//
// A session that went on in the cloud after an untouched pull gets a revision file (a new id) and its old thread is
// archived once the new one is in T3 Code (`revisionOf` below). A session continued here is a conflict: nothing is
// written.

import { mkdir, open, rm, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AccountConfig, JournalEntry } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { encodeClaudeProjectDir, normalizeCwd } from "../core/paths.ts";
import { MoveRefused, publishNoClobber, sha256File, statSafe, writeTempPath, type LinkFs } from "../core/fsutil.ts";
import { isActive } from "../core/activity.ts";
import { writtenMtime } from "../apply/materialize.ts";
import { link, unlink } from "node:fs/promises";
import type { CloudConn } from "./client.ts";
import { getCloudTranscript } from "./client.ts";
import type { CloudSession } from "./decode.ts";
import { CheckoutFailed, CheckoutRefused, findCheckout, planCheckout, prepareCheckout, type CheckoutPlan, type Git } from "./checkout.ts";
import { cloudLocalId, isCompacted, messageCount, toLocalTranscript } from "./transcript.ts";
import { localState, type CloudLocalState, type CloudWrite } from "./state.ts";

export interface PullTarget { account: AccountConfig; session: CloudSession }

export interface PreviewItem {
  target: PullTarget;
  state: CloudLocalState;
  write: CloudWrite | null;
  /** Where the code goes, or why it cannot (a refused name, a folder in the way). */
  checkout: { ok: true; plan: CheckoutPlan } | { ok: false; reason: CheckoutRefused["reason"]; message: string };
  /** What the pull does with it. */
  todo: "pull" | "update" | "nothing" | "conflict" | "refused";
}

/** Read-only: what pulling each target would do. `roots`: the main checkouts to look for its repository in. */
export async function previewPull(targets: PullTarget[], o: { base: string; roots: readonly string[]; writes: Map<string, CloudWrite>; platform: NodeJS.Platform }): Promise<PreviewItem[]> {
  const out: PreviewItem[] = [];
  for (const t of targets) {
    const { state, write } = await localState(t.session, o.writes.get(t.session.id));
    let checkout: PreviewItem["checkout"];
    try {
      const existing = t.session.repo ? await findCheckout(t.session.repo, o.roots) : null;
      checkout = { ok: true, plan: await planCheckout(t.session, o.base, existing, o.platform) };
    } catch (e) {
      if (!(e instanceof CheckoutRefused)) throw e;
      checkout = { ok: false, reason: e.reason, message: e.message };
    }
    const todo: PreviewItem["todo"] = !checkout.ok ? "refused"
      : state === "remote" ? "pull" : state === "newer" ? "update" : state === "continued" ? (laterInCloud(t.session, write) ? "conflict" : "nothing") : "nothing";
    out.push({ target: t, state, write, checkout, todo });
  }
  return out;
}

const laterInCloud = (s: CloudSession, w: CloudWrite | null): boolean =>
  w !== null && s.lastEventAt !== null && Date.parse(s.lastEventAt) > Date.parse(w.cloudOf.lastEventAt ?? "") + 1000;

export type PullOutcome =
  | { kind: "written"; localId: string; cwd: string; file: string; revisionOf: string | null; messages: number; compacted: boolean; branchGone: boolean; checkout: { cloned: string | null; worktree: string | null } }
  | { kind: "deferred"; why: "active" }
  | { kind: "failed"; why: "transcript" | "checkout" | "target-exists" | "write" | "empty"; detail: string }
  | { kind: "skipped"; why: "nothing" | "conflict" | "refused" };

export interface WriteDeps {
  journal: Journal;
  runId: string;
  now: () => number;
  platform: NodeJS.Platform;
  /** An open `claude` child for the account (opened once per account by the caller). */
  conn(account: AccountConfig): Promise<CloudConn>;
  git: Git;
  fs?: LinkFs;
  /** One line per step, for the progress on screen. */
  onStep?: (item: PreviewItem, step: "transcript" | "checkout" | "write") => void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The file of a session in its account: `<home>/projects/<encoded cwd>/<id>.jsonl`. */
export function cloudTarget(accountHome: string, cwd: string, localId: string, platform: NodeJS.Platform): string {
  const P = platform === "win32" ? path.win32 : path.posix;
  return P.join(accountHome, "projects", encodeClaudeProjectDir(normalizeCwd(cwd, platform)), `${localId}.jsonl`);
}

async function writeOne(item: PreviewItem, d: WriteDeps): Promise<PullOutcome> {
  if (item.todo === "nothing" || item.todo === "conflict" || item.todo === "refused") return { kind: "skipped", why: item.todo };
  if (!item.checkout.ok) return { kind: "skipped", why: "refused" };
  const { account, session: s } = item.target;
  const lastMs = s.lastEventAt === null ? NaN : Date.parse(s.lastEventAt);
  const mtimeMs = writtenMtime(lastMs, d.now());
  // Active in the cloud within the last 10 minutes: it waits (invariant 5), before any network work.
  if (isActive(mtimeMs, d.now())) return { kind: "deferred", why: "active" };

  d.onStep?.(item, "transcript");
  let entries;
  try {
    entries = await getCloudTranscript(await d.conn(account), s.id);
  } catch (e) {
    return { kind: "failed", why: "transcript", detail: errText(e) };
  }
  if (entries.length === 0) return { kind: "failed", why: "empty", detail: "the cloud returned no transcript entries" };
  // Newer only by its time (a rename, an archive): no new turns, so no revision (it would only duplicate the thread).
  if (item.state === "newer" && item.write && entries.length <= item.write.cloudOf.entries) return { kind: "skipped", why: "nothing" };

  d.onStep?.(item, "checkout");
  let co;
  try {
    co = await prepareCheckout(item.checkout.plan, d.git, d.platform);
  } catch (e) {
    return { kind: "failed", why: "checkout", detail: e instanceof CheckoutFailed ? e.message : errText(e) };
  }
  if (co.cloned !== null || co.worktreeAdded !== null) {
    const main = item.checkout.plan.kind === "repo" ? item.checkout.plan.main : null;
    await d.journal.append({ t: "cloud-checkout", runId: d.runId, sessionId: s.id, cloned: co.cloned, worktree: co.worktreeAdded, main });
  }

  d.onStep?.(item, "write");
  const revisionOf = item.state === "newer" && item.write ? path.basename(item.write.path, ".jsonl") : null;
  const localId = revisionOf === null ? cloudLocalId(s.id) : cloudLocalId(s.id, entries.length);
  const cwd = d.platform === "win32" ? path.win32.normalize(co.cwd) : co.cwd;
  const branch = item.checkout.plan.kind === "repo" && !co.branchGone ? item.checkout.plan.branch : null;
  const cloudOf = { account: account.id, sessionId: s.id, lastEventAt: s.lastEventAt, entries: entries.length };
  const text = toLocalTranscript(entries, { sessionId: localId, cwd, gitBranch: branch, provenance: { fromCloudSession: s.id, fromAccount: account.id, lastEventAt: s.lastEventAt, entries: entries.length } });
  const sha = createHash("sha256").update(text, "utf8").digest("hex");
  const file = cloudTarget(account.home, cwd, localId, d.platform);
  const written: PullOutcome = { kind: "written", localId, cwd, file, revisionOf, messages: messageCount(entries), compacted: isCompacted(entries), branchGone: co.branchGone, checkout: { cloned: co.cloned, worktree: co.worktreeAdded } };

  const there = await statSafe(file);
  if (there !== null) {
    // The same bytes already there (an earlier pull of this exact state, a re-run): nothing to write.
    if ((await sha256File(file).catch(() => null)) === sha) return written;
    return { kind: "failed", why: "target-exists", detail: `${file} already exists` };
  }
  const dir = path.dirname(file);
  let tmp: string | null = null;
  try {
    await mkdir(dir, { recursive: true });
    tmp = writeTempPath(dir, localId);
    const fh = await open(tmp, "wx");
    try { await fh.writeFile(text, "utf8"); await fh.sync(); } finally { await fh.close(); }
    await utimes(tmp, mtimeMs / 1000, mtimeMs / 1000);
    const entry: JournalEntry = { t: "file-written", runId: d.runId, path: file, sha256: sha, mtimeMs, cloudOf };
    await d.journal.append(entry);
    try {
      await publishNoClobber(tmp, file, d.fs ?? { link, unlink });
      tmp = null;
    } catch (e) {
      await d.journal.append({ t: "file-write-aborted", runId: d.runId, path: file });
      if (e instanceof MoveRefused && e.code === "EEXIST") return { kind: "failed", why: "target-exists", detail: e.message };
      throw e;
    }
  } catch (e) {
    return { kind: "failed", why: "write", detail: errText(e) };
  } finally {
    if (tmp !== null) await rm(tmp, { force: true }).catch(() => {});
  }
  return written;
}

/** Writes every item that needs it, in order. Never throws for one session; a journal failure stops the run. */
export async function writePulls(items: PreviewItem[], d: WriteDeps): Promise<{ item: PreviewItem; outcome: PullOutcome }[]> {
  const out: { item: PreviewItem; outcome: PullOutcome }[] = [];
  for (const item of items) out.push({ item, outcome: await writeOne(item, d) });
  return out;
}
