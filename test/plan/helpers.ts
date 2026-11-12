// Synthetic builders shared by the plan tests. No personal data: paths are `C:/work/demo` style.
import { defaultConfig } from "../../src/core/config.ts";
import type { AccountConfig, Config, DiscoveredSession, HarnessId, SessionFlag } from "../../src/core/types.ts";

export const HOME = "C:/Users/demo";
export const accounts: AccountConfig[] = [
  { id: "claudeAgent", home: "~/.claude", displayName: "Claude · Personal", accentColor: null },
  { id: "claude-org", home: "~/.claude-org", displayName: "Claude · Org", accentColor: "#00AAFF" },
];

export function cfg(over: Partial<Config> = {}): Config {
  return { ...defaultConfig(accounts), ...over };
}

export const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

let seq = 0;
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export interface SessOpts {
  harness?: HarnessId; accountId?: string | null; nativeId?: string; cwd?: string | null; updatedAt?: string;
  path?: string; size?: number; mtimeMs?: number; flags?: SessionFlag[];
}

export function sess(o: SessOpts = {}): DiscoveredSession {
  seq++;
  const harness = o.harness ?? "claude";
  const accountId = o.accountId === undefined ? (harness === "claude" ? "claudeAgent" : null) : o.accountId;
  const nativeId = o.nativeId ?? uuid(1_000_000 + seq);
  const mtimeMs = o.mtimeMs ?? NOW - 60 * DAY;
  const home = accountId === "claude-org" ? `${HOME}/.claude-org` : `${HOME}/.claude`;
  return {
    harness, accountId, nativeId,
    cwd: o.cwd === undefined ? "C:/work/demo" : o.cwd,
    startedAt: new Date(mtimeMs - 3_600_000).toISOString(),
    updatedAt: o.updatedAt ?? new Date(mtimeMs).toISOString(),
    messageCount: 4, corruptLines: 0,
    file: { path: o.path ?? `${home}/projects/C--work-demo/${nativeId}.jsonl`, size: o.size ?? 1000, mtimeMs, atimeMs: mtimeMs },
    flags: o.flags ?? [],
    cwdOffsetBytes: 100,
  };
}
