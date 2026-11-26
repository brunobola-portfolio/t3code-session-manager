// t3sm cloud [--account <id>] [--all] [--json]
// t3sm cloud pull <id...> | --all [--account <id>] [--base <folder>] [--dry-run | --yes] [--allow-untested]
//
// Claude Code sessions that ran in Anthropic's cloud (claude.ai/code, the Claude app), brought to this PC as normal
// local sessions: the code in a local checkout on the session's branch, the conversation resumable with
// `claude --resume` and imported into T3 Code (spec 2026-11-26).
//
// Only the user's own `claude` binary talks to the cloud, one child per account (src/cloud/client.ts); t3sm never sees
// a token and nothing asks the model anything. Listing is read-only. Pulling is a writing command (invariant 12): it
// asks first, needs --yes without a terminal, and --dry-run writes nothing. Its writes happen under the lock after the
// recovery (invariant 3); the import that follows is the same run (one `t3sm rollback --run <id> --archive-threads`
// removes the transcripts and the threads; clones and worktrees are listed, never deleted).

import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, Config, Plan, PlanItem } from "../../core/types.ts";
import { expandHome, normalizeCwd, sameCwd, stateDir, tildePath } from "../../core/paths.ts";
import { defaultConfig, loadConfig, saveConfig } from "../../core/config.ts";
import { Journal, newRunId, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { resolveAccounts } from "../../ops/discoverAccounts.ts";
import { findOnPath } from "../../ops/doctorDeps.ts";
import { defaultRunner } from "../../t3/auth.ts";
import { applyPlan, type ApplyResult, type SignalSource } from "../../apply/apply.ts";
import { connectT3, type T3Api } from "../../t3/api.ts";
import { swapThreads } from "../../ops/revision.ts";
import { IMPORT_THREAD } from "../../ops/merge.ts";
import type { SourceAdapter } from "../../sources/types.ts";
import type { FolderEnv } from "../../plan/folders.ts";
import { shownText } from "../../plan/names.ts";
import { cloudChildEnv, listCloudSessions, openCloud, type CloudConn, type SpawnCloud } from "../../cloud/client.ts";
import { CloudRequestError, CloudSchemaError, CloudUnavailable, isArchived, isCloudOnly, type CloudSession } from "../../cloud/decode.ts";
import { GIT_TIMEOUT_MS, shortCloudId, type Git } from "../../cloud/checkout.ts";
import { cloudWrites, localState, type CloudLocalState } from "../../cloud/state.ts";
import { previewPull, writePulls, type PreviewItem, type PullOutcome, type PullTarget } from "../../cloud/pull.ts";
import { freshPlan } from "./plan.ts";
import { defaultFolderEnv } from "./apply.ts";
import { importProgress, renderApplyResult } from "../applyScreen.ts";
import { FAILURES_SHOWN } from "../failures.ts";
import { reportLockBusy } from "../locked.ts";
import { FLAG_SPECS } from "../flags.ts";
import type { Io } from "../main.ts";
import { cliUi, confirm, unknownOption, usageLine, type CliKey, type CliUi } from "../ui.ts";
import { noteLines, snugWidth, textLines } from "../screen.ts";
import { kv, panel, table } from "../../ui/components.ts";
import { renderError } from "../errors.ts";
import { SKIP_WORDS } from "../../plan/report.ts";
import { helpCommand } from "../helpTopics.ts";
import type { SkipReason } from "../../core/types.ts";

export interface CloudDeps {
  home?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Where `claude` and `git` are (default: PATH). */
  findBin?: (name: string) => string | null;
  spawn?: SpawnCloud;
  git?: Git;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
  adapters?: SourceAdapter[];
  existsDir?: (p: string) => Promise<boolean>;
  signals?: SignalSource;
  folderEnv?: FolderEnv;
}

const LIST_FLAGS = new Set<string>(["--all", "--json"]);
const PULL_FLAGS = new Set<string>(["--all", "--yes", "--dry-run", "--allow-untested"]);
const VALUED = new Set<string>(FLAG_SPECS.cloud.valued);
/** A cloud id, or the start of one as `t3sm cloud` shows it (at least 8 characters). */
const ID_RE = /^(session_)?[0-9A-Za-z]{8,64}$/;

interface Parsed { sub: "list" | "pull"; flags: Set<string>; account: string | null; base: string | null; ids: string[] }

function parse(args: string[], io: Io): Parsed | null {
  const sub = args[0] === "pull" ? "pull" : "list";
  const rest = sub === "pull" ? args.slice(1) : args;
  const allowed = sub === "pull" ? PULL_FLAGS : LIST_FLAGS;
  const p: Parsed = { sub, flags: new Set(), account: null, base: null, ids: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (VALUED.has(a)) {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) { usageLine(io, "cloud.needsValue", { option: a }); return null; }
      if (a === "--base" && sub !== "pull") { unknownOption(io, a, "cloud"); return null; }
      if (a === "--account") p.account = v; else p.base = v;
    } else if (allowed.has(a)) p.flags.add(a);
    else if (a.startsWith("-")) { unknownOption(io, a, "cloud"); return null; }
    else if (sub === "pull") {
      if (!ID_RE.test(a)) { usageLine(io, "cloud.badId", { id: shownText(a, 60) }); return null; }
      p.ids.push(a);
    } else { usageLine(io, "cloud.unknownSub", { sub: shownText(a, 40) }); return null; }
  }
  return p;
}

const STATE_KEY: Record<CloudLocalState, CliKey> = {
  remote: "cloud.state.remote", local: "cloud.state.local", newer: "cloud.state.newer", continued: "cloud.state.continued",
};

interface Ctx {
  io: Io; ui: CliUi; home: string; dir: string; platform: NodeJS.Platform; now: () => number; deps: CloudDeps;
  config: Config; accounts: AccountConfig[];
  /** config.json exists: a base folder is saved into it (none is created just for that). */
  configOnDisk: boolean;
}

/** One `claude` child per account, opened on first use and closed at the end. */
function connPool(c: Ctx, bin: string): { get(a: AccountConfig): Promise<CloudConn>; closeAll(): Promise<void> } {
  const open = new Map<string, Promise<CloudConn>>();
  return {
    get(a) {
      let p = open.get(a.id);
      if (!p) {
        p = openCloud({ bin, env: cloudChildEnv(c.io.env, a.home, c.home, c.platform), ...(c.deps.spawn ? { spawn: c.deps.spawn } : {}) });
        open.set(a.id, p);
      }
      return p;
    },
    async closeAll() {
      for (const p of open.values()) await p.then((x) => x.close(), () => {});
    },
  };
}

const accountName = (a: AccountConfig): string => (a.displayName && a.displayName !== a.id ? `${a.displayName} (${a.id})` : a.id);

/** The cloud error as one line under a title (not logged in, `claude` too old, the service refused). */
function cloudErrorLines(ui: CliUi, a: AccountConfig, e: unknown): string[] {
  const key: CliKey = e instanceof CloudSchemaError ? "cloud.err.schema" : e instanceof CloudUnavailable ? "cloud.err.unavailable" : "cloud.err.refused";
  const detail = e instanceof Error ? shownText(e.message.replace(/\s+/g, " "), 300) : String(e);
  return noteLines(ui.s, "err", ui.t(key, { account: accountName(a), detail }), Math.max(1, ui.width));
}

interface Listed { account: AccountConfig; sessions: CloudSession[] }

/** Every chosen account's cloud sessions (bridge rows dropped; archived ones only with `all`). Errors per account. */
async function listAll(c: Ctx, pool: ReturnType<typeof connPool>, all: boolean): Promise<{ listed: Listed[]; failed: { account: AccountConfig; error: unknown }[] }> {
  const listed: Listed[] = [];
  const failed: { account: AccountConfig; error: unknown }[] = [];
  for (const a of c.accounts) {
    c.io.stderr(`${c.ui.s("muted", c.ui.t("cloud.asking", { account: accountName(a) }))}\n`);
    try {
      const rows = await listCloudSessions(await pool.get(a));
      listed.push({ account: a, sessions: rows.filter((s) => isCloudOnly(s) && (all || !isArchived(s))).sort((x, y) => (y.lastEventAt ?? "").localeCompare(x.lastEventAt ?? "")) });
    } catch (e) {
      if (e instanceof CloudSchemaError) throw e;
      failed.push({ account: a, error: e });
    }
  }
  return { listed, failed };
}

const repoText = (s: CloudSession): string => (s.repo ? `${s.repo.owner}/${s.repo.name}` : "—");

async function listCommand(c: Ctx, p: Parsed, bin: string): Promise<number> {
  const { io, ui } = c;
  const pool = connPool(c, bin);
  let r: Awaited<ReturnType<typeof listAll>>;
  try { r = await listAll(c, pool, p.flags.has("--all")); } finally { await pool.closeAll(); }
  const writes = cloudWrites(await new Journal(join(c.dir, "journal.jsonl")).readAll().catch(() => []));
  const rows: { account: AccountConfig; s: CloudSession; state: CloudLocalState; localId: string | null }[] = [];
  for (const l of r.listed) for (const s of l.sessions) {
    const st = await localState(s, writes.get(s.id));
    rows.push({ account: l.account, s, state: st.state, localId: st.write ? st.write.path.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, "") : null });
  }
  if (p.flags.has("--json")) {
    io.stdout(JSON.stringify({
      sessions: rows.map((x) => ({ account: x.account.id, id: x.s.id, title: x.s.title, status: x.s.status, kind: x.s.kind, repository: x.s.repo, branch: x.s.branch, lastEventAt: x.s.lastEventAt, origin: x.s.origin, state: x.state, localSessionId: x.localId })),
      errors: r.failed.map((f) => ({ account: f.account.id, error: f.error instanceof Error ? f.error.message : String(f.error) })),
    }, null, 2) + "\n");
    return r.failed.length > 0 ? 5 : 0;
  }
  const width = Math.max(1, ui.width);
  const out: string[] = [];
  for (const l of r.listed) {
    const mine = rows.filter((x) => x.account.id === l.account.id);
    const title = ui.t("cloud.list.title", { account: accountName(l.account) });
    if (mine.length === 0) { out.push(...panel(ui.s, { title, body: textLines(ui.s, ui.t("cloud.list.none"), Math.max(1, width - 4)) }, width), ""); continue; }
    const body = table(ui.s, [
      { header: ui.t("cloud.col.id"), get: (x) => shortCloudId((x as typeof rows[number]).s.id), min: 12, priority: 5 },
      { header: ui.t("cloud.col.title"), get: (x) => shownText((x as typeof rows[number]).s.title || ui.t("cloud.untitled"), 120), priority: 4, min: 20 },
      { header: ui.t("cloud.col.repo"), get: (x) => (x as typeof rows[number]).s.repo?.name ?? "—", priority: 3, min: 12 },
      { header: ui.t("cloud.col.branch"), get: (x) => (x as typeof rows[number]).s.branch ?? "—", priority: 1, truncate: "middle", min: 10 },
      { header: ui.t("cloud.col.last"), get: (x) => { const t = (x as typeof rows[number]).s.lastEventAt; return t ? ui.f.ago(t) : "—"; }, priority: 2, min: 10 },
      { header: ui.t("cloud.col.here"), get: (x) => { const y = x as typeof rows[number]; const tone = y.state === "remote" ? "accent" : y.state === "local" ? "ok" : "warn"; return ui.s(tone, ui.t(STATE_KEY[y.state])); }, priority: 6, min: 24 },
    ], mine, Math.max(1, width - 4));
    out.push(...panel(ui.s, { title, body }, width), "");
  }
  for (const f of r.failed) out.push(...cloudErrorLines(ui, f.account, f.error), "");
  const pending = rows.filter((x) => x.state === "remote" || x.state === "newer").length;
  if (rows.length > 0) {
    out.push(...noteLines(ui.s, "info", pending > 0
      ? ui.t("cloud.list.next", { n: rows.length, pending })
      : ui.t("cloud.list.allHere", { n: rows.length }), width));
  }
  io.stdout(out.join("\n") + "\n");
  return r.failed.length > 0 ? 5 : 0;
}

/** The folder most T3 Code projects sit in (their parents' most common one), else ~/code. */
export function suggestBase(roots: readonly string[], home: string, platform: NodeJS.Platform): string {
  const count = new Map<string, { n: number; path: string }>();
  for (const r of roots) {
    const parent = normalizeCwd(r, platform).replace(/[\\/][^\\/]+[\\/]?$/, "");
    if (parent === "" || sameCwd(parent, home, platform)) continue;
    const k = platform === "win32" ? parent.toLowerCase() : parent;
    const cur = count.get(k) ?? { n: 0, path: parent };
    cur.n++;
    count.set(k, cur);
  }
  const best = [...count.values()].sort((a, b) => b.n - a.n)[0];
  const P = platform === "win32" ? "\\" : "/";
  return best ? (platform === "win32" ? best.path.replaceAll("/", "\\") : best.path) : `${home}${P}code`;
}

function previewLines(ui: CliUi, items: PreviewItem[], home: string, platform: NodeJS.Platform): string[] {
  const width = Math.max(1, ui.width);
  const out: string[] = [];
  const path = (p: string): string => ui.s("path", shownText(tildePath(p, home, platform), 200));
  for (const it of items) {
    const s = it.target.session;
    const rows: [string, string][] = [[ui.t("cloud.row.session"), `${shortCloudId(s.id)}  ${ui.s("muted", accountName(it.target.account))}`]];
    rows.push([ui.t("cloud.row.repo"), repoText(s) + (s.branch ? `  ${ui.s("muted", s.branch)}` : "")]);
    if (it.checkout.ok) {
      const cp = it.checkout.plan;
      if (cp.kind === "folder") rows.push([ui.t("cloud.row.folder"), path(cp.cwd)]);
      else {
        rows.push([ui.t("cloud.row.code"), cp.clone ? ui.t("cloud.code.clone", { path: path(cp.main) }) : ui.t("cloud.code.reuse", { path: path(cp.main) })]);
        if (cp.worktree) rows.push([ui.t("cloud.row.worktree"), `${path(cp.worktree)}  ${ui.s("muted", ui.t("cloud.worktree.ifNeeded"))}`]);
      }
    }
    const todoKey: Record<PreviewItem["todo"], CliKey> = {
      pull: "cloud.todo.pull", update: "cloud.todo.update", nothing: "cloud.todo.nothing", conflict: "cloud.todo.conflict", refused: "cloud.todo.refused",
    };
    rows.push([ui.t("cloud.row.todo"), it.todo === "refused" && !it.checkout.ok ? `${ui.t(todoKey.refused)} (${shownText(it.checkout.message, 200)})` : ui.t(todoKey[it.todo])]);
    const title = shownText(s.title || ui.t("cloud.untitled"), 80);
    const body = kv(ui.s, rows, Math.max(1, width - 4));
    out.push(...panel(ui.s, { title, body, tone: it.todo === "conflict" || it.todo === "refused" ? "warn" : "plain" }, snugWidth(title, body, width)), "");
  }
  return out;
}

function pickTargets(listed: Listed[], p: Parsed): { targets: PullTarget[]; missing: string[]; ambiguous: string[] } {
  const all = listed.flatMap((l) => l.sessions.map((session) => ({ account: l.account, session })));
  if (p.flags.has("--all")) return { targets: all, missing: [], ambiguous: [] };
  const targets: PullTarget[] = [], missing: string[] = [], ambiguous: string[] = [];
  for (const raw of p.ids) {
    const want = raw.replace(/^session_/, "").toLowerCase();
    const hit = all.filter((t) => t.session.id.replace(/^session_/, "").toLowerCase().startsWith(want));
    const ids = new Set(hit.map((h) => h.session.id));
    if (ids.size === 0) missing.push(raw);
    else if (ids.size > 1) ambiguous.push(raw);
    else if (!targets.some((t) => t.session.id === hit[0]!.session.id)) targets.push(hit[0]!);
  }
  return { targets, missing, ambiguous };
}

const realGit = (env: NodeJS.ProcessEnv, bin: string): Git => async (args) => {
  // No CLAUDE_CONFIG_DIR (invariant 11), no prompt on the terminal (a credential helper may still show its own window).
  const e: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") e[k] ??= v;
  return defaultRunner(bin, args, { shell: false, timeoutMs: GIT_TIMEOUT_MS, env: e });
};

async function pullCommand(c: Ctx, p: Parsed, bin: string): Promise<number> {
  const { io, ui, home, platform, now, deps } = c;
  const yes = p.flags.has("--yes"), dryRun = p.flags.has("--dry-run");
  if (yes && dryRun) { usageLine(io, "common.eitherDryRunOrYes"); return 2; }
  if (!p.flags.has("--all") && p.ids.length === 0) { usageLine(io, "cloud.needsIds"); return 2; }
  if (!yes && !dryRun && !io.isTTY) { usageLine(io, "common.needsYesT3"); return 2; }
  const allowUntested = p.flags.has("--allow-untested");
  const say = (l: string[]): void => io.stdout(l.join("\n") + "\n");
  const width = Math.max(1, ui.width);
  const gitBin = (deps.findBin ?? ((n: string) => findOnPath(n, platform, io.env.PATH ?? io.env.Path ?? "", io.env.PATHEXT)))("git");
  if (gitBin === null && !deps.git) { say(noteLines(ui.s, "err", ui.t("cloud.err.noGit"), width)); return 3; }
  const git = deps.git ?? realGit(io.env, gitBin!);
  const onNotice = (l: string): void => io.stderr(`${l}\n`);
  const connect = deps.connect ?? connectT3;

  // T3 Code: its project roots (where a repository may already be checked out), and later the import.
  let api: T3Api | null = await connect(home, { allowUntested, manageProviders: false, onNotice });
  const pool = connPool(c, bin);
  try {
    const roots = (await api.listProjects()).map((x) => x.workspaceRoot);
    // The base folder: --base, then config.json, then asked once (a terminal) with a suggestion.
    let base = p.base ?? c.config.cloud?.baseDir ?? null;
    let saveBase = false;
    if (base === null) {
      if (!io.isTTY) { usageLine(io, "cloud.needsBase"); return 2; }
      const suggestion = suggestBase(roots, home, platform);
      say(textLines(ui.s, ui.t("cloud.base.explain"), width));
      const a = (await io.prompt(ui.t("cloud.base.ask", { suggestion: tildePath(suggestion, home, platform) }))).trim();
      base = a === "" ? suggestion : a;
      saveBase = true;
    }
    base = expandHome(base, home);
    if (platform === "win32") base = base.replaceAll("/", "\\");

    const r = await listAll(c, pool, true);
    for (const f of r.failed) say(cloudErrorLines(ui, f.account, f.error));
    const picked = pickTargets(r.listed, p);
    for (const m of picked.missing) say(noteLines(ui.s, "err", ui.t("cloud.notFound", { id: shownText(m, 60) }), width));
    for (const m of picked.ambiguous) say(noteLines(ui.s, "err", ui.t("cloud.ambiguous", { id: shownText(m, 60) }), width));
    if (picked.missing.length > 0 || picked.ambiguous.length > 0) return 2;
    const journal = new Journal(join(c.dir, "journal.jsonl"));
    const writes = cloudWrites(await journal.readAll().catch(() => []));
    let items = await previewPull(picked.targets, { base, roots, writes, platform });
    // --all: only what needs work; named sessions are all shown (so "nothing to do" is said).
    if (p.flags.has("--all")) items = items.filter((i) => i.todo === "pull" || i.todo === "update" || i.todo === "conflict");
    if (items.length === 0) { say(noteLines(ui.s, "ok", ui.t("cloud.nothingToPull"), width)); return 0; }
    say(previewLines(ui, items, home, platform));
    const work = items.filter((i) => i.todo === "pull" || i.todo === "update");
    if (work.length === 0) { say(noteLines(ui.s, "info", ui.t("cloud.nothingToPull"), width)); return items.some((i) => i.todo === "conflict" || i.todo === "refused") ? 5 : 0; }
    say(noteLines(ui.s, "info", ui.t("cloud.costs"), width));
    if (dryRun) { say(["", ...noteLines(ui.s, "info", ui.t("cloud.dryDone", { n: work.length }), width)]); return 0; }
    if (!yes) {
      io.stdout("\n");
      if (!(await confirm(io, ui.t("cloud.confirm", { n: work.length })))) { io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
    }
    // ---------- writes: under the lock, after the recovery ----------
    const lock = await acquireLock(c.dir);
    if (!lock) { reportLockBusy(io); return 0; }
    const runId = newRunId(new Date(now()));
    const command = `cloud pull ${work.map((i) => i.target.session.id).join(" ")}`.slice(0, 500);
    let results: { item: PreviewItem; outcome: PullOutcome }[];
    try {
      const rec = await recoverPendingMtimes(journal);
      if (rec.restored.length > 0) io.stderr(`${ui.t("apply.recovered", { n: rec.restored.length })}\n`);
      // The base folder asked for is saved now, under the lock, into an existing config.json (never one made for it).
      if (saveBase && c.configOnDisk) {
        await saveConfig(c.dir, { ...c.config, cloud: { ...(c.config.cloud ?? {}), baseDir: tildePath(base, home, platform) } }, home, platform).catch(() => {});
      }
      await journal.append({ t: "run-start", runId, at: new Date(now()).toISOString(), command });
      results = await writePulls(work, {
        journal, runId, now, platform, git, conn: (a) => pool.get(a),
        onStep: (it, step) => io.stderr(`${ui.s("muted", ui.t(`cloud.step.${step}` as CliKey, { title: shownText(it.target.session.title || shortCloudId(it.target.session.id), 60) }))}\n`),
      });
    } finally {
      await lock.release();
    }
    await pool.closeAll();
    const written = results.flatMap((x) => (x.outcome.kind === "written" ? [{ item: x.item, w: x.outcome }] : []));

    // ---------- the import: the same run, through the normal pipeline ----------
    let applied: ApplyResult | null = null;
    let importError: unknown = null;
    const left = new Map<string, SkipReason | "missing">();
    if (written.length > 0) {
      const wanted = new Set(written.map((x) => x.w.localId));
      const bar = importProgress(io, ui, now, { silent: false, verbose: false });
      const config = c.config;
      const lent = api;
      try {
        applied = await applyPlan(async () => {
          const fp = await freshPlan(lent, { home, env: io.env, now, adapters: deps.adapters, existsDir: deps.existsDir, lang: ui.lang, missingConfig: "memory" });
          const plan = onlyThese(fp.plan, wanted, platform);
          // A written session the plan leaves out (a question not answered yet, a folder T3 Code refuses): said by name.
          left.clear();
          for (const id of wanted) {
            const it = plan.items.find((i) => i.session.nativeId === id);
            if (!it) left.set(id, "missing");
            else if (it.action.kind === "skip" && it.action.reason !== "already-in-t3") left.set(id, it.action.reason);
          }
          return plan;
        }, {
          stateDir: c.dir, home, now, platform, signals: deps.signals, allowUntested, batch: config.batch, runId, command,
          connect: async () => new Proxy(lent, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k)) }),
          pinDefaultInstance: false,
          rehomeFolders: { env: deps.folderEnv ?? defaultFolderEnv(home, io.env, platform) },
          accountHomes: () => Object.fromEntries(config.accounts.map((a) => [a.id, expandHome(a.home, home)])),
          failureTitles: FAILURES_SHOWN,
          onImportStart: (n) => bar.onImportStart(n), onWave: (x) => bar.onWave(x), onProgress: (l) => bar.onProgress(l),
          onNotice: (l) => { if (!bar.note(l)) onNotice(l); }, lang: ui.lang,
          confirm: async () => true,
          afterApply: async (ctx) => {
            if (ctx.runId === null) return;
            const threads = await ctx.api.listThreads();
            for (const x of written) {
              if (x.w.revisionOf === null) continue;
              // A thread of a session: its import id (import:<instance>:<session>) or the session T3 Code says it holds.
              const of = (t: { id: string; nativeSessionId?: string | null }, id: string): boolean => IMPORT_THREAD.exec(t.id)?.[2] === id || t.nativeSessionId === id;
              const old = threads.find((t) => of(t, x.w.revisionOf!) && !t.archived);
              const fresh = threads.find((t) => of(t, x.w.localId));
              if (old && fresh) await swapThreads({ api: ctx.api, journal: ctx.journal, runId: ctx.runId, oldThreadId: old.id, newThreadId: fresh.id });
            }
          },
        });
        bar.end();
      } catch (e) {
        if (e instanceof CloudSchemaError) throw e;
        importError = e;
      } finally {
        bar.dispose();
      }
      // The import did not finish the run (locked, stopped before its run-start, or an error): close it here, so the
      // journal says the run ended, and rollback still finds the files it wrote.
      if (applied === null || applied.status === "locked" || (applied.status === "aborted" && applied.runId === null)) {
        await journal.append({ t: "run-end", runId, at: new Date(now()).toISOString(), status: "partial" }).catch(() => {});
      }
    } else {
      await journal.append({ t: "run-end", runId, at: new Date(now()).toISOString(), status: results.some((x) => x.outcome.kind === "failed") ? "partial" : "ok" }).catch(() => {});
    }

    // ---------- the result ----------
    if (applied && applied.status === "locked") reportLockBusy(io);
    else if (applied) say(renderApplyResult(ui, applied));
    say(resultLines(ui, results, home, platform));
    const notImported = written.length > 0 && (importError !== null || applied === null || applied.status === "locked" || applied.status === "aborted");
    if (importError !== null) say(renderError(importError, ui, platform));
    if (notImported) say(noteLines(ui.s, "warn", ui.t("cloud.notImported"), width));
    else {
      for (const x of written) {
        const why = left.get(x.w.localId);
        if (why === undefined) continue;
        const title = shownText(x.item.target.session.title || shortCloudId(x.item.target.session.id), 80);
        const next = why === "undecided" ? ui.t("cloud.skipped.decide") : ui.t("cloud.skipped.help", { command: helpCommand(why) });
        say(noteLines(ui.s, "warn", ui.t("cloud.skipped", { title, reason: why === "missing" ? ui.t("cloud.skipped.missing") : ui.t(SKIP_WORDS[why]), next }), width));
      }
    }
    if (written.length > 0) say(noteLines(ui.s, "info", ui.t("cloud.undo", { runId }), width));
    const bad = notImported || left.size > 0 || results.some((x) => x.outcome.kind === "failed") || (applied !== null && (applied.failed > 0 || applied.unverified > 0));
    return bad ? 5 : 0;
  } catch (e) {
    if (e instanceof CloudSchemaError) { say(noteLines(ui.s, "err", ui.t("cloud.err.schemaAny", { detail: shownText(e.message, 300) }), width)); return 4; }
    throw e;
  } finally {
    await pool.closeAll();
    await api?.close();
    api = null;
  }
}

/** The plan reduced to the written sessions, the projects their folders need and the instances they need. */
export function onlyThese(plan: Plan, ids: Set<string>, platform: NodeJS.Platform): Plan {
  const items = plan.items.filter((i) => ids.has(i.session.nativeId) && i.session.harness === "claude");
  const roots = items.flatMap((i: PlanItem) => ("projectRoot" in i.action ? [i.action.projectRoot] : []));
  const need = (r: string): boolean => roots.some((x) => sameCwd(x, r, platform));
  const instances = new Set(items.flatMap((i) => ("instanceId" in i.action ? [i.action.instanceId] : [])));
  const projectsToCreate = plan.projectsToCreate.filter((p) => need(p.root));
  return {
    ...plan, items, mirrorCopies: [], pinDefault: null,
    instancesToCreate: plan.instancesToCreate.filter((x) => instances.has(x.id)),
    projectsToCreate,
    projectDefaults: plan.projectDefaults.filter((d) => need(d.root) && projectsToCreate.some((p) => sameCwd(p.root, d.root, platform))),
  };
}

const FAIL_KEY: Record<Extract<PullOutcome, { kind: "failed" }>["why"], CliKey> = {
  transcript: "cloud.fail.transcript", checkout: "cloud.fail.checkout", "target-exists": "cloud.fail.targetExists", write: "cloud.fail.write", empty: "cloud.fail.empty",
};

function resultLines(ui: CliUi, results: { item: PreviewItem; outcome: PullOutcome }[], home: string, platform: NodeJS.Platform): string[] {
  const width = Math.max(1, ui.width);
  const out: string[] = [""];
  for (const { item, outcome: o } of results) {
    const title = shownText(item.target.session.title || shortCloudId(item.target.session.id), 80);
    if (o.kind === "written") {
      out.push(...noteLines(ui.s, "ok", ui.t(o.revisionOf ? "cloud.done.updated" : "cloud.done.pulled", { title, n: o.messages, path: tildePath(o.cwd, home, platform) }), width));
      out.push(`    ${ui.s.sym.arrow} ${ui.s("key", `cd "${tildePath(o.cwd, home, platform)}" && claude --resume ${o.localId}`)}`);
      if (o.compacted) out.push(...noteLines(ui.s, "info", ui.t("cloud.note.compacted"), width).map((l) => `  ${l}`));
      if (o.branchGone) out.push(...noteLines(ui.s, "warn", ui.t("cloud.note.branchGone"), width).map((l) => `  ${l}`));
    } else if (o.kind === "deferred") out.push(...noteLines(ui.s, "warn", ui.t("cloud.done.active", { title }), width));
    else if (o.kind === "failed") out.push(...noteLines(ui.s, "err", ui.t(FAIL_KEY[o.why], { title, detail: shownText(o.detail, 300) }), width));
  }
  return out;
}

export async function cloudCommand(args: string[], io: Io, deps: CloudDeps = {}): Promise<number> {
  const p = parse(args, io);
  if (p === null) return 2;
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const dir = stateDir(io.env, home);
  const ui = cliUi(io, { now });
  const width = Math.max(1, ui.width);
  const onDisk = await loadConfig(dir, home);
  const config = onDisk ?? defaultConfig(await resolveAccounts(home, [], io.env, platform));
  const accounts = config.accounts.map((a) => ({ ...a, home: expandHome(a.home, home) })).filter((a) => p.account === null || a.id === p.account);
  if (accounts.length === 0) { usageLine(io, p.account === null ? "cloud.noAccounts" : "cloud.noSuchAccount", { account: shownText(p.account ?? "", 40) }); return 2; }
  const bin = (deps.findBin ?? ((n: string) => findOnPath(n, platform, io.env.PATH ?? io.env.Path ?? "", io.env.PATHEXT)))("claude");
  if (bin === null) { io.stdout(noteLines(ui.s, "err", ui.t("cloud.err.noClaude"), width).join("\n") + "\n"); return 3; }
  const c: Ctx = { io, ui, home, dir, platform, now, deps, config, accounts, configOnDisk: onDisk !== null };
  try {
    return p.sub === "pull" ? await pullCommand(c, p, bin) : await listCommand(c, p, bin);
  } catch (e) {
    if (e instanceof CloudSchemaError) { io.stdout(noteLines(ui.s, "err", ui.t("cloud.err.schemaAny", { detail: shownText(e.message, 300) }), width).join("\n") + "\n"); return 4; }
    if (e instanceof CloudRequestError || e instanceof CloudUnavailable) { io.stdout(noteLines(ui.s, "err", ui.t("cloud.err.unavailableAny", { detail: shownText(e.message, 300) }), width).join("\n") + "\n"); return 3; }
    throw e;
  }
}

