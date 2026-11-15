import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, InstanceSpec } from "../../core/types.ts";
import { expandHome, sameCwd, stateDir, tildePath } from "../../core/paths.ts";
import { discoverAccountHomes, nodeDiscoveryEnv, resolveAccounts, type DiscoveredHome } from "../../ops/discoverAccounts.ts";
import { ConfigError, defaultConfig, detectAccounts, loadConfig, saveConfig } from "../../core/config.ts";
import { Journal, newRunId, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { connectT3, type ProviderInstanceInfo, type T3Api } from "../../t3/api.ts";
import { appearanceDelta, assertRenameSafe, defaultClaudeHome, ensureInstances, planInstances } from "../../ops/accounts.ts";
import { maskEmail } from "../../ops/doctor.ts";
import { reportLockBusy } from "../locked.ts";
import type { Io } from "../main.ts";
import { cliUi, confirm, isCliKey, type CliUi, unknownOption, usageLine } from "../ui.ts";
import { FLAG_SPECS } from "../flags.ts";
import { callout } from "../../ui/components.ts";
import { bulletLines, fitLine, homeAsTilde, noteLines, tableOrBlocks, textLines } from "../screen.ts";
import { shownAccountName, shownText } from "../../plan/names.ts";

export interface AccountsDeps {
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
}

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const KNOWN = new Set<string>([...FLAG_SPECS.accounts.bool, ...FLAG_SPECS.accounts.valued]);

function specsFromConfig(c: Config, home: string): InstanceSpec[] {
  return c.accounts.map((a) => ({ id: a.id, driver: "claudeAgent" as const, displayName: a.displayName, accentColor: a.accentColor, homePath: expandHome(a.home, home), environment: [] }));
}

export async function accountsCommand(args: string[], io: Io, deps: AccountsDeps = {}): Promise<number> {
  const flags = new Set<string>();
  let rename: { id: string; name: string } | null = null;
  let color: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--rename") {
      const id = args[i + 1], name = args[i + 2];
      if (id === undefined || name === undefined || id.startsWith("--") || name.startsWith("--")) {
        usageLine(io, "usage.renameArgs");
        return 2;
      }
      rename = { id, name }; i += 2; flags.add(a);
    } else if (a === "--color") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) { usageLine(io, "usage.colorValue"); return 2; }
      color = v; i += 1; flags.add(a);
    } else if (KNOWN.has(a)) flags.add(a);
    else { unknownOption(io, a, "accounts"); return 2; }
  }
  const modes = ["--init", "--apply", "--rename"].filter((f) => flags.has(f));
  if (modes.length > 1) { usageLine(io, "usage.onlyOneOf", { modes: modes.join(", ") }); return 2; }
  if (color !== null && !COLOR_RE.test(color)) { usageLine(io, "usage.colorFormat", { value: JSON.stringify(color) }); return 2; }
  if (color !== null && !rename) { usageLine(io, "usage.colorWithRename"); return 2; }
  if ((flags.has("--force") && !flags.has("--init")) || (flags.has("--yes") && !flags.has("--apply"))) {
    usageLine(io, "usage.forceYes");
    return 2;
  }
  if (flags.has("--show-emails") && modes.length > 0) { usageLine(io, "usage.showEmails"); return 2; }

  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const dir = stateDir(io.env, home);
  const connect = deps.connect ?? connectT3;
  const allowUntested = flags.has("--allow-untested");
  const notice = (l: string) => io.stderr(`${l}\n`);

  if (flags.has("--init")) {
    if ((await loadConfig(dir, home)) !== null && !flags.has("--force")) {
      io.stderr(`${join(dir, "config.json")} already exists. Use --force to overwrite it.\n`);
      return 2;
    }
    // Existing T3 instance ids are kept when T3 Code is running (read-only session); otherwise ids come from discovery.
    let specs: InstanceSpec[] = [];
    try {
      const api = await connect(home, { allowUntested: true, manageProviders: false, onNotice: () => {} });
      try {
        specs = (await api.providerInstances()).filter((i) => i.driver === "claudeAgent" && i.homePath !== null)
          .map((i) => ({ id: i.instanceId, driver: "claudeAgent" as const, displayName: i.displayName, accentColor: i.accentColor, homePath: i.homePath!, environment: [] }));
      } finally { await api.close(); }
    } catch { /* T3 Code not running: ids from discovery */ }
    const cfg = defaultConfig(await resolveAccounts(home, specs, io.env));
    await saveConfig(dir, cfg, home);
    const ui = cliUi(io);
    io.stdout(noteLines(ui.s, "ok", ui.t("accounts.wrote", { path: join(dir, "config.json"), n: cfg.accounts.length, ids: cfg.accounts.map((a) => a.id).join(", ") || ui.t("accounts.noneIds") }), ui.width).join("\n") + "\n");
    return 0;
  }

  if (flags.has("--apply") && !flags.has("--yes") && !io.isTTY) {
    usageLine(io, "common.needsYesT3");
    return 2;
  }

  const needsConfig = flags.has("--apply") || rename !== null;
  const loaded = await loadConfig(dir, home);
  if (needsConfig && loaded === null) throw new ConfigError(`${join(dir, "config.json")} not found. Run \`t3sm accounts --init\` first.`);

  if (rename) return renameInstance(rename, color, loaded!, { io, dir, home, now, connect, allowUntested, notice });
  if (flags.has("--apply")) return applyAccounts(loaded!, flags.has("--yes"), { io, dir, home, now, connect, allowUntested, notice });

  const api = await connect(home, { allowUntested, manageProviders: false, onNotice: notice });
  try {
    const instances = (await api.providerInstances()).filter((i) => i.driver === "claudeAgent");
    const found = await discoverAccountHomes(nodeDiscoveryEnv({ home, env: io.env, instanceHomes: instances.flatMap((i) => (i.homePath === null ? [] : [i.homePath])) }));
    const config = loaded ?? defaultConfig(await detectAccounts(home, [], found.map((f) => ({ home: f.home, alias: f.alias }))));
    io.stdout(renderAccounts(cliUi(io), instances, config, home, found, flags.has("--show-emails")).join("\n") + "\n");
    return 0;
  } finally {
    await api.close();
  }
}

interface Ctx { io: Io; dir: string; home: string; now: () => number; connect: NonNullable<AccountsDeps["connect"]>; allowUntested: boolean; notice: (l: string) => void }

interface AccountRow { account: string; instance: string; name: string; home: string; via: string; email: string; auth: string; availability: string }

/** Why planInstances leaves an account out, in the user's language (its reasons are English); an unknown one as it is. */
export function skipWhy(ui: CliUi, reason: string, home: string): string {
  const used = /^instance id already used with another home \((.*)\)$/.exec(reason);
  if (used) return ui.t("accounts.apply.why.idUsed", { home: shownText(used[1] === "null" ? "?" : tildePath(used[1]!, home), 200) });
  const served = /^home already served by instance (.+)$/.exec(reason);
  if (served) return ui.t("accounts.apply.why.homeServed", { id: shownText(served[1]!, 60) });
  return shownText(homeAsTilde(reason, home), 200);
}

/**
 * The accounts against T3 Code's instances as a table (account, instance, display name, home, where it was found,
 * signed-in email, sign-in, availability), then each problem as a warning with its command. showEmails false
 * (default): emails masked like doctor (b***@domain); shared emails are still compared unmasked.
 */
export function renderAccounts(ui: CliUi, instances: ProviderInstanceInfo[], config: Config, home: string, found: DiscoveredHome[], showEmails = false, width: number = ui.width): string[] {
  const { s, t: tr } = ui;
  const shown = (email: string): string => (showEmails ? email : maskEmail(email));
  // A display name may hold an email: masked like the emails, whole with --show-emails.
  const showName = (name: string): string => (showEmails ? shownText(name, 60) : shownAccountName(name));
  const used = new Set<string>();
  const rows: AccountRow[] = [];
  const warnings: { title: string; body: string; command?: string }[] = [];
  const t = (p: string) => tildePath(p, home);
  // Where a home was found, whether it is signed in and usable: in words (the codes are discovery's and T3 Code's).
  const word = (prefix: string, v: string): string => { const k = `${prefix}${v.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())}`; return isCliKey(k) ? tr(k) : shownText(v, 40); };
  const sources = (d: Pick<DiscoveredHome, "sources" | "alias">): string =>
    d.sources.map((x) => (x === "shell-profile" && d.alias ? tr("accounts.via.shellAlias", { alias: shownText(d.alias, 40) }) : word("accounts.via.", x))).join(", ");
  const via = (p: string | null, fallback: string) => {
    const d = p === null ? undefined : found.find((f) => sameCwd(f.home, p));
    return d ? sources(d) : word("accounts.via.", fallback);
  };
  const row = (acct: string, i: ProviderInstanceInfo, fallback: string) => {
    used.add(i.instanceId);
    rows.push({ account: acct, instance: i.instanceId, name: showName(i.displayName), home: i.homePath === null ? "?" : t(i.homePath), via: via(i.homePath, fallback), email: i.email ? shown(i.email) : "-", auth: i.authStatus === null ? "-" : word("accounts.auth.", i.authStatus), availability: word("accounts.avail.", i.availability) });
    if (i.authStatus === "unauthenticated") warnings.push({ title: tr("accounts.warn.signedOutTitle", { id: i.instanceId }), body: tr("accounts.warn.signedOut") });
  };
  for (const a of config.accounts) {
    const h = expandHome(a.home, home);
    const i = instances.find((x) => x.homePath !== null && sameCwd(x.homePath, h));
    if (i) row(a.id, i, "config");
    else {
      rows.push({ account: a.id, instance: tr("accounts.noInstance"), name: showName(a.displayName), home: t(h), via: via(h, "config"), email: "-", auth: "-", availability: "-" });
      warnings.push({ title: tr("accounts.warn.noInstanceTitle", { id: a.id, home: t(h) }), body: tr("accounts.warn.noInstance"), command: "t3sm accounts --apply" });
    }
  }
  for (const i of instances) if (!used.has(i.instanceId)) row(tr("accounts.notInConfig"), i, "t3-instance");
  for (const f of found) {
    if (config.accounts.some((a) => sameCwd(expandHome(a.home, home), f.home))) continue;
    warnings.push({ title: tr("accounts.warn.foundTitle", { home: t(f.home), via: sources(f) }), body: tr("accounts.warn.found"), command: "t3sm accounts --init --force" });
  }
  const byEmail = new Map<string, string[]>();
  for (const i of instances) if (i.email) byEmail.set(i.email.toLowerCase(), [...(byEmail.get(i.email.toLowerCase()) ?? []), i.instanceId]);
  for (const [email, ids] of byEmail) if (ids.length > 1) warnings.push({ title: tr("accounts.warn.sharedTitle", { ids: ids.join(", "), email: shown(email) }), body: tr("accounts.warn.shared") });
  // Never cut and never a column left out: a table when every cell fits whole, else one block per account.
  const col = (header: string, get: (r: AccountRow) => string) => ({ header, get: (r: unknown) => get(r as AccountRow) });
  // The instance column only when some instance id is not its account's id (it would repeat the first column).
  const sameIds = rows.every((r) => r.instance === r.account);
  const out = tableOrBlocks(s, [
    col(tr("accounts.col.account"), (r) => r.account),
    ...(sameIds ? [] : [col(tr("accounts.col.instance"), (r) => r.instance)]),
    col(tr("accounts.col.name"), (r) => r.name),
    col(tr("accounts.col.home"), (r) => r.home),
    col(tr("accounts.col.via"), (r) => r.via),
    col(tr("accounts.col.email"), (r) => r.email),
    col(tr("accounts.col.auth"), (r) => r.auth),
    col(tr("accounts.col.availability"), (r) => r.availability),
  ], rows, width);
  for (const w of warnings) out.push("", ...callout(s, { kind: "warn", title: w.title, body: textLines(s, w.body, Math.max(1, width - 2)), ...(w.command ? { command: w.command } : {}) }, width));
  return out;
}

// Both writers take the lock and restore pending mtimes BEFORE connecting: a held lock must not create a T3 session.
async function applyAccounts(config: Config, yes: boolean, c: Ctx): Promise<number> {
  const specs = specsFromConfig(config, c.home);
  const lock = await acquireLock(c.dir);
  if (!lock) { reportLockBusy(c.io); return 0; }
  try {
    const j = new Journal(join(c.dir, "journal.jsonl"));
    await recoverPendingMtimes(j);
    const api = await c.connect(c.home, { allowUntested: c.allowUntested, manageProviders: true, onNotice: c.notice });
    const ui = cliUi(c.io);
    const say = (l: string[]): void => c.io.stdout(l.join("\n") + "\n");
    try {
      // Throws InstanceHomeDrift before any write; an explicit claudeAgent entry for another home is re-pinned instead.
      const plan = await planInstances(api, specs, defaultClaudeHome(c.home), { repinExplicit: true });
      const items = [...plan.create.map((x) => ui.t("accounts.apply.create", { id: x.id, home: tildePath(x.homePath, c.home) })), ...plan.pin.map((x) => ui.t("accounts.apply.pin", { id: x.id, home: tildePath(x.homePath, c.home) }))];
      for (const x of plan.skipped) if (x.reason !== "already present") say(noteLines(ui.s, "warn", ui.t("accounts.apply.skip", { id: x.id, reason: skipWhy(ui, x.reason, c.home) }), ui.width));
      if (plan.create.length === 0 && plan.pin.length === 0) { say(noteLines(ui.s, "ok", ui.t("accounts.apply.nothing"), ui.width)); return 0; }
      if (!yes) {
        say([...fitLine(ui.s("title", ui.t("accounts.apply.willDo")), ui.width), ...items.flatMap((x) => bulletLines(ui.s, x, ui.width)), ""]);
        if (!(await confirm(c.io, ui.t("accounts.confirm")))) { c.io.stdout(`${ui.t("common.nothingChanged")}\n`); return 0; }
      }
      const r = await ensureInstances(api, specs, j, newRunId(new Date(c.now())), defaultClaudeHome(c.home), { repinExplicit: true });
      const none = ui.t("accounts.noneIds");
      say(noteLines(ui.s, "ok", ui.t("accounts.apply.done", { created: r.created.join(", ") || none, pinned: r.pinned.join(", ") || none }), ui.width));
      return 0;
    } finally {
      await api.close();
    }
  } finally {
    await lock.release();
  }
}

async function renameInstance(r: { id: string; name: string }, color: string | null, config: Config, c: Ctx): Promise<number> {
  const acct = config.accounts.find((a) => a.id === r.id);
  if (!acct) throw new ConfigError(`No account ${JSON.stringify(r.id)} in config.json (known: ${config.accounts.map((a) => a.id).join(", ") || "none"}).`);
  if (r.name.trim() === "") throw new ConfigError("The display name must not be empty.");
  const lock = await acquireLock(c.dir);
  if (!lock) { reportLockBusy(c.io); return 0; }
  try {
    const j = new Journal(join(c.dir, "journal.jsonl"));
    await recoverPendingMtimes(j);
    const api = await c.connect(c.home, { allowUntested: c.allowUntested, manageProviders: true, onNotice: c.notice });
    try {
      if (!(await api.providerInstances()).some((i) => i.instanceId === r.id)) {
        throw new ConfigError(`No T3 Code instance named ${r.id}. Run \`t3sm accounts\` to list them.`);
      }
      const pinnedHome = await assertRenameSafe(api, r.id, expandHome(acct.home, c.home));
      const appearance: { displayName: string; accentColor?: string } = { displayName: r.name.trim() };
      if (color !== null) appearance.accentColor = color.toUpperCase();
      const res = await api.updateInstanceAppearance(r.id, appearance);
      if (res.changed) await j.append({ t: "instance-updated", runId: newRunId(new Date(c.now())), instanceId: r.id, previous: appearanceDelta(res.previous), next: { ...appearanceDelta(res.previous), ...appearance, homePath: appearanceDelta(res.previous).homePath ?? pinnedHome } });
      acct.displayName = appearance.displayName;
      if (appearance.accentColor !== undefined) acct.accentColor = appearance.accentColor;
      await saveConfig(c.dir, config, c.home);
      const ui = cliUi(c.io);
      c.io.stdout(noteLines(ui.s, "ok", res.changed ? ui.t("accounts.renamed", { id: r.id, name: JSON.stringify(shownAccountName(appearance.displayName, 200)) }) : ui.t("accounts.renamedSame", { id: r.id }), ui.width).join("\n") + "\n");
      return 0;
    } finally {
      await api.close();
    }
  } finally {
    await lock.release();
  }
}
