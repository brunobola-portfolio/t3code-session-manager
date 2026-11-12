import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, posix, resolve } from "node:path";

export interface ServerRuntime { origin: string; port: number; serverVersion: string; pid: number }

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * Parse an origin and accept it only if it is a plain local http(s) origin: loopback host, no credentials,
 * and (when `port` is given) the explicit/default port equals it. Anything else could make us send a
 * bearer token to a foreign host.
 */
export function parseLocalOrigin(origin: unknown, port?: number): URL | null {
  if (typeof origin !== "string") return null;
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!LOCAL_HOSTS.has(u.hostname)) return null;
  if (u.username !== "" || u.password !== "") return null;
  if (port !== undefined) {
    const eff = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (eff !== port) return null;
  }
  return u;
}

/**
 * ~/.t3/userdata/server-runtime.json. The file is NOT removed when T3 Code quits (S1 §1),
 * so its presence proves nothing: use probeServer / isT3Running for liveness.
 * Returns null when missing, unparseable, malformed or pointing at a non-local origin.
 */
export async function readServerRuntime(home: string): Promise<ServerRuntime | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(home, ".t3", "userdata", "server-runtime.json"), "utf8"));
  } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.origin !== "string" || typeof o.port !== "number" || typeof o.serverVersion !== "string" || typeof o.pid !== "number") return null;
  const u = parseLocalOrigin(o.origin, o.port);
  if (!u) return null;
  return { origin: u.origin, port: o.port, serverVersion: o.serverVersion, pid: o.pid };
}

/** GET /.well-known/t3/environment (no auth). True only on a 2xx answer within 2 s, from a local origin. */
export async function probeServer(rt: ServerRuntime, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const base = parseLocalOrigin(rt.origin);
  if (!base) return false;
  try {
    const res = await fetchImpl(new URL("/.well-known/t3/environment", base).href, { signal: AbortSignal.timeout(2000), redirect: "error" });
    return res.ok;
  } catch { return false; }
}

export async function isT3Running(home: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const rt = await readServerRuntime(home);
  return rt !== null && (await probeServer(rt, fetchImpl));
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** ~/.t3/bin/t3(.cmd) first, then PATH (PATHEXT on win32). Returns an absolute path or null. */
export function resolveT3Cli(home: string, platform: NodeJS.Platform, pathEnv: string, pathExt: string | undefined = process.env.PATHEXT): string | null {
  const win = platform === "win32";
  const own = join(home, ".t3", "bin", win ? "t3.cmd" : "t3");
  if (isFile(own)) return resolve(own);
  const exts = win ? (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of pathEnv.split(win ? ";" : posix.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      for (const e of new Set([ext.toLowerCase(), ext])) {
        const p = join(dir, `t3${e}`);
        if (isFile(p)) return resolve(p);
      }
    }
  }
  return null;
}
