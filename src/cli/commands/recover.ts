// t3sm recover <session-id> [--dry-run | --yes] [--allow-untested]
//
// Brings back one conversation started in T3 Code whose T3 thread is gone, when t3sm cannot tell that by itself: its
// transcript names no T3 thread (the plan skips it as `t3-native-unknown`), so only the user knows the thread was
// deleted. It refuses unless the session was started in T3 Code and no T3 thread t3sm can see holds it. The conversation
// comes back the way an orphaned one does (organize.sessions.orphaned "copy"): a faithful copy with a new session id,
// written and imported by apply (journaled; `t3sm rollback --run <id> --archive-threads` undoes it). If the thread
// still exists in T3 Code where t3sm cannot see it, this makes a duplicate: the screen says so before asking.
//
// Writes ask (invariant 12): without a terminal it needs --yes, and --dry-run writes nothing. The real run plans under
// the lock, after the recovery of pending file times, before it contacts T3 Code (applyPlan's loader: invariant 3).

import { homedir } from "node:os";
import type { Action, Plan, PlanItem, SkipReason } from "../../core/types.ts";
import { expandHome, sameCwd, stateDir, tildePath } from "../../core/paths.ts";
import { defaultConfig, loadConfig } from "../../core/config.ts";
import { applyPlan, type ApplyResult, type SignalSource } from "../../apply/apply.ts";
import { connectT3, type T3Api } from "../../t3/api.ts";
import { allAdapters } from "../../sources/registry.ts";
import type { SourceAdapter } from "../../sources/types.ts";
import type { FolderEnv } from "../../plan/folders.ts";
import { orphanUuid } from "../../plan/planner.ts";
import { SKIP_WORDS } from "../../plan/report.ts";
import { shownText } from "../../plan/names.ts";
import { freshPlan } from "./plan.ts";
import { defaultFolderEnv } from "./apply.ts";
import { discoverAll, makeEnv } from "./scan.ts";
import { importProgress, renderApplyResult } from "../applyScreen.ts";
import { FAILURES_SHOWN } from "../failures.ts";
import { reportLockBusy } from "../locked.ts";
import { FLAG_SPECS } from "../flags.ts";
import type { Io } from "../main.ts";
import { cliUi, confirm, unknownOption, usageLine, type CliKey, type CliUi } from "../ui.ts";
import { noteLines, snugWidth } from "../screen.ts";
import { kv, panel } from "../../ui/components.ts";
import { folderName } from "../words.ts";

export interface RecoverDeps {
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  adapters?: SourceAdapter[];
  existsDir?: (p: string) => Promise<boolean>;
  signals?: SignalSource;
  platform?: NodeJS.Platform;
  /** How a destination folder is classified before it is created (default: this machine, as apply does). */
  folderEnv?: FolderEnv;
}

const FLAGS = new Set<string>(FLAG_SPECS.recover.bool);
/** A session id, or the start of one (at least 8 characters, as `t3sm status` shows them). */
const ID_RE = /^[0-9A-Fa-f-]{8,36}$/;

type CopyItem = PlanItem & { action: Extract<Action, { kind: "convert-import" }> };
export type RecoverPick =
  | { ok: true; item: CopyItem; name: string }
  | { ok: false; key: CliKey; vars: Record<string, string | number>; reason?: SkipReason };

/** "demo (claude 1a2b3c4d)": the project folder's name and the short id, as `t3sm status` names a session. */
function sessionName(i: PlanItem): string {
  const s = i.session;
  const id = `claude ${shownText(s.nativeId.slice(0, 8), 8)}`;
  return s.cwd ? `${shownText(folderName(s.cwd), 60)} (${id})` : id;
}

/**
 * The plan item that brings session `id` back (a plan built with `recover` matching it), or why it cannot come back:
 * not found, ambiguous (a short id matching two sessions), not started in T3 Code, still in T3 Code (its thread, or a
 * copy already brought back), an account without a T3 Code instance, or skipped for another reason (in use, ...).
 */
export function pickRecover(plan: Plan, id: string): RecoverPick {
  const want = id.toLowerCase();
  const items = plan.items.filter((i) => i.session.harness === "claude" && i.session.nativeId.toLowerCase().startsWith(want));
  const ids = new Set(items.map((i) => i.session.nativeId));
  if (ids.size === 0) return { ok: false, key: "recover.notFound", vars: { id: shownText(id, 40) } };
  if (ids.size > 1) return { ok: false, key: "recover.ambiguous", vars: { id: shownText(id, 40), n: ids.size } };
  const nativeId = [...ids][0]!;
  const name = sessionName(items[0]!);
  const copy = items.find((i): i is CopyItem => i.action.kind === "convert-import" && i.action.uuid === orphanUuid(nativeId));
  if (copy) {
    if (plan.instancesToCreate.some((x) => x.id === copy.action.instanceId)) return { ok: false, key: "recover.needsInstance", vars: { name } };
    return { ok: true, item: copy, name };
  }
  if (!items.some((i) => i.session.startedIn === "t3")) return { ok: false, key: "recover.notNative", vars: { name } };
  if (items.some((i) => i.notes.includes("recovered"))) return { ok: false, key: "recover.already", vars: { name } };
  const reasons = items.flatMap((i) => (i.action.kind === "skip" ? [i.action.reason] : []));
  if (reasons.includes("already-in-t3")) return { ok: false, key: "recover.inT3", vars: { name } };
  // The reason of the session's own item (T3-native, not a mirror or a duplicate of it in another account) says why.
  const own = items.find((i) => i.session.startedIn === "t3" && i.action.kind === "skip" && i.action.reason !== "mirror-copy" && i.action.reason !== "duplicate");
  const reason = own?.action.kind === "skip" ? own.action.reason : reasons[0] ?? "already-in-t3";
  return { ok: false, key: "recover.skipped", vars: { name }, reason };
}

/** The plan as the run goes: only the copy, and the project its folder needs (no instance, pin or mirror work). */
export function recoverPlan(plan: Plan, item: CopyItem, platform: NodeJS.Platform): Plan {
  const same = (r: string): boolean => sameCwd(r, item.action.projectRoot, platform);
  const projectsToCreate = plan.projectsToCreate.filter((p) => same(p.root));
  return {
    ...plan, items: [item], instancesToCreate: [], projectsToCreate, mirrorCopies: [], pinDefault: null,
    projectDefaults: plan.projectDefaults.filter((d) => same(d.root) && projectsToCreate.length > 0),
  };
}

class RecoverRefused extends Error {
  readonly pick: Extract<RecoverPick, { ok: false }>;
  constructor(pick: Extract<RecoverPick, { ok: false }>) { super(pick.key); this.pick = pick; }
}

/** What will happen, as a panel, and the duplicate warning under it. */
function willLines(ui: CliUi, p: Extract<RecoverPick, { ok: true }>, home: string, platform: NodeJS.Platform): string[] {
  const { s, t } = ui;
  const width = Math.max(1, ui.width);
  const body = kv(s, [
    [t("recover.row.conversation"), p.name],
    [t("recover.row.newId"), shownText(p.item.action.uuid, 40)],
    [t("recover.row.project"), s("path", shownText(tildePath(p.item.action.projectRoot, home, platform), 200))],
    [t("recover.row.undo"), s("key", "t3sm rollback --run <id> --archive-threads")],
  ], Math.max(1, width - 4));
  const title = t("recover.title");
  return [...panel(s, { title, body }, snugWidth(title, body, width)), "", ...noteLines(s, "warn", t("recover.duplicate"), width)];
}

function refuse(io: Io, ui: CliUi, p: Extract<RecoverPick, { ok: false }>): number {
  const vars = p.reason !== undefined ? { ...p.vars, why: ui.t(SKIP_WORDS[p.reason]) } : p.vars;
  io.stderr(noteLines(ui.s, "err", ui.t(p.key, vars), Math.max(1, ui.width)).join("\n") + "\n");
  return 2;
}

export async function recoverCommand(args: string[], io: Io, deps: RecoverDeps = {}): Promise<number> {
  const flags = new Set<string>();
  let id: string | null = null;
  for (const a of args) {
    if (FLAGS.has(a)) flags.add(a);
    else if (a.startsWith("-")) { unknownOption(io, a, "recover"); return 2; }
    else if (id === null) id = a;
    else { usageLine(io, "recover.oneId"); return 2; }
  }
  if (id === null) { usageLine(io, "recover.needsId"); return 2; }
  if (!ID_RE.test(id)) { usageLine(io, "recover.badId", { id: shownText(id, 60) }); return 2; }
  const yes = flags.has("--yes");
  const dryRun = flags.has("--dry-run");
  if (yes && dryRun) { usageLine(io, "common.eitherDryRunOrYes"); return 2; }
  if (!yes && !dryRun && !io.isTTY) { usageLine(io, "common.needsYesT3"); return 2; }

  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const dir = stateDir(io.env, home);
  const ui = cliUi(io, { now });
  const allowUntested = flags.has("--allow-untested");
  const connect = deps.connect ?? connectT3;
  const onNotice = (l: string): void => io.stderr(`${l}\n`);
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");
  const want = id.toLowerCase();
  // The planner treats every session whose id starts with `id` as named; pickRecover refuses when that is not one.
  const recover = { has: (nativeId: string): boolean => nativeId.toLowerCase().startsWith(want) };
  const planOpts = { home, env: io.env, now, adapters: deps.adapters, existsDir: deps.existsDir, lang: ui.lang, missingConfig: "memory" as const, recover };

  if (dryRun) {
    const api = await connect(home, { allowUntested, manageProviders: false, onNotice });
    try {
      const fp = await freshPlan(api, { ...planOpts, readOnly: true });
      const p = pickRecover(fp.plan, id);
      if (!p.ok) return refuse(io, ui, p);
      say([...willLines(ui, p, home, platform), "", ...noteLines(ui.s, "info", ui.t("recover.dryDone", { id: shownText(p.item.session.nativeId, 40) }), Math.max(1, ui.width))]);
      return 0;
    } finally {
      await api.close();
    }
  }

  const config = await loadConfig(dir, home);
  let api: T3Api | null = null;
  let picked: Extract<RecoverPick, { ok: true }> | null = null;
  let full: PlanItem[] = [];
  // Under the lock, after the recovery (applyPlan's loader): read-only against T3, its connection lent to applyPlan.
  const build = async (): Promise<Plan> => {
    api = await connect(home, { allowUntested, manageProviders: false, onNotice });
    const fp = await freshPlan(api, planOpts);
    const p = pickRecover(fp.plan, id);
    if (!p.ok) throw new RecoverRefused(p);
    picked = p;
    full = fp.plan.items;
    return recoverPlan(fp.plan, p.item, platform);
  };
  const bar = importProgress(io, ui, now, { silent: false, verbose: false });
  let r: ApplyResult;
  try {
    r = await applyPlan(build, {
      stateDir: dir, home, now, platform, signals: deps.signals, allowUntested, batch: config?.batch,
      connect: async () => new Proxy(api!, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k)) }),
      // The journal names the whole id the plan found (read when the run starts, after the loader).
      get command() { return `recover ${picked?.item.session.nativeId ?? id}`; },
      pinDefaultInstance: false,
      exposure: () => full, // every discovered session is still on disk and visible to T3 Code's importer
      rehomeFolders: { env: deps.folderEnv ?? defaultFolderEnv(home, io.env, platform) },
      accountHomes: () => Object.fromEntries((config?.accounts ?? []).map((a) => [a.id, expandHome(a.home, home)])),
      rediscover: async () => (await discoverAll((deps.adapters ?? allAdapters()).filter((a) => a.id !== "claude"), makeEnv(io, home, config ?? defaultConfig([]), now))).sessions,
      failureTitles: FAILURES_SHOWN,
      onImportStart: (n) => bar.onImportStart(n), onWave: (p) => bar.onWave(p), onProgress: (l) => bar.onProgress(l),
      onNotice: (l) => { if (!bar.note(l)) onNotice(l); }, lang: ui.lang,
      confirm: async () => {
        say(willLines(ui, picked!, home, platform));
        if (yes) return true;
        io.stdout("\n");
        return confirm(io, ui.t("recover.confirm"));
      },
    });
    bar.end();
  } catch (e) {
    if (e instanceof RecoverRefused) return refuse(io, ui, e.pick);
    throw e;
  } finally {
    bar.dispose();
    await (api as T3Api | null)?.close();
  }
  if (r.status === "locked") { reportLockBusy(io); return 0; }
  if (r.status === "declined") { io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
  const rec = r.recovered;
  if (rec && rec.restored.length > 0) io.stderr(`${ui.t("apply.recovered", { n: rec.restored.length })}\n`);
  if (rec && rec.failed.length > 0) io.stderr(`${ui.t("apply.recoverFailed", { n: rec.failed.length })}\n`);
  if (r.status === "aborted" && r.runId === null) { io.stderr(`${ui.t("apply.interruptedBefore")}\n`); return 130; }
  say(renderApplyResult(ui, r));
  const done = picked as Extract<RecoverPick, { ok: true }> | null;
  if (r.imported > 0 && done !== null && r.runId !== null) {
    say(["", ...noteLines(ui.s, "ok", ui.t("recover.done", { name: done.name, runId: shownText(r.runId, 40) }), Math.max(1, ui.width))]);
  }
  if (r.status === "aborted") { io.stderr(`${ui.t("apply.interrupted")}\n`); return 130; }
  return r.failed > 0 || r.unverified > 0 || r.restoreErrors.length > 0 ? 5 : 0;
}
