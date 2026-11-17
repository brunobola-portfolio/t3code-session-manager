// Putting a provider instance back (`t3sm rollback --instances`): its label, colour or home, from the journaled deltas,
// only while T3 Code still shows what the run set.

import type { JournalEntry } from "../core/types.ts";
import type { Journal } from "../core/journal.ts";
import { sameCwd } from "../core/paths.ts";
import type { T3Api } from "../t3/api.ts";
import type { InstanceChange } from "./rollbackTypes.ts";

const DEFAULT_INSTANCE = "claudeAgent";

export async function restoreInstance(
  api: T3Api,
  e: Extract<JournalEntry, { t: "instance-pinned" | "instance-updated" }>,
  c: InstanceChange,
  x: { dry: boolean; platform: NodeJS.Platform; begin: () => Promise<string>; j: Journal },
): Promise<void> {
  const cur = (await api.providerInstances()).find((i) => i.instanceId === e.instanceId);
  if (!cur) { c.status = "not-restorable"; c.note = "the instance no longer exists"; return; }
  const same = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : sameCwd(a, b, x.platform));

  if (e.t === "instance-pinned") {
    const prev = e.previous.homePath;
    if (e.instanceId === DEFAULT_INSTANCE) { c.status = "not-restorable"; c.note = "claudeAgent stays pinned to ~/.claude"; return; }
    if (prev === null) { c.status = "not-restorable"; c.note = "it had no explicit home before; T3 Code has no way to unpin"; return; }
    if (same(cur.homePath, prev)) { c.status = "already"; return; }
    if (!same(cur.homePath, e.next.homePath)) { c.status = "changed-since"; c.note = `home is now ${cur.homePath ?? "unset"}`; return; }
    if (!x.dry) {
      const id = await x.begin();
      await api.pinInstanceHome(e.instanceId, prev);
      await x.j.append({ t: "instance-pinned", runId: id, instanceId: e.instanceId, previous: { homePath: cur.homePath }, next: { homePath: prev } });
    }
    c.status = "restored";
    return;
  }

  const prev = e.previous, next = e.next;
  // A null previous (no explicit label/colour before) cannot be written back: T3 Code has no "clear" for it.
  const cannotClear = prev.accentColor === null && cur.accentColor !== null;
  const note = cannotClear ? "the accent colour cannot be cleared through T3 Code; change it in T3 Code's settings" : undefined;
  const homeBack = prev.homePath !== null && next.homePath !== null && !same(prev.homePath, next.homePath) && e.instanceId !== DEFAULT_INSTANCE;
  const ap: { displayName?: string; accentColor?: string } = {};
  if (prev.displayName !== null && prev.displayName !== cur.displayName) ap.displayName = prev.displayName;
  if (prev.accentColor !== null && prev.accentColor !== cur.accentColor) ap.accentColor = prev.accentColor;
  const homeNeeded = homeBack && !same(cur.homePath, prev.homePath);
  if (ap.displayName === undefined && ap.accentColor === undefined && !homeNeeded) {
    c.status = cannotClear && cur.accentColor === next.accentColor && cur.displayName === (next.displayName ?? cur.displayName) ? "not-restorable" : "already";
    c.note = note;
    return;
  }
  if ((next.displayName !== null && cur.displayName !== next.displayName) || cur.accentColor !== next.accentColor) {
    c.status = "changed-since";
    c.note = `now ${JSON.stringify(cur.displayName)} ${cur.accentColor ?? "no colour"}`;
    return;
  }
  const notes: string[] = note ? [note] : [];
  if (!x.dry) {
    const id = await x.begin();
    if (ap.displayName !== undefined || ap.accentColor !== undefined) await api.updateInstanceAppearance(e.instanceId, ap);
    if (homeBack) await api.pinInstanceHome(e.instanceId, prev.homePath!);
    await x.j.append({
      t: "instance-updated", runId: id, instanceId: e.instanceId,
      previous: { displayName: cur.displayName, accentColor: cur.accentColor, homePath: cur.homePath },
      next: { displayName: ap.displayName ?? cur.displayName, accentColor: ap.accentColor ?? cur.accentColor, homePath: homeBack ? prev.homePath : cur.homePath },
    });
  }
  c.status = "restored";
  if (notes.length) c.note = notes.join("; ");
}
