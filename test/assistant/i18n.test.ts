// The assistant's catalogues and text helpers: plural forms, placeholders and the keys the two languages share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOGUES, fmt, resolveLang, wrap } from "../../src/assistant/i18n.ts";
import { en } from "../../src/assistant/messages.en.ts";
import { pt } from "../../src/assistant/messages.pt.ts";

test("fmt: {name|one|many} picks the form by the number; a missing value stays; plain placeholders still work", () => {
  assert.equal(fmt("{n} {n|file|files}", { n: 1 }), "1 file");
  assert.equal(fmt("{n} {n|file|files}", { n: 0 }), "0 files");
  assert.equal(fmt("{n} {n|file|files}", { n: 12 }), "12 files");
  assert.equal(fmt("{n|it is|they are} ({k})", { n: 1, k: "x" }), "it is (x)");
  assert.equal(fmt("{n|a|b}", {}), "{n|a|b}");
  assert.equal(fmt("{n|a|b}", { n: "many" }), "b", "not a number: the many form");
  assert.equal(fmt("{a} and {b}", { a: 1 }), "1 and {b}");
});

test("catalogues: EN and PT have the same keys, the same placeholders and the same plural switches", () => {
  assert.deepEqual(Object.keys(pt).sort(), Object.keys(en).sort());
  const plain = (s: string): string[] => [...s.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)].map((m) => m[1]!).sort();
  const plural = (s: string): string[] => [...s.matchAll(/\{([a-zA-Z0-9_-]+)\|[^|}]*\|[^}]*\}/g)].map((m) => m[1]!);
  const vars = (s: string): string[] => [...new Set([...plain(s), ...plural(s)])].sort();
  for (const k of Object.keys(en) as (keyof typeof en)[]) {
    assert.deepEqual(plain(pt[k]), plain(en[k]), `placeholders of ${k}`);
    assert.deepEqual(vars(pt[k]), vars(en[k]), `variables (plural switches included) of ${k}`);
    assert.doesNotMatch(en[k], /\{[a-zA-Z0-9_-]+\|[^}]*$/m, `en.${k}: an unclosed plural switch`);
    assert.doesNotMatch(pt[k], /\{[a-zA-Z0-9_-]+\|[^}]*$/m, `pt.${k}: an unclosed plural switch`);
  }
});

test("every message reads well for 1 and for many, in both languages (no leftover braces, wraps to 80 columns)", () => {
  for (const [lang, cat] of Object.entries(CATALOGUES)) {
    for (const [k, v] of Object.entries(cat)) {
      for (const n of [1, 2]) {
        const names = [...v.matchAll(/\{([a-zA-Z0-9_-]+)[|}]/g)].map((m) => m[1]!);
        const vars = Object.fromEntries(names.map((name) => [name, ["path", "names", "folder", "setting", "key", "why", "scope", "title", "what", "ids", "message", "version", "alias", "email", "home", "id", "color", "runId", "undo", "fix", "reasons", "alias"].includes(name) ? "x" : n]));
        const out = fmt(v, vars);
        assert.doesNotMatch(out, /\{[^}]*\}/, `${lang}.${k} (${n}): ${out}`);
        for (const line of wrap(out)) assert.ok(line.length <= 80, `${lang}.${k}: ${line}`);
      }
    }
  }
});

test("the decisions and organize questions in both languages carry their default and the number as the screens need", () => {
  const one = (s: string): string => fmt(s, { sessions: 1, folders: 1, n: 1, p: 1, days: 1, general: "General" });
  const many = (s: string): string => fmt(s, { sessions: 11, folders: 5, n: 3, p: 2, days: 7, general: "General" });
  assert.equal(many(en.decTempSay).startsWith("11 conversations ran in 5 temporary folders"), true);
  assert.equal(one(en.decTempSay).startsWith("1 conversation ran in 1 temporary folder"), true);
  assert.equal(many(pt.decTempSay).startsWith("11 conversas correram em 5 pastas temporárias"), true);
  assert.equal(one(pt.decTempSay).startsWith("1 conversa correu em 1 pasta temporária"), true);
  assert.equal(one(en.organizeDeleteAsk), "Delete this empty project?");
  assert.equal(many(pt.organizeDeleteAsk), "Apagar estes projetos vazios?");
  assert.equal(en.organizeSettleAsk, "Also turn off T3 Code's auto-settle for new conversations?");
  assert.equal(en.organizePreviewHead, "What each project shows, now and with the defaults:");
});

test("resolveLang: Intl pt-PT locale gives pt when nothing else is set", () => {
  assert.equal(resolveLang(null, {}, null, "pt-PT"), "pt");
  assert.equal(resolveLang(null, {}, null, "pt-BR"), "pt");
  assert.equal(resolveLang(null, {}, null, "en-GB"), "en");
  assert.equal(resolveLang(null, {}, null, "de-DE"), "en", "anything that is not Portuguese is English");
  assert.equal(resolveLang(null, {}, null, ""), "en");
});

test("resolveLang: LC_ALL > LC_MESSAGES > LANG > Intl; pt_PT.UTF-8, pt-BR and pt all give pt", () => {
  assert.equal(resolveLang(null, { LANG: "en_US.UTF-8" }, null, "pt-PT"), "en", "LANG=en_US.UTF-8 beats Intl");
  assert.equal(resolveLang(null, { LANG: "pt_PT.UTF-8" }, null, "en-US"), "pt");
  assert.equal(resolveLang(null, { LANG: "pt_BR" }, null, "en-US"), "pt");
  assert.equal(resolveLang(null, { LANG: "pt" }, null, "en-US"), "pt");
  assert.equal(resolveLang(null, { LC_MESSAGES: "en_GB", LANG: "pt_PT" }, null, "pt-PT"), "en", "LC_MESSAGES beats LANG");
  assert.equal(resolveLang(null, { LC_ALL: "pt_PT", LC_MESSAGES: "en_GB", LANG: "en_US" }, null, "en-US"), "pt", "LC_ALL beats the rest");
});

test("resolveLang: empty, C and POSIX values fall through to the next source", () => {
  assert.equal(resolveLang(null, { LC_ALL: "", LANG: "pt_PT" }, null, "en-US"), "pt");
  assert.equal(resolveLang(null, { LC_ALL: "C", LC_MESSAGES: "POSIX", LANG: "pt_PT.UTF-8" }, null, "en-US"), "pt");
  assert.equal(resolveLang(null, { LANG: "C.UTF-8" }, null, "pt-PT"), "pt");
  assert.equal(resolveLang(null, { LANG: "  " }, null, "pt-PT"), "pt");
});

test("resolveLang: --lang > T3SM_LANG > config > environment", () => {
  assert.equal(resolveLang("en", { T3SM_LANG: "pt", LC_ALL: "pt_PT" }, "pt", "pt-PT"), "en", "--lang beats all");
  assert.equal(resolveLang(null, { T3SM_LANG: "en", LC_ALL: "pt_PT" }, "pt", "pt-PT"), "en", "T3SM_LANG beats config");
  assert.equal(resolveLang(null, { LC_ALL: "pt_PT" }, "en", "pt-PT"), "en", "config beats env");
  assert.equal(resolveLang(null, { T3SM_LANG: "fr", LANG: "pt_PT" }, null, "en-US"), "pt", "an unknown T3SM_LANG is ignored");
});
