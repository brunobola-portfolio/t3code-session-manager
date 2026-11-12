import { test } from "node:test";
import assert from "node:assert/strict";
import { pickWinners, type CopyRelation } from "../../src/plan/dedupe.ts";
import type { DiscoveredSession } from "../../src/core/types.ts";
import { HOME, cfg, sess, uuid } from "./helpers.ts";

const ID = uuid(42);
const P = `${HOME}/.claude/projects/C--work-demo/${ID}.jsonl`;
const O = `${HOME}/.claude-org/projects/C--work-demo/${ID}.jsonl`;

/** compareCopies fake: `rel[a|b]` from a table keyed by "a|b" (symmetric fallback). */
function fakeCompare(table: Record<string, CopyRelation>): (a: string, b: string) => Promise<CopyRelation> {
  return async (a, b) => {
    const direct = table[`${a}|${b}`];
    if (direct) return direct;
    const rev = table[`${b}|${a}`];
    if (!rev) throw new Error(`unexpected compare ${a} vs ${b}`);
    return rev === "a-extends-b" ? "b-extends-a" : rev === "b-extends-a" ? "a-extends-b" : rev;
  };
}
const owner = (accountId: string) => async () => ({ accountId, source: "vscode-pin" as const });
const ids = (xs: DiscoveredSession[]) => xs.map((s) => s.file.path).sort();

test("pickWinners: session only in personal -> personal wins, no losers", async () => {
  const a = sess({ nativeId: ID, path: P });
  const r = await pickWinners([a], cfg(), { compareCopies: fakeCompare({}), projectAccount: owner("claude-org") });
  assert.deepEqual(r.winners, [a]);
  assert.deepEqual(r.losers, []);
  assert.deepEqual(r.forks, []);
});

test("pickWinners: identical in both, project pinned to org -> org wins, personal is identical loser", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const r = await pickWinners([p, o], cfg(), { compareCopies: fakeCompare({ [`${P}|${O}`]: "identical" }), projectAccount: owner("claude-org") });
  assert.deepEqual(r.winners, [o]);
  assert.equal(r.losers.length, 1);
  assert.equal(r.losers[0]!.session, p);
  assert.equal(r.losers[0]!.winner, o);
  assert.equal(r.losers[0]!.relation, "identical");
});

test("pickWinners: identical in both, project account personal -> personal wins", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const r = await pickWinners([o, p], cfg(), { compareCopies: fakeCompare({ [`${P}|${O}`]: "identical" }), projectAccount: owner("claudeAgent") });
  assert.deepEqual(r.winners, [p]);
  assert.equal(r.losers[0]!.session, o);
  assert.equal(r.losers[0]!.relation, "identical");
});

test("pickWinners: org copy longer (personal stale mirror) -> org wins whatever the project account, relation prefix", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent", cwd: "c:\\work\\demo" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org", size: 5000 });
  const r = await pickWinners([p, o], cfg(), { compareCopies: fakeCompare({ [`${O}|${P}`]: "a-extends-b" }), projectAccount: owner("claudeAgent") });
  assert.deepEqual(r.winners, [o]);
  assert.equal(r.losers[0]!.session, p);
  assert.equal(r.losers[0]!.relation, "prefix");
});

test("pickWinners: personal longer -> personal wins, relation prefix", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent", size: 9000 });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const r = await pickWinners([p, o], cfg(), { compareCopies: fakeCompare({ [`${P}|${O}`]: "a-extends-b" }), projectAccount: owner("claude-org") });
  assert.deepEqual(r.winners, [p]);
  assert.equal(r.losers[0]!.session, o);
  assert.equal(r.losers[0]!.relation, "prefix");
});

test("pickWinners: diverged -> both winners, listed in forks", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent" });
  const o = sess({ nativeId: ID, path: O, accountId: "claude-org" });
  const r = await pickWinners([p, o], cfg(), { compareCopies: fakeCompare({ [`${P}|${O}`]: "diverged" }), projectAccount: owner("claude-org") });
  assert.deepEqual(ids(r.winners), [O, P].sort());
  assert.deepEqual(r.losers, []);
  assert.equal(r.forks.length, 1);
  assert.deepEqual(ids(r.forks[0]!), [O, P].sort());
});

test("pickWinners: same id in d--X and D--X of one account -> larger wins (case-variant), no compare", async () => {
  const small = sess({ nativeId: ID, path: `${HOME}/.claude/projects/c--work-demo/${ID}.jsonl`, size: 100 });
  const large = sess({ nativeId: ID, path: `${HOME}/.claude/projects/C--work-demo/${ID}.jsonl`, size: 900 });
  const r = await pickWinners([small, large], cfg(), { compareCopies: fakeCompare({}), projectAccount: owner("claudeAgent") });
  assert.deepEqual(r.winners, [large]);
  assert.equal(r.losers[0]!.session, small);
  assert.equal(r.losers[0]!.relation, "case-variant");
});

test("pickWinners: same size case-variants -> newer mtime wins", async () => {
  const older = sess({ nativeId: ID, path: `${HOME}/.claude/projects/c--work-demo/${ID}.jsonl`, mtimeMs: 1000 });
  const newer = sess({ nativeId: ID, path: `${HOME}/.claude/projects/C--work-demo/${ID}.jsonl`, mtimeMs: 2000 });
  const r = await pickWinners([newer, older], cfg(), { compareCopies: fakeCompare({}), projectAccount: owner("claudeAgent") });
  assert.deepEqual(r.winners, [newer]);
  assert.equal(r.losers[0]!.relation, "case-variant");
});

test("pickWinners: non-backup beats a backup copy (relation backup), even when the backup is larger", async () => {
  const live = sess({ nativeId: ID, path: P, size: 100 });
  const bak = sess({ nativeId: ID, path: `${HOME}/.claude/projects/C--work-demo.bak-20260630-111703/${ID}.jsonl`, size: 9000, flags: ["backup-copy"] });
  const r = await pickWinners([bak, live], cfg(), { compareCopies: fakeCompare({}), projectAccount: owner("claudeAgent") });
  assert.deepEqual(r.winners, [live]);
  assert.equal(r.losers[0]!.session, bak);
  assert.equal(r.losers[0]!.relation, "backup");
  assert.equal(r.losers[0]!.winner, live);
});

test("pickWinners: only backup copies -> one winner among them", async () => {
  const b1 = sess({ nativeId: ID, path: `${HOME}/.claude/projects/X.bak-1/${ID}.jsonl`, flags: ["backup-copy"], size: 10 });
  const b2 = sess({ nativeId: ID, path: `${HOME}/.claude/projects/X.bak-2/${ID}.jsonl`, flags: ["backup-copy"], size: 20 });
  const r = await pickWinners([b1, b2], cfg(), { compareCopies: fakeCompare({}), projectAccount: owner("claudeAgent") });
  assert.deepEqual(r.winners, [b2]);
  assert.equal(r.losers.length, 1);
});

test("pickWinners: harnesses do not collide on the same nativeId", async () => {
  const c = sess({ nativeId: "abc", harness: "codex", accountId: null, path: "/x/a.jsonl" });
  const p = sess({ nativeId: "abc", harness: "pi", accountId: null, path: "/x/b.jsonl" });
  const r = await pickWinners([c, p], cfg(), { compareCopies: fakeCompare({}), projectAccount: owner("claudeAgent") });
  assert.equal(r.winners.length, 2);
});

test("pickWinners: case-variant inside org then cross-account prefix: losers point at the final winner", async () => {
  const p = sess({ nativeId: ID, path: P, accountId: "claudeAgent", size: 9000 });
  const o1 = sess({ nativeId: ID, path: O, accountId: "claude-org", size: 500 });
  const o2 = sess({ nativeId: ID, path: O.replace("C--", "c--"), accountId: "claude-org", size: 400 });
  const r = await pickWinners([o2, o1, p], cfg(), { compareCopies: fakeCompare({ [`${P}|${O}`]: "a-extends-b" }), projectAccount: owner("claude-org") });
  assert.deepEqual(r.winners, [p]);
  const byPath = new Map(r.losers.map((l) => [l.session.file.path, l]));
  assert.equal(byPath.get(O)!.relation, "prefix");
  assert.equal(byPath.get(O.replace("C--", "c--"))!.relation, "case-variant");
  for (const l of r.losers) assert.equal(l.winner, p);
});

// Review M5: on case-sensitive platforms same-account copies are compared by content.
test("pickWinners (linux): same-account identical copies -> bigger/newer wins, relation case-variant", async () => {
  const x = sess({ nativeId: ID, path: "/h/.claude/projects/-w-x/a.jsonl", size: 100, mtimeMs: 1 });
  const y = sess({ nativeId: ID, path: "/h/.claude/projects/-W-x/a.jsonl", size: 100, mtimeMs: 2 });
  const r = await pickWinners([x, y], cfg(), { compareCopies: fakeCompare({ [`${x.file.path}|${y.file.path}`]: "identical" }), projectAccount: owner("claudeAgent"), platform: "linux" });
  assert.deepEqual(r.winners, [y]);
  assert.equal(r.losers[0]!.relation, "case-variant");
});

test("pickWinners (linux): same-account diverged copies -> both winners (fork)", async () => {
  const x = sess({ nativeId: ID, path: "/h/.claude/projects/-w-x/a.jsonl", size: 900 });
  const y = sess({ nativeId: ID, path: "/h/.claude/projects/-W-x/a.jsonl", size: 100 });
  const r = await pickWinners([x, y], cfg(), { compareCopies: fakeCompare({ [`${x.file.path}|${y.file.path}`]: "diverged" }), projectAccount: owner("claudeAgent"), platform: "linux" });
  assert.equal(r.winners.length, 2);
  assert.equal(r.forks.length, 1);
});

test("pickWinners (linux): same-account prefix -> longer wins even if the other is newer", async () => {
  const x = sess({ nativeId: ID, path: "/h/.claude/projects/-w-x/a.jsonl", size: 100, mtimeMs: 9 });
  const y = sess({ nativeId: ID, path: "/h/.claude/projects/-W-x/a.jsonl", size: 900, mtimeMs: 1 });
  const r = await pickWinners([x, y], cfg(), { compareCopies: fakeCompare({ [`${y.file.path}|${x.file.path}`]: "a-extends-b" }), projectAccount: owner("claudeAgent"), platform: "linux" });
  assert.deepEqual(r.winners, [y]);
  assert.equal(r.losers[0]!.relation, "case-variant");
});
