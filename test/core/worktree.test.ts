import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkedWorktreesOf, mainCheckoutOf } from "../../src/core/worktree.ts";
import { sameCwd } from "../../src/core/paths.ts";

test("mainCheckoutOf / linkedWorktreesOf: a linked worktree and its main checkout, both ways", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3sm-wt-"));
  const same = (a: string | null | undefined, b: string): boolean => typeof a === "string" && sameCwd(a, b, process.platform);
  try {
    const main = join(dir, "demo"), wt = join(dir, "demo wt"), gitDir = join(main, ".git", "worktrees", "demo-wt");
    await mkdir(gitDir, { recursive: true });
    await mkdir(wt);
    await writeFile(join(wt, ".git"), `gitdir: ${gitDir}\n`);
    await writeFile(join(gitDir, "commondir"), "../..\n");
    await writeFile(join(gitDir, "gitdir"), `${join(wt, ".git")}\n`);
    assert.ok(same(await mainCheckoutOf(wt), main));
    const linked = await linkedWorktreesOf(main);
    assert.equal(linked.length, 1);
    assert.ok(same(linked[0], wt));

    assert.equal(await mainCheckoutOf(main), null, "the main checkout itself");
    assert.equal(await mainCheckoutOf(join(dir, "gone")), null);
    assert.deepEqual(await linkedWorktreesOf(join(dir, "gone")), []);

    // A submodule's .git file points into .git/modules: not a worktree.
    const sub = join(main, "lib");
    await mkdir(sub);
    await writeFile(join(sub, ".git"), "gitdir: ../.git/modules/lib\n");
    assert.equal(await mainCheckoutOf(sub), null);

    // A bare repository has no main checkout.
    const bareGit = join(dir, "bare.git", "worktrees", "x"), bareWt = join(dir, "bare-wt");
    await mkdir(bareGit, { recursive: true });
    await mkdir(bareWt);
    await writeFile(join(bareWt, ".git"), `gitdir: ${bareGit}\n`);
    await writeFile(join(bareGit, "commondir"), "../..\n");
    assert.equal(await mainCheckoutOf(bareWt), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
