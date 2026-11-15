// Snapshot harness: `assertSnapshot(name, text)` compares `text` exactly with test/__snapshots__/<name>.txt (line
// endings normalised to \n, one trailing newline). A missing file, or UPDATE_SNAPSHOTS=1, writes it and logs "written";
// in CI (env CI set) a missing snapshot fails instead of being written. Snapshots are rendered with colour off: colour-on
// cases assert structure (stripAnsi(colour) === colour-off output) instead of storing ANSI.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "__snapshots__");

export interface SnapshotOptions { dir?: string; env?: NodeJS.ProcessEnv; log?: (s: string) => void }

/** CI counts only when set and not "false"/"0"/empty. */
const ciOn = (env: NodeJS.ProcessEnv): boolean => Boolean(env["CI"]) && env["CI"] !== "false" && env["CI"] !== "0";
const norm = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");

export function assertSnapshot(name: string, text: string, o: SnapshotOptions = {}): void {
  const env = o.env ?? process.env;
  const file = join(o.dir ?? SNAPSHOT_DIR, `${name}.txt`);
  const actual = norm(text);
  const update = env["UPDATE_SNAPSHOTS"] === "1";
  if (update || !existsSync(file)) {
    if (!update && ciOn(env)) assert.fail(`snapshot ${name} is missing (CI never writes snapshots): run the tests locally and commit ${file}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual, "utf8");
    (o.log ?? ((s: string) => console.log(s)))(`snapshot written: ${name}`);
    return;
  }
  assert.equal(actual, norm(readFileSync(file, "utf8")), `snapshot ${name} differs (UPDATE_SNAPSHOTS=1 rewrites it)`);
}
