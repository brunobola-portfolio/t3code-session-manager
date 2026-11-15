// Emails are masked wherever t3sm prints them, account names included (people name an account after its email).
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskEmail, maskEmailsIn } from "../../src/core/mask.ts";
import { shownAccountName } from "../../src/plan/names.ts";
import { renderScan } from "../../src/cli/commands/scan.ts";
import { makeCliUi } from "../../src/cli/ui.ts";
import { sess } from "../plan/helpers.ts";

test("maskEmail and maskEmailsIn keep the first character and the domain", () => {
  assert.equal(maskEmail("demo@example.com"), "d***@example.com");
  assert.equal(maskEmailsIn("Work (demo.user+t3@example.com) and a***@corp.example"), "Work (d***@example.com) and a***@corp.example");
  assert.equal(maskEmailsIn("Claude Personal"), "Claude Personal");
});

test("shownAccountName masks an email-shaped display name and stays one safe line", () => {
  assert.equal(shownAccountName("demouser@example.com"), "d***@example.com");
  assert.equal(shownAccountName("Claude · demouser@example.com"), "Claude · d***@example.com");
  assert.equal(shownAccountName("Claude\u001b[31m Work"), "Claude[31m Work");
});

test("scan masks an email-shaped account name", () => {
  const ui = makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 120 }, "en");
  const out = renderScan(ui, { sessions: [sess({ accountId: "work" })], errors: 0, unavailable: [] }, 120, { work: "demouser@example.com" }).join("\n");
  assert.match(out, /d\*\*\*@example\.com/);
  assert.doesNotMatch(out, /demouser/);
});

test("shownAccountName masks what an invisible character, a Unicode local part, an IDN domain or a short form would hide", () => {
  assert.equal(shownAccountName("demo\u200Buser@example.com"), "d***@example.com", "a zero-width space inside the address");
  assert.equal(shownAccountName("josé.ñandú@example.com"), "j***@example.com", "a Unicode local part");
  assert.equal(shownAccountName("demo@exämple.de"), "d***@exämple.de", "an IDN domain");
  assert.equal(shownAccountName("a@b"), "a***@b", "a short token with an @");
  assert.equal(shownAccountName("josé@example.com"), "j***@example.com");
  assert.equal(shownAccountName("user@localhost"), "u***@localhost", "a single-label host");
  assert.equal(shownAccountName("user@[10.0.0.5]"), "u***@[10.0.0.5]", "an IP literal");
  assert.equal(shownAccountName("Work <demouser@example.com>"), "Work <d***@example.com>");
});

test("maskEmailsIn (free text) is Unicode-aware but leaves package specs in commands alone", () => {
  assert.equal(maskEmailsIn("signed in as josé@exämple.de"), "signed in as j***@exämple.de");
  assert.equal(maskEmailsIn("Run claude plugin update t3sm@t3code-session-manager"), "Run claude plugin update t3sm@t3code-session-manager");
  assert.equal(maskEmailsIn("needs node@22"), "needs node@22");
});

test("scan: two accounts with the same display name are told apart by their id", () => {
  const ui = makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 120 }, "en");
  const out = renderScan(ui, { sessions: [sess({ accountId: "a1" }), sess({ accountId: "a2" })], errors: 0, unavailable: [] }, 120, { a1: "Claude", a2: "Claude" }).join("\n");
  assert.match(out, /Claude \(a1\)/);
  assert.match(out, /Claude \(a2\)/);
});
