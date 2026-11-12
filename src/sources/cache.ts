import { readFile } from "node:fs/promises";
import { atomicWrite } from "../core/fsutil.ts";

interface Entry<T> { size: number; mtimeMs: number; result: T }

export interface DiscoveryCache<T> {
  /** Read the file; a missing, corrupt or version-mismatched cache loads as empty. Invalid entries are dropped. */
  load(): Promise<void>;
  /** The cached result when the file's size and mtime are unchanged. */
  get(path: string, size: number, mtimeMs: number): T | undefined;
  /** Record a result for the next `save`; only entries set during this pass are written (deleted files are pruned). */
  set(path: string, size: number, mtimeMs: number, result: T): void;
  /** Atomically write the entries set since `load`. Callers invoke it only after a full pass. */
  save(): Promise<void>;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The file times a discovery cache recorded (any cache version: the times do not depend on the result format).
 * A missing or corrupt cache reads as empty. Never writes.
 */
export async function readCachedMtimes(file: string): Promise<{ path: string; mtimeMs: number }[]> {
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as { entries?: unknown };
    if (j.entries === null || typeof j.entries !== "object") return [];
    const out: { path: string; mtimeMs: number }[] = [];
    for (const [path, v] of Object.entries(j.entries as Record<string, unknown>)) {
      const m = v !== null && typeof v === "object" ? (v as { mtimeMs?: unknown }).mtimeMs : undefined;
      if (isNum(m)) out.push({ path, mtimeMs: m });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Per-harness discovery cache keyed by transcript path. `validate` must check every field of the
 * result; an entry that fails it is rescanned rather than partially trusted.
 */
export function createDiscoveryCache<T>(
  file: string,
  version: number,
  validate: (v: unknown) => v is T,
): DiscoveryCache<T> {
  let old: Record<string, Entry<T>> = {};
  let fresh: Record<string, Entry<T>> = {};
  /** The file was read, valid, and every entry in it was kept (so an unchanged pass may skip the write). */
  let loaded = false;
  return {
    async load(): Promise<void> {
      old = {};
      fresh = {};
      loaded = false;
      try {
        const j = JSON.parse(await readFile(file, "utf8")) as { version?: number; entries?: unknown };
        if (j.version !== version || j.entries === null || typeof j.entries !== "object") return;
        loaded = true;
        for (const [k, v] of Object.entries(j.entries as Record<string, unknown>)) {
          if (v === null || typeof v !== "object") { loaded = false; continue; }
          const e = v as Record<string, unknown>;
          if (isNum(e.size) && isNum(e.mtimeMs) && validate(e.result)) {
            old[k] = { size: e.size, mtimeMs: e.mtimeMs, result: e.result };
          } else loaded = false; // dropped: the file must be rewritten without it
        }
      } catch {
        old = {};
        loaded = false;
      }
    },
    get(path, size, mtimeMs) {
      const hit = old[path];
      return hit && hit.size === size && hit.mtimeMs === mtimeMs ? hit.result : undefined;
    },
    set(path, size, mtimeMs, result) {
      fresh[path] = { size, mtimeMs, result };
    },
    async save(): Promise<void> {
      // Nothing scanned, nothing pruned: the file on disk already says the same (idle sync cycles write nothing).
      const oldKeys = Object.keys(old);
      const freshKeys = Object.keys(fresh);
      const same = loaded && oldKeys.length === freshKeys.length
        && freshKeys.every((k) => old[k] !== undefined && old[k]!.size === fresh[k]!.size && old[k]!.mtimeMs === fresh[k]!.mtimeMs && old[k]!.result === fresh[k]!.result);
      if (same) return;
      await atomicWrite(file, JSON.stringify({ version, entries: fresh }));
    },
  };
}
