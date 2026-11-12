// t3sm update: install the newest release over an npm install. A checkout or the npx cache only gets the right
// instructions. Flow: --dry-run, or no --yes off a terminal: print the command and exit 0 / 2. Otherwise:
// confirm -> lock (never swap the code under a running apply or sync) -> npm install -g -> versions -> sync advice.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { stateDir } from "../../core/paths.ts";
import { DEFAULT_SCHEDULE_MINUTES, loadConfig } from "../../core/config.ts";
import { acquireLock } from "../../core/lock.ts";
import { installKind, realNpm, releaseSpec, repoSlug } from "../../ops/update.ts";
import { defaultBinPath, realRunner, scheduleSpec, scheduleStatus } from "../../ops/schedule.ts";
import { pidAlive, readHeartbeat } from "../../ops/watch.ts";
import { reportLockBusy } from "../locked.ts";
import { confirm, parseFlags } from "./quarantine.ts";
import type { Io } from "../main.ts";

export interface UpdateDeps {
  /** Package root: the folder holding bin/ and package.json (default: this install). */
  root?: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** The installed version, read fresh from package.json on each call. */
  readVersion?: () => string;
  /** Runs `npm <args>` attached to the terminal; resolves to its exit code (127: npm not found). */
  runNpm?: (args: string[]) => Promise<number>;
  /** Lines about the background sync after an update (stale scheduler paths, a watcher on the old version). */
  scheduleAdvice?: (io: Io, home: string) => Promise<string[]>;
}

interface PackageJson { version: string; repository?: { url?: string } | string }

function packageJson(root: string): PackageJson {
  return JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as PackageJson;
}

/** This t3sm's own repository URL (src/ and dist/ both sit two folders below the package root). */
function ownRepositoryUrl(): string {
  const r = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as PackageJson).repository;
  return typeof r === "string" ? r : r?.url ?? "";
}

async function defaultScheduleAdvice(io: Io, home: string): Promise<string[]> {
  const lines: string[] = [];
  try {
    const dir = stateDir(io.env, home);
    const every = (await loadConfig(dir, home).catch(() => null))?.schedule.everyMinutes ?? DEFAULT_SCHEDULE_MINUTES;
    const spec = scheduleSpec(process.platform, process.execPath, defaultBinPath(), every, { home, stateDir: dir, systemRoot: io.env["SystemRoot"] ?? io.env["windir"] });
    const s = await scheduleStatus(spec, realRunner);
    if (s.installed && s.missing.length > 0) {
      lines.push(`The background sync still points at ${s.missing.join(" and ")}, which no longer exist${s.missing.length === 1 ? "s" : ""}. Run \`t3sm schedule install\` (with --watch if you use the watcher) to point it at this install.`);
    }
    const hb = await readHeartbeat(dir);
    if (hb && !hb.stoppedAt && pidAlive(hb.pid)) {
      lines.push(`The background watcher (pid ${hb.pid}) keeps running the previous version until you next sign in.`);
    }
  } catch { /* advice only: never fail an update that worked */ }
  return lines;
}

export async function updateCommand(args: string[], io: Io, deps: UpdateDeps = {}): Promise<number> {
  const p = parseFlags(args, io, "update", ["--yes", "--dry-run"]);
  if (!p) return 2;
  const root = deps.root ?? fileURLToPath(new URL("../../..", import.meta.url)).replace(/[\\/]+$/, "");
  const home = deps.home ?? homedir();
  const readVersion = deps.readVersion ?? (() => packageJson(root).version);
  const kind = installKind(root);
  const repoUrl = ownRepositoryUrl();
  const spec = releaseSpec(repoUrl);
  const changelog = `https://github.com/${repoSlug(repoUrl)}/blob/main/CHANGELOG.md`;
  // --install-links: on npm 11 a global install from git otherwise ends as a link to npm's temporary clone, which npm
  // then deletes (the install "succeeds" and t3sm is gone).
  const npmArgs = ["install", "-g", "--install-links", spec];
  const install = `npm ${npmArgs.join(" ")}`;
  const current = readVersion();

  if (kind === "checkout") {
    io.stdout(`t3sm ${current} runs from a git checkout: ${root}\n`
      + `It always runs the sources in that folder, so there is nothing to install. To update it:\n`
      + `  git -C "${root}" pull\n`);
    return 0;
  }
  if (kind === "npx") {
    io.stdout(`t3sm ${current} runs from npx's cache, which can be cleaned at any time. Install the \`t3sm\` command once:\n`
      + `  ${install}\n`
      + `Then \`t3sm update\` keeps it current.\n`);
    return 0;
  }

  io.stdout(`t3sm ${current}, installed with npm at ${root}\n`);
  if (p.flags.has("--dry-run")) {
    io.stdout(`Would run: ${install}\n`);
    return 0;
  }
  if (!p.flags.has("--yes")) {
    if (!io.isTTY) {
      io.stderr("Refusing to update without confirmation: pass --yes (non-interactive), or --dry-run to see the command.\n");
      return 2;
    }
    if (!(await confirm(io, "Install the newest t3sm release with npm?"))) {
      io.stdout("Nothing changed.\n");
      return 0;
    }
  }

  const lock = await acquireLock(stateDir(io.env, home));
  if (!lock) {
    reportLockBusy(io);
    return 0;
  }
  let code: number;
  try {
    code = await (deps.runNpm ?? realNpm(deps.platform ?? process.platform, io.env))(npmArgs);
  } finally {
    await lock.release();
  }
  if (code !== 0) {
    io.stderr(code === 127
      ? `npm was not found on PATH. Install Node.js (it includes npm), then run \`t3sm update\` again. t3sm is still ${current}.\n`
      : `npm exited with code ${code}; t3sm is still ${current}. Its messages above say why (often: no network, or git missing).\n`);
    return 1;
  }
  const after = readVersion();
  io.stdout(after === current
    ? `t3sm is already the newest release (${current}).\n`
    : `Updated t3sm ${current} -> ${after}. What changed: ${changelog}\n`);
  const advice = await (deps.scheduleAdvice ?? defaultScheduleAdvice)(io, home);
  for (const l of advice) io.stdout(`${l}\n`);
  return 0;
}
