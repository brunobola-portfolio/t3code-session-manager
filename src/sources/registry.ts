import type { DiscoveredSession, HarnessId } from "../core/types.ts";
import { uuidV5 } from "../core/uuid.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { opencodeAdapter } from "./opencode.ts";
import { piAdapter } from "./pi.ts";
import type { SourceAdapter } from "./types.ts";

/** Every source adapter, in report order: the native ones, then the converted ones. */
export function allAdapters(): SourceAdapter[] {
  return [claudeAdapter, codexAdapter, piAdapter, opencodeAdapter];
}

/**
 * The harness's sessions are converted into Claude transcripts by t3sm (its adapter's `mode` is "convert"); T3 Code
 * never reads them itself. The single source of truth for planner and apply.
 */
export function isConvertHarness(id: HarnessId): boolean {
  return allAdapters().some((a) => a.id === id && a.mode === "convert");
}

/**
 * Whether this session goes through conversion: its own `mode` when it carries one (Codex compressed rollouts are
 * converted while plain ones are native), else its adapter's. Planner, apply and the importer decide per session.
 */
export function isConvertSession(s: Pick<DiscoveredSession, "harness" | "mode">, isConvert: (h: HarnessId) => boolean = isConvertHarness): boolean {
  return s.mode !== undefined ? s.mode === "convert" : isConvert(s.harness);
}

/**
 * Every id one session of `harness` can have in T3 Code: its native id (T3 imports the file itself, or the session was
 * started inside T3) and/or the uuid of its converted Claude transcript (`uuidV5("<harness>:<nativeId>")`). A
 * convert-mode harness has only the uuid; a native one without a reader only the native id; a native harness that also
 * converts some sessions (Codex: compressed rollouts) has both, and they are ONE session: a thread under either form
 * means it is already in T3. Order: native id first.
 */
export function sessionForms(harness: HarnessId, nativeId: string): string[] {
  const a = allAdapters().find((x) => x.id === harness);
  const converted = uuidV5(`${harness}:${nativeId}`);
  if (!a) return [nativeId];
  if (a.mode === "convert") return [converted];
  return typeof a.read === "function" ? [nativeId, converted] : [nativeId];
}

/** The session ids T3 holds a thread for, under any instance: `import:<instance>:<id>` thread ids and native refs. */
export function sessionIdsInT3(threads: { id: string; nativeSessionId?: string | null }[]): Set<string> {
  const out = new Set<string>();
  for (const t of threads) {
    const m = /^import:[^:]+:(.+)$/.exec(t.id);
    if (m) out.add(m[1]!);
    if (t.nativeSessionId) out.add(t.nativeSessionId);
  }
  return out;
}

/** The forms of `s` other than the one this item imports (`own`): a thread under one of them means it is in T3. */
export function otherForms(s: Pick<DiscoveredSession, "harness" | "nativeId">, own: string): string[] {
  return sessionForms(s.harness, s.nativeId).filter((f) => f !== own);
}

/**
 * The harness has sessions t3sm converts (its adapter can `read` them): OpenCode, and Codex for compressed rollouts.
 * Provenance checks use this: a converted transcript or journaled conversion of such a harness is t3sm's own.
 */
export function hasConverter(id: HarnessId): boolean {
  return allAdapters().some((a) => a.id === id && typeof a.read === "function");
}
