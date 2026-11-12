import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, InstanceSpec } from "../../core/types.ts";
import { expandHome, sameCwd, stateDir, tildePath } from "../../core/paths.ts";
import { discoverAccountHomes, formatSources, nodeDiscoveryEnv, resolveAccounts, type DiscoveredHome } from "../../ops/discoverAccounts.ts";
import { ConfigError, defaultConfig, detectAccounts, loadConfig, saveConfig } from "../../core/config.ts";
import { Journal, newRunId, recoverPendingMtimes } from "../../core/journal.ts";
import { acquireLock } from "../../core/lock.ts";
import { connectT3, type ProviderInstanceInfo, type T3Api } from "../../t3/api.ts";
import { appearanceDelta, assertRenameSafe, defaultClaudeHome, ensureInstances, planInstances } from "../../ops/accounts.ts";
import { maskEmail } from "../../ops/doctor.ts";
import { reportLockBusy } from "../locked.ts";
import type { Io } from "../main.ts";

export interface AccountsDeps {
  home?: string;
  now?: () => number;
  connect?: (home: string, opts: { allowUntested: boolean; manageProviders: boolean; onNotice: (l: string) => void }) => Promise<T3Api>;
}

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const KNOWN = new Set(["--init", "--force", "--apply", "--yes", "--rename", "--color", "--allow-untested", "--show-emails"]);

function specsFromConfig(c: Config, home: string): InstanceSpec[] {
  return c.accounts.map((a) => ({ id: a.id, driver: "claudeAgent" as const, displayName: a.displayName, accentColor: a.accentColor, homePath: expandHome(a.home, home), environment: [] }));
}

function table(rows: string[][]): string[] {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd());
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
        io.stderr("--rename needs an instance id and a display name. Run `t3sm accounts --help`.\n");
        return 2;
      }
      rename = { id, name }; i += 2; flags.add(a);
    } else if (a === "--color") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) { io.stderr("--color needs a value like #7C3AED.\n"); return 2; }
      color = v; i += 1; flags.add(a);
    } else if (KNOWN.has(a)) flags.add(a);
    else { io.stderr(`Unknown option: ${a}. Run \`t3sm accounts --help\`.\n`); return 2; }
  }
  const modes = ["--init", "--apply", "--rename"].filter((f) => flags.has(f));
  if (modes.length > 1) { io.stderr(`Use only one of ${modes.join(", ")}.\n`); return 2; }
  if (color !== null && !COLOR_RE.test(color)) { io.stderr(`--color must be #RRGGBB, got ${JSON.stringify(color)}.\n`); return 2; }
  if (color !== null && !rename) { io.stderr("--color only goes with --rename.\n"); return 2; }
  if ((flags.has("--force") && !flags.has("--init")) || (flags.has("--yes") && !flags.has("--apply"))) {
    io.stderr("--force goes with --init and --yes goes with --apply.\n");
    return 2;
  }
  if (flags.has("--show-emails") && modes.length > 0) { io.stderr("--show-emails only goes with the read-only table (no --init, --apply or --rename).\n"); return 2; }

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
    io.stdout(`Wrote ${join(dir, "config.json")} with ${cfg.accounts.length} account(s): ${cfg.accounts.map((a) => a.id).join(", ") || "(none)"}.\n`);
    return 0;
  }

  if (flags.has("--apply") && !flags.has("--yes") && !io.isTTY) {
    io.stderr("Refusing to change T3 Code without confirmation: pass --yes (non-interactive).\n");
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
    io.stdout(renderAccounts(instances, config, home, found, flags.has("--show-emails")));
    return 0;
  } finally {
    await api.close();
  }
}

interface Ctx { io: Io; dir: string; home: string; now: () => number; connect: NonNullable<AccountsDeps["connect"]>; allowUntested: boolean; notice: (l: string) => void }

/** showEmails false (default): emails masked like doctor (b***@domain); shared emails are still compared unmasked. */
function renderAccounts(instances: ProviderInstanceInfo[], config: Config, home: string, found: DiscoveredHome[], showEmails = false): string {
  const shown = (email: string): string => (showEmails ? email : maskEmail(email));
  const used = new Set<string>();
  const rows: string[][] = [["Account", "Instance", "Display name", "Home", "Found via", "Signed in as", "Auth", "Availability"]];
  const warnings: string[] = [];
  const t = (p: string) => tildePath(p, home);
  const via = (p: string | null, fallback: string) => {
    const d = p === null ? undefined : found.find((f) => sameCwd(f.home, p));
    return d ? formatSources(d) : fallback;
  };
  const row = (acct: string, i: ProviderInstanceInfo, fallback: string) => {
    used.add(i.instanceId);
    rows.push([acct, i.instanceId, i.displayName, i.homePath === null ? "?" : t(i.homePath), via(i.homePath, fallback), i.email ? shown(i.email) : "-", i.authStatus ?? "-", i.availability]);
    if (i.authStatus === "unauthenticated") warnings.push(`Instance ${i.instanceId} is signed out. Sign in from T3 Code (or run \`claude\` with CLAUDE_CONFIG_DIR set to its home).`);
  };
  for (const a of config.accounts) {
    const h = expandHome(a.home, home);
    const i = instances.find((x) => x.homePath !== null && sameCwd(x.homePath, h));
    if (i) row(a.id, i, "config");
    else {
      rows.push([a.id, "(none)", a.displayName, t(h), via(h, "config"), "-", "-", "-"]);
      warnings.push(`Account ${a.id} (${t(h)}) has no T3 instance. Run \`t3sm accounts --apply\` to create it.`);
    }
  }
  for (const i of instances) if (!used.has(i.instanceId)) row("(not in config)", i, "t3-instance");
  for (const f of found) {
    if (config.accounts.some((a) => sameCwd(expandHome(a.home, home), f.home))) continue;
    warnings.push(`Found ${t(f.home)} (${formatSources(f)}) but it is not in config.json. Add it to config.json, or rewrite the file with \`t3sm accounts --init --force\`.`);
  }
  const byEmail = new Map<string, string[]>();
  for (const i of instances) if (i.email) byEmail.set(i.email.toLowerCase(), [...(byEmail.get(i.email.toLowerCase()) ?? []), i.instanceId]);
  for (const [email, ids] of byEmail) if (ids.length > 1) warnings.push(`Instances ${ids.join(" and ")} share the same email (${shown(email)}): they are the same subscription.`);
  const lines = table(rows);
  if (warnings.length) lines.push("", ...warnings.map((w) => `Warning: ${w}`));
  return lines.join("\n") + "\n";
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
    try {
      // Throws InstanceHomeDrift before any write; an explicit claudeAgent entry for another home is re-pinned instead.
      const plan = await planInstances(api, specs, defaultClaudeHome(c.home), { repinExplicit: true });
      const items = [...plan.create.map((s) => `create ${s.id} (${s.homePath})`), ...plan.pin.map((s) => `pin ${s.id} to ${s.homePath} if not already pinned`)];
      for (const s of plan.skipped) if (s.reason !== "already present") c.io.stdout(`Skipping ${s.id}: ${s.reason}\n`);
      if (plan.create.length === 0 && plan.pin.length === 0) { c.io.stdout("Nothing to do: every account already has its instance.\n"); return 0; }
      if (!yes) {
        c.io.stdout(`This will change T3 Code settings:\n${items.map((x) => `  - ${x}`).join("\n")}\n`);
        const ans = (await c.io.prompt("Apply? Type yes to continue: ")).trim().toLowerCase();
        if (ans !== "yes" && ans !== "y") { c.io.stdout("Nothing changed.\n"); return 0; }
      }
      const r = await ensureInstances(api, specs, j, newRunId(new Date(c.now())), defaultClaudeHome(c.home), { repinExplicit: true });
      c.io.stdout(`Created: ${r.created.join(", ") || "(none)"}. Pinned: ${r.pinned.join(", ") || "(none)"}.\n`);
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
      c.io.stdout(res.changed ? `Renamed ${r.id} to ${JSON.stringify(appearance.displayName)} in T3 Code and config.json.\n` : `${r.id} already looks like that in T3 Code; config.json updated.\n`);
      return 0;
    } finally {
      await api.close();
    }
  } finally {
    await lock.release();
  }
}
