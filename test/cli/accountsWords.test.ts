// Why `t3sm accounts --apply` leaves an account out, in the user's language (planInstances' reasons are English).
import { test } from "node:test";
import assert from "node:assert/strict";
import { skipWhy } from "../../src/cli/commands/accounts.ts";
import { makeCliUi } from "../../src/cli/ui.ts";

const ui = (lang: "en" | "pt") => makeCliUi({ color: 0, unicode: true, isTTY: false, columns: 120 }, lang);

test("skipWhy words planInstances' reasons; the home shown with ~; an unknown reason as it is", () => {
  assert.equal(skipWhy(ui("pt"), "instance id already used with another home (C:/Users/demo/.claude-x)", "C:/Users/demo"),
    "o T3 Code já tem uma instância com este id para outra pasta (~/.claude-x)");
  assert.equal(skipWhy(ui("pt"), "home already served by instance claude-work", "C:/Users/demo"), "a sua pasta já é usada pela instância claude-work do T3 Code");
  assert.match(skipWhy(ui("en"), "home already served by instance claude-work", "C:/Users/demo"), /already used by the T3 Code instance claude-work/);
  assert.equal(skipWhy(ui("pt"), "something new", "C:/Users/demo"), "something new");
});

test("skipWhy: an unknown reason shows the home folder as ~", () => {
  assert.equal(skipWhy(ui("en"), "odd: C:/Users/demo/.claude-x", "C:/Users/demo"), "odd: ~/.claude-x");
});

test("accounts: an email-shaped display name is masked like the emails, and shown whole with --show-emails", async () => {
  const { renderAccounts } = await import("../../src/cli/commands/accounts.ts");
  const { defaultConfig } = await import("../../src/core/config.ts");
  const cfg = defaultConfig([{ id: "claudeAgent", home: "~/.claude", displayName: "demouser@example.com", accentColor: null }]);
  const inst = { instanceId: "claudeAgent", driver: "claudeAgent", homePath: "C:/Users/demo/.claude", displayName: "demouser@example.com", accentColor: null, email: "demouser@example.com", authStatus: "authenticated", enabled: true, availability: "available" } as never;
  const masked = renderAccounts(ui("en"), [inst], cfg, "C:/Users/demo", []).join("\n");
  assert.doesNotMatch(masked, /demouser/);
  const shown = renderAccounts(ui("en"), [inst], cfg, "C:/Users/demo", [], true).join("\n");
  assert.match(shown, /claudeAgent +demouser@example\.com/, "the display name column, whole");
});
