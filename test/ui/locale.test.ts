// Locale formatting: numbers, dates, relative times and durations in English and Portuguese, on a fixed clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFmt } from "../../src/ui/locale.ts";

const NOW = Date.parse("2026-11-15T12:00:00Z"); // 12:00 in Lisbon (WET, UTC+0 in November)
const TZ = "Europe/Lisbon";
const pt = makeFmt("pt", () => NOW, TZ);
const en = makeFmt("en", () => NOW, TZ);

test("n: thousands grouped with a plain space (pt) or a comma (en)", () => {
  assert.equal(pt.n(4007), "4 007");
  assert.equal(en.n(4007), "4,007");
  assert.equal(pt.n(12), "12");
  assert.equal(pt.n(1234567), "1 234 567");
  assert.equal(en.n(1234567), "1,234,567");
  assert.equal(en.n(-4007), "-4,007");
  assert.equal(pt.n(0), "0");
});

test("date: this year without the year, older with it", () => {
  assert.equal(pt.date("2026-11-15T10:20:00Z"), "15/11 às 10:20");
  assert.equal(pt.date("2025-11-15T10:20:00Z"), "15/11/2025");
  assert.equal(en.date("2026-11-15T10:20:00Z"), "Nov 15, 10:20");
  assert.equal(en.date("2025-11-15T10:20:00Z"), "Nov 15, 2025");
});

test("date: rendered in the given time zone", () => {
  const ny = makeFmt("en", () => NOW, "America/New_York");
  assert.equal(ny.date("2026-11-15T10:20:00Z"), "Nov 15, 05:20");
  assert.equal(makeFmt("pt", () => NOW, "Asia/Tokyo").date("2026-07-01T23:30:00Z"), "02/07 às 08:30");
});

test("date: an unparsable value comes back as it is", () => {
  assert.equal(pt.date("not a date"), "not a date");
  assert.equal(pt.ago("not a date"), "not a date");
});

test("ago: now, minutes, hours, days, months, years", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
  assert.equal(pt.ago(at(30 * S)), "agora");
  assert.equal(en.ago(at(30 * S)), "just now");
  assert.equal(pt.ago(at(5 * M)), "há 5 min");
  assert.equal(en.ago(at(5 * M)), "5 min ago");
  assert.equal(pt.ago(at(3 * H)), "há 3 h");
  assert.equal(en.ago(at(3 * H)), "3 h ago");
  assert.equal(pt.ago(at(3 * D)), "há 3 dias");
  assert.equal(en.ago(at(3 * D)), "3 days ago");
  assert.equal(pt.ago(at(1 * D)), "há 1 dia");
  assert.equal(en.ago(at(1 * D)), "1 day ago");
  assert.equal(pt.ago(at(65 * D)), "há 2 meses");
  assert.equal(en.ago(at(35 * D)), "1 month ago");
  assert.equal(pt.ago(at(800 * D)), "há 2 anos");
  assert.equal(en.ago(at(400 * D)), "1 year ago");
});

test("ago: a time in the future counts as now", () => {
  assert.equal(pt.ago(new Date(NOW + 5000).toISOString()), "agora");
});

test("dur: minutes and zero-padded seconds, the same in both languages", () => {
  assert.equal(pt.dur(125_000), "2 min 05 s");
  assert.equal(en.dur(125_000), "2 min 05 s");
  assert.equal(en.dur(45_000), "45 s");
  assert.equal(en.dur(0), "0 s");
  assert.equal(en.dur(3_725_000), "1 h 02 min 05 s");
  assert.equal(en.dur(120_000), "2 min 00 s");
});
