// Locale formatting for numbers, dates, relative times and durations, in English and Portuguese.
//
// The output is built by hand from fixed tables, not taken from full-format Intl output: ICU differs between Node
// versions and operating systems (pt-PT does not group "4007", and groups with U+202F elsewhere). Intl is used only for
// what is stable everywhere: the numeric parts of a date in a given time zone.
//
// Thousands are separated by a plain space in Portuguese, not a no-break space: it has the same width in every console
// and survives copy and paste. The cost is that a line wrap can split a number, which the tables never do.

import type { Lang } from "../assistant/i18n.ts";

export interface Fmt {
  n(x: number): string;
  date(iso: string): string;
  ago(iso: string): string;
  dur(ms: number): string;
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Parts { year: number; month: number; day: number; hour: string; minute: string }

function partsOf(ms: number, timeZone: string | undefined): Parts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}), year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const get = (t: string): string => dtf.formatToParts(ms).find((p) => p.type === t)?.value ?? "0";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: get("hour").padStart(2, "0"), minute: get("minute").padStart(2, "0") };
}

const pad2 = (x: number): string => String(x).padStart(2, "0");

export function makeFmt(lang: Lang, now: () => number, timeZone?: string): Fmt {
  const pt = lang === "pt";
  const n = (x: number): string => {
    const r = Math.round(x);
    const digits = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, pt ? " " : ",");
    return (r < 0 ? "-" : "") + digits;
  };
  const date = (iso: string): string => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const p = partsOf(t, timeZone);
    const thisYear = partsOf(now(), timeZone).year === p.year;
    if (pt) return thisYear ? `${pad2(p.day)}/${pad2(p.month)} às ${p.hour}:${p.minute}` : `${pad2(p.day)}/${pad2(p.month)}/${p.year}`;
    const md = `${MONTHS_EN[p.month - 1]} ${p.day}`;
    return thisYear ? `${md}, ${p.hour}:${p.minute}` : `${md}, ${p.year}`;
  };
  const ago = (iso: string): string => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const s = Math.floor((now() - t) / 1000);
    if (s < 60) return pt ? "agora" : "just now"; // also a time in the future
    const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    const mo = Math.floor(d / 30), y = Math.floor(d / 365);
    const [v, pt1, ptN, en1, enN]: [number, string, string, string, string] =
      y >= 1 ? [y, "ano", "anos", "year", "years"]
      : mo >= 1 ? [mo, "mês", "meses", "month", "months"]
      : d >= 1 ? [d, "dia", "dias", "day", "days"]
      : h >= 1 ? [h, "h", "h", "h", "h"]
      : [m, "min", "min", "min", "min"];
    const unit = pt ? (v === 1 ? pt1 : ptN) : (v === 1 ? en1 : enN);
    return pt ? `há ${v} ${unit}` : `${v} ${unit} ago`;
  };
  const dur = (ms: number): string => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (h > 0) return `${h} h ${pad2(m)} min ${pad2(s)} s`;
    if (m > 0) return `${m} min ${pad2(s)} s`;
    return `${s} s`;
  };
  return { n, date, ago, dur };
}
