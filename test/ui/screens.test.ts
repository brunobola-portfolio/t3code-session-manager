// The screen matrix (spec §5.4, Review Focus 5): every registered screen at 40/80/120 columns x colour on/off x
// Unicode on/off x en/pt. See screens.ts for the exact rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Lang } from "../../src/assistant/i18n.ts";
import type { Caps } from "../../src/ui/caps.ts";
import { displayWidth, stripAnsi } from "../../src/ui/text.ts";
import { SCREENS } from "./screens.ts";
import { assertSnapshot } from "./snapshot.ts";

const LANGS: Lang[] = ["en", "pt"];

test("the registry is not empty", () => assert.ok(SCREENS.length > 0));

for (const screen of SCREENS) {
  test(`${screen.name}: every screen renders at 40/80/120 x color on/off x unicode on/off without overflow or ANSI leaks`, async () => {
    for (const lang of LANGS) for (const columns of [40, 80, 120]) for (const unicode of [true, false]) {
      const base: Caps = { color: 0, unicode, isTTY: true, columns };
      const plain = await screen.render(base, lang);
      const colour = await screen.render({ ...base, color: 1 }, lang);
      const where = `${screen.name} ${lang} ${columns} unicode=${unicode}`;
      for (const [label, lines] of [["colour off", plain], ["colour on", colour]] as const) {
        lines.forEach((l, i) => {
          assert.ok(displayWidth(l) <= columns, `${where} ${label} line ${i} is ${displayWidth(l)} wide: ${stripAnsi(l)}`);
          assert.ok(!l.includes("\n"), `${where} line ${i} holds a newline`);
        });
      }
      plain.forEach((l, i) => assert.ok(!l.includes("\x1b"), `${where}: ESC in colour-off line ${i}`));
      assert.deepEqual(colour.map(stripAnsi), plain, `${where}: colour changes more than the colouring`);
      if (!unicode) {
        const allowed = lang === "pt" ? /^[\x20-\x7e\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff]*$/ : /^[\x20-\x7e]*$/;
        plain.forEach((l, i) => assert.ok(allowed.test(l), `${where}: non-ASCII symbol in line ${i}: ${l}`));
      }
      // Both languages are stored: a Portuguese screen is reviewed as closely as an English one.
      assertSnapshot(`screens/${screen.name}-${columns}-${unicode ? "u" : "a"}${lang === "pt" ? "-pt" : ""}`, plain.join("\n"));
    }
  });
}
