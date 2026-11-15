// One Portuguese term per concept (the glossary at the head of src/i18n/messages.pt.ts): the screens, the help topics
// and the Portuguese docs say the same word for the same thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const ptTexts = (): [string, string][] => {
  const files = [
    "src/i18n/messages.pt.ts", "src/assistant/messages.pt.ts", "src/cli/help.pt.ts",
    "README.pt.md", "docs/testing-0.3.pt.md", "docs/switching-from-vscode.pt.md",
    ...readdirSync(join(root, "docs", "help")).filter((f) => f.endsWith(".pt.md")).map((f) => `docs/help/${f}`),
  ];
  return files.map((f) => [f, readFileSync(join(root, f), "utf8")]);
};

test("Portuguese: a copy follows its original with 'seguir', never 'acompanhar'", () => {
  for (const [file, text] of ptTexts()) {
    for (const line of text.split("\n")) {
      // "as pastas que as acompanham" / "a pasta que acompanha a sessão": a folder next to a session, not following.
      if (/acompanh/i.test(line) && !/(pastas? que (as )?acompanha)|acompanha a sessão/.test(line)) {
        assert.fail(`${file}: '${line.trim()}' says 'acompanhar'; the glossary's word for follow is 'seguir'`);
      }
    }
  }
});
