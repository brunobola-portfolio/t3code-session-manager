// The operations never reach up into the CLI's screens: the error mapping lives in ops/errorCodes.ts and the
// catalogues in i18n/, so nothing under src/ops imports src/cli/errors.ts or src/cli/ui.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("src/ops imports neither cli/errors.ts nor cli/ui.ts", () => {
  const dir = join(import.meta.dirname, "..", "..", "src", "ops");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(text, /from "\.\.\/cli\/(errors|ui)\.ts"/, f);
  }
});
