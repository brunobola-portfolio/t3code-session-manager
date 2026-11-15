// The CLI catalogues (every command's human text): the same keys and placeholders in English and Portuguese, the
// per-command UI context, the global --lang / --no-color, and the shared localized confirmation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmt } from "../../src/assistant/i18n.ts";
import { CLI_CATALOGUES } from "../../src/cli/ui.ts";
import { en } from "../../src/i18n/messages.en.ts";
import { pt } from "../../src/i18n/messages.pt.ts";
import { cliUi, confirm, confirmOrDetails, parseGlobalFlags } from "../../src/cli/ui.ts";
import type { Io } from "../../src/cli/main.ts";

test("CLI catalogues have identical keys and placeholders", () => {
  assert.deepEqual(Object.keys(pt).sort(), Object.keys(en).sort());
  const plain = (s: string): string[] => [...s.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)].map((m) => m[1]!).sort();
  const plural = (s: string): string[] => [...s.matchAll(/\{([a-zA-Z0-9_-]+)\|[^|}]*\|[^}]*\}/g)].map((m) => m[1]!);
  const vars = (s: string): string[] => [...new Set([...plain(s), ...plural(s)])].sort();
  for (const k of Object.keys(en) as (keyof typeof en)[]) {
    assert.deepEqual(plain(pt[k]), plain(en[k]), `placeholders of ${k}`);
    assert.deepEqual(vars(pt[k]), vars(en[k]), `variables (plural switches included) of ${k}`);
    assert.doesNotMatch(en[k], /\{[a-zA-Z0-9_-]+\|[^}]*$/m, `en.${k}: an unclosed plural switch`);
    assert.doesNotMatch(pt[k], /\{[a-zA-Z0-9_-]+\|[^}]*$/m, `pt.${k}: an unclosed plural switch`);
    assert.match(k, /^[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+$/, `${k}: namespaced per command (command.name)`);
  }
  for (const [lang, cat] of Object.entries(CLI_CATALOGUES)) {
    for (const [k, v] of Object.entries(cat)) {
      for (const n of [1, 2]) {
        const names = [...v.matchAll(/\{([a-zA-Z0-9_-]+)[|}]/g)].map((m) => m[1]!);
        const out = fmt(v, Object.fromEntries(names.map((name) => [name, n])));
        assert.doesNotMatch(out, /\{[^}]*\}/, `${lang}.${k} (${n}): ${out}`);
      }
    }
  }
});

function fakeIo(o: Partial<Io> = {}, answers: string[] = []): { io: Io; asked: string[] } {
  const asked: string[] = [];
  const io: Io = {
    stdout: () => undefined, stderr: () => undefined, isTTY: false, env: {},
    prompt: async (q) => { asked.push(q); return answers.shift() ?? ""; },
    ...o,
  };
  return { io, asked };
}

test("cliUi: the language, catalogue, style and width come from the Io (English, no colour, 80 columns without one)", () => {
  const plain = cliUi(fakeIo().io);
  assert.equal(plain.lang, "en");
  assert.equal(plain.t("status.allGood"), en["status.allGood"]);
  assert.equal(plain.width, 80);
  assert.equal(plain.s("warn", "x"), "x", "no TTY: no colour");
  const p = cliUi(fakeIo({ lang: "pt", caps: { color: 1, unicode: true, isTTY: true, columns: 120 } }).io);
  assert.equal(p.lang, "pt");
  assert.equal(p.m, CLI_CATALOGUES.pt);
  assert.equal(p.t("status.needsYou", { n: 2 }), "Precisa de ti (2)");
  assert.equal(p.width, 120);
  assert.match(p.s("warn", "x"), /\u001b\[/);
  assert.equal(p.f.n(4007), "4 007");
});

test("parseGlobalFlags: --lang and --no-color anywhere, removed from argv; an invalid --lang is a usage error in English", () => {
  assert.deepEqual(parseGlobalFlags(["status", "--lang", "pt", "--json"]), { lang: "pt", noColor: false, rest: ["status", "--json"] });
  assert.deepEqual(parseGlobalFlags(["--lang=en", "--no-color", "plan"]), { lang: "en", noColor: true, rest: ["plan"] });
  assert.deepEqual(parseGlobalFlags(["sync"]), { lang: null, noColor: false, rest: ["sync"] });
  for (const bad of [["status", "--lang", "fr"], ["status", "--lang"], ["--lang="]]) {
    const r = parseGlobalFlags(bad);
    assert.ok("error" in r, bad.join(" "));
    assert.match(r.error, /^--lang must be en or pt\./);
  }
});

test("confirm: English unchanged (Type yes to continue); Portuguese asks for sim and takes s / sim (and y / yes)", async () => {
  const e = fakeIo({}, ["y", "yes", "s", ""]);
  assert.equal(await confirm(e.io, "Apply?"), true);
  assert.equal(await confirm(e.io, "Apply?"), true);
  assert.equal(await confirm(e.io, "Apply?"), false, "s is not yes in English");
  assert.equal(await confirm(e.io, "Apply?"), false, "Enter is no");
  assert.deepEqual(e.asked[0], "Apply? Type yes to continue: ");
  const p = fakeIo({ lang: "pt" }, ["s", "sim", "y", "n", "não", ""]);
  for (const want of [true, true, true, false, false, false]) assert.equal(await confirm(p.io, "Aplicar?"), want);
  assert.equal(p.asked[0], "Aplicar? Escreve sim para continuar: ");
  const d = fakeIo({ lang: "pt" }, ["d", "sim", "nao"]);
  assert.equal(await confirmOrDetails(d.io, "Aplicar estas alterações?"), "details");
  assert.equal(await confirmOrDetails(d.io, "Aplicar estas alterações?"), "yes");
  assert.equal(await confirmOrDetails(d.io, "Aplicar estas alterações?"), "no");
  assert.equal(d.asked[0], "Aplicar estas alterações? Escreve sim para continuar, ou d para ver os detalhes: ");
  const de = fakeIo({}, ["d"]);
  assert.equal(await confirmOrDetails(de.io, "Apply these changes?"), "details");
  assert.equal(de.asked[0], "Apply these changes? Type yes to continue, or d for details: ");
});

test("parseGlobalFlags: -- ends the global options (what follows goes to the command as it is)", () => {
  assert.deepEqual(parseGlobalFlags(["projects", "set", "--", "--lang", "x"]), { lang: null, noColor: false, rest: ["projects", "set", "--", "--lang", "x"] });
  assert.deepEqual(parseGlobalFlags(["--no-color", "status", "--", "--no-color"]), { lang: null, noColor: true, rest: ["status", "--", "--no-color"] });
});

test("Portuguese plural forms agree in number", () => {
  assert.equal(fmt(pt["status.organizeFailed"], { n: 1, runId: "r", kinds: "1 title", error: "e" }), "1 alteração de organize não pôde ser feita na última execução (r): 1 title; primeiro erro: e");
  assert.equal(fmt(pt["status.organizeFailed"], { n: 2, runId: "r", kinds: "2 title", error: "e" }), "2 alterações de organize não puderam ser feitas na última execução (r): 2 title; primeiro erro: e");
  assert.equal(fmt(pt["status.organize.undone"], { n: 1 }), ", 1 desfeita");
  assert.equal(fmt(pt["status.organize.undone"], { n: 3 }), ", 3 desfeitas");
  assert.match(fmt(pt["status.nativeUnknown"], { n: 1, names: "x" }), /se o T3 Code já não a mostra, retoma-a num terminal/);
  assert.match(fmt(pt["status.nativeUnknown"], { n: 2, names: "x" }), /se o T3 Code já não mostrar alguma delas, retoma-a num terminal/);
});
