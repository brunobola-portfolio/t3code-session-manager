#!/usr/bin/env node
/**
 * Generates every image in docs/assets/ from code, deterministically (no clock, no randomness, no binary editor),
 * so CI can regenerate them and fail on drift:
 *
 *   node scripts/build-assets.js
 *
 * Light, dark and narrow (phone) variants of the hero, the flow and the accounts art, a social card, an icon, and a
 * terminal demo: an animated SVG (CSS keyframes, which GitHub renders through <img>) of a scripted `t3sm plan` and
 * `t3sm apply` on synthetic data, plus a static frame for `prefers-reduced-motion`. The demo's plan summary and wave
 * lines come from t3sm's own formatters (src/plan/report.ts, src/apply/apply.ts), so a change to the CLI's output
 * shows up here as drift. Text is SVG text in system font stacks; there are no scripts, web fonts or external refs.
 * The palette is defined once, right below, so a branding pass only has to swap it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO } from "./release.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "assets");

// ------------------------------------------------------------------ palette (the only place colours are defined)
const THEMES = {
  light: {
    bg: "#F7F7F4", panel: "#FFFFFF", line: "#E1E4EA", ink: "#161B26", muted: "#565E71", dim: "#646C80", faint: "#A6ADBB",
    accent: "#3451D1", accentSoft: "#E9EDFD", accentInk: "#FFFFFF",
    personal: "#B8641A", personalSoft: "#FBEEDF", work: "#6A42C9", workSoft: "#EFE8FC",
    src3: "#1B8796", src4: "#B23A62", src5: "#3D6FD9",
    ok: "#23875A", warn: "#A87300",
    term: "#FFFFFF", termBar: "#EEF0F4", termInk: "#1D2433", termDim: "#6A7285", termPrompt: "#3451D1", termGood: "#23875A",
  },
  dark: {
    bg: "#11151C", panel: "#181E28", line: "#283140", ink: "#E8EBF1", muted: "#9CA5B7", dim: "#8D96A9", faint: "#566079",
    accent: "#7D94FF", accentSoft: "#202A47", accentInk: "#0E1220",
    personal: "#EFA25A", personalSoft: "#3A2918", work: "#AC8BF5", workSoft: "#2C2347",
    src3: "#4CC3D1", src4: "#E7799D", src5: "#7FA5F5",
    ok: "#5CCB8F", warn: "#F0C25A",
    term: "#0C1016", termBar: "#161C26", termInk: "#E3E7EE", termDim: "#8B94A7", termPrompt: "#8EA2FF", termGood: "#6BD69B",
  },
};

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
/** Average advance of the stacks above, as a fraction of the font size (used for layout only). */
const MONO_ADVANCE = 0.6;
const SANS_ADVANCE = 0.53;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const monoW = (s, size) => [...s].length * size * MONO_ADVANCE;
const sansW = (s, size, bold = false) => [...s].length * size * (bold ? SANS_ADVANCE + 0.04 : SANS_ADVANCE);

/** Greedy word wrap by estimated width. */
function wrap(text, maxW, size, bold = false) {
  const lines = [];
  let cur = "";
  for (const word of text.split(" ")) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && sansW(next, size, bold) > maxW) { lines.push(cur); cur = word; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

const text = (x, y, s, { size = 16, fill, weight = 400, font = SANS, anchor = "start", extra = "" } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}"${weight !== 400 ? ` font-weight="${weight}"` : ""}${anchor !== "start" ? ` text-anchor="${anchor}"` : ""} fill="${fill}"${extra}>${esc(s)}</text>`;

const svg = (w, h, t, body, title, { frame = true } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>${frame ? `
  <rect width="${w}" height="${h}" rx="14" fill="${t.bg}"/>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="none" stroke="${t.line}"/>` : ""}${body}
</svg>
`;

// ------------------------------------------------------------------ shared content (synthetic, no real data)
/** The sources shown in the art. Keep in step with the status table in docs/harnesses.md. */
const SOURCES = [
  { label: "Claude Code · Personal", color: "personal" },
  { label: "Claude Code · Work", color: "work" },
  { label: "Codex CLI", color: "src3" },
  { label: "Pi", color: "src4" },
  { label: "OpenCode", color: "src5" },
];
const THREADS = [
  { project: "demo", rows: [["Add a dark mode toggle", "personal"], ["Fix the missing icon warning", "personal"]] },
  { project: "api", rows: [["Fix the flaky export test", "work"], ["Rotate the staging signing key", "work"], ["Refactor the CLI parser", "work", "from OpenCode"]] },
];
const ACCOUNT_LABEL = { personal: "Personal", work: "Work" };

function dot(t, cx, cy, color, r = 5) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${t[color]}"/>`;
}

/** A pill chip with a coloured dot; returns { svg, w }. */
function sourceChip(t, x, y, { label, color }, { size = 15, h = 36, w = null } = {}) {
  const width = w ?? Math.round(sansW(label, size, true) + 44);
  return {
    w: width,
    svg: `
  <rect x="${x}" y="${y}" width="${width}" height="${h}" rx="${h / 2}" fill="${t.panel}" stroke="${t.line}"/>
  ${dot(t, x + 20, y + h / 2, color)}
  ${text(x + 34, y + h / 2 + size * 0.36, label, { size, fill: t.ink, weight: 600 })}`,
  };
}

function accountTag(t, xRight, cy, acct, size = 12) {
  const label = ACCOUNT_LABEL[acct];
  const w = Math.round(sansW(label, size, true) + 18);
  const h = size + 10;
  return `<rect x="${xRight - w}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${t[`${acct}Soft`]}"/>
  ${text(xRight - w / 2, cy + size * 0.36, label, { size, fill: t[acct], weight: 700, anchor: "middle" })}`;
}

/** A stylised T3 Code window listing imported threads, each tagged with its account. */
function t3Window(t, x, y, w, { size = 14, rowH = 30, headH = 30 } = {}) {
  let body = "";
  let cy = y + 36 + 14;
  for (const group of THREADS) {
    cy += headH / 2;
    body += `
  <path d="M${x + 18},${cy - 6} h6 l2,2 h8 v9 h-16 z" fill="none" stroke="${t.dim}" stroke-width="1.4" stroke-linejoin="round"/>
  ${text(x + 42, cy + 5, group.project, { size: size + 1, fill: t.ink, weight: 700 })}`;
    cy += headH / 2;
    for (const [title, acct, from] of group.rows) {
      cy += rowH / 2;
      const room = w - 50 - 92;
      const maxChars = Math.floor(room / (size * SANS_ADVANCE));
      const shown = [...title].length > maxChars ? `${[...title].slice(0, maxChars - 1).join("")}…` : title;
      body += `
  ${text(x + 42, cy + size * 0.36, shown, { size, fill: t.ink })}
  ${accountTag(t, x + w - 14, cy, acct, size - 2)}`;
      if (from) body += `
  ${text(x + 42, cy + size * 0.36 + size + 2, from, { size: size - 3, fill: t.dim })}`;
      cy += rowH / 2 + (from ? size : 0);
    }
  }
  const h = cy - y + 12;
  return {
    h,
    svg: `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${t.panel}" stroke="${t.line}"/>
  <path d="M${x},${y + 36} h${w}" stroke="${t.line}"/>
  ${dot(t, x + 18, y + 18, "line", 5)}${dot(t, x + 34, y + 18, "line", 5)}${dot(t, x + 50, y + 18, "line", 5)}
  ${text(x + w / 2, y + 23, "T3 Code", { size: 13, fill: t.dim, weight: 600, anchor: "middle" })}${body}`,
  };
}

function pills(t, x, y, cmds, { size = 16, h = 40, gap = 36 } = {}) {
  let out = "";
  let cx = x;
  cmds.forEach((c, i) => {
    const w = Math.round(monoW(c, size) + 28);
    out += `
  <rect x="${cx}" y="${y}" width="${w}" height="${h}" rx="8" fill="${i === cmds.length - 1 ? t.accent : t.panel}" stroke="${i === cmds.length - 1 ? t.accent : t.line}"/>
  ${text(cx + 14, y + h / 2 + size * 0.36, c, { size, font: MONO, fill: i === cmds.length - 1 ? t.accentInk : t.ink, weight: 600 })}`;
    cx += w;
    if (i < cmds.length - 1) {
      out += `
  <path d="M${cx + 8},${y + h / 2} h${gap - 16} m-6,-5 l6,5 l-6,5" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
      cx += gap;
    }
  });
  return { svg: out, w: cx - x };
}

// ------------------------------------------------------------------ hero
const PITCH = ["Every agent session, in T3 Code,", "under the right Claude subscription."];

/** Compact, so the README's Quick start stays on the first screen. */
function hero(t) {
  const W = 1280; const H = 320;
  const chipX = 588; const chipW = 206; const winX = 868; const winW = 356; const winY = 24;
  const ys = SOURCES.map((_, i) => 34 + i * 52);
  const win = t3Window(t, winX, winY, winW, { rowH: 26, headH: 26 });
  const targets = [113, 139, 191, 217, 243]; // the five thread rows of the window above
  let chips = "";
  let curves = "";
  SOURCES.forEach((s, i) => {
    chips += sourceChip(t, chipX, ys[i], s, { w: chipW }).svg;
    const y0 = ys[i] + 18; const y1 = targets[i];
    curves += `
  <path d="M${chipX + chipW},${y0} C${chipX + chipW + 44},${y0} ${winX - 44},${y1} ${winX - 6},${y1}" fill="none" stroke="${t[s.color]}" stroke-width="2" stroke-linecap="round" opacity="0.85"/>`;
  });
  const body = `
  ${text(64, 98, "t3sm", { size: 76, fill: t.ink, weight: 800, extra: ' letter-spacing="-2"' })}
  ${text(66, 128, "t3code-session-manager", { size: 17, fill: t.dim, font: MONO })}
  ${PITCH.map((l, i) => text(66, 174 + i * 32, l, { size: 25, fill: t.muted })).join("\n  ")}
  ${pills(t, 64, 238, ["t3sm doctor", "t3sm plan", "t3sm apply"]).svg}
  ${text(66, 302, "Reviewed before it writes. Journaled. Reversible.", { size: 15, fill: t.dim })}${curves}${chips}${win.svg}`;
  return svg(W, H, t, body, "t3sm: every agent session, in T3 Code, under the right Claude subscription");
}

const NW = 720;
function heroNarrow(t) {
  let chips = "";
  let x = 40; let y = 262;
  for (const s of SOURCES) {
    const c = sourceChip(t, x, y, s, { size: 19, h: 44 });
    if (x + c.w > NW - 40) { x = 40; y += 58; }
    chips += sourceChip(t, x, y, s, { size: 19, h: 44 }).svg;
    x += c.w + 12;
  }
  const arrowY = y + 70;
  const win = t3Window(t, 40, arrowY + 44, NW - 80, { size: 20, rowH: 42, headH: 40 });
  const H = arrowY + 44 + win.h + 40;
  const body = `
  ${text(40, 104, "t3sm", { size: 84, fill: t.ink, weight: 800, extra: ' letter-spacing="-2"' })}
  ${["Every session from every agent and", "every Claude account, in T3 Code,", "under the right subscription."].map((l, i) => text(42, 158 + i * 36, l, { size: 28, fill: t.muted })).join("\n  ")}${chips}
  <path d="M${NW / 2},${arrowY} v30 m-8,-9 l8,9 l8,-9" fill="none" stroke="${t.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${win.svg}`;
  return svg(NW, H, t, body, "t3sm: every agent session, in T3 Code, under the right Claude subscription");
}

// ------------------------------------------------------------------ flow
const STEPS = [
  { head: "Check", cmd: "t3sm doctor", lines: "T3 Code, its version, your accounts and agents. Read-only." },
  { head: "Plan", cmd: "t3sm plan", lines: "Every session gets a project, an account and an action. Only plan.md is written." },
  { head: "Review", cmd: "plan.md", lines: "Read the Project accounts table and the warnings. Adjust config.json, plan again." },
  { head: "Apply", cmd: "t3sm apply", lines: "T3 Code's own importer, in waves. Every file time journaled, then put back." },
  { head: "Stay in sync", cmd: "t3sm sync", lines: "New sessions on a schedule or a watcher. merge brings terminal work back." },
];
const GUARANTEES = [
  ["Never writes T3 Code's database", "Only its CLI and its RPC API."],
  ["Native transcripts untouched", "Conversions and merges are new files."],
  ["Journal before change", "File times restored, even after a crash."],
  ["Undo", "t3sm rollback reverses a run."],
];

function flow(t) {
  const W = 1280; const x0 = 48; const gap = 22; const colW = Math.floor((W - 2 * x0 - 4 * gap) / 5);
  let cols = "";
  STEPS.forEach((s, i) => {
    const x = x0 + i * (colW + gap);
    const lines = wrap(s.lines, colW - 40, 15);
    cols += `
  <rect x="${x}" y="64" width="${colW}" height="236" rx="12" fill="${t.panel}" stroke="${i === 2 ? t.accent : t.line}"${i === 2 ? ' stroke-width="1.5"' : ""}/>
  <circle cx="${x + 34}" cy="104" r="16" fill="none" stroke="${t.accent}" stroke-width="2"/>
  ${text(x + 34, 110, String(i + 1), { size: 16, fill: t.accent, weight: 700, anchor: "middle" })}
  ${text(x + 60, 111, s.head, { size: 20, fill: t.ink, weight: 700 })}
  <rect x="${x + 20}" y="134" width="${Math.round(monoW(s.cmd, 14) + 20)}" height="28" rx="6" fill="${t.accentSoft}"/>
  ${text(x + 30, 153, s.cmd, { size: 14, font: MONO, fill: t.accent, weight: 600 })}
  ${lines.map((l, j) => text(x + 20, 194 + j * 23, l, { size: 15, fill: t.muted })).join("\n  ")}`;
    if (i < STEPS.length - 1) {
      const ax = x + colW + 3;
      cols += `
  <path d="M${ax},182 h${gap - 6} m-5,-5 l5,5 l-5,5" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  });
  const gW = Math.floor((W - 2 * x0 - 3 * gap) / 4);
  const g = GUARANTEES.map(([h, d], i) => {
    const x = x0 + i * (gW + gap);
    return `
  <rect x="${x}" y="336" width="6" height="52" rx="3" fill="${t.ok}"/>
  ${text(x + 20, 356, h, { size: 16, fill: t.ink, weight: 700 })}
  ${text(x + 20, 381, d, { size: 15, fill: t.muted })}`;
  }).join("");
  const body = `
  ${text(48, 42, "From scattered transcripts to T3 Code threads, with a review in the middle", { size: 15, fill: t.dim })}${cols}${g}`;
  return svg(W, 420, t, body, "How t3sm works: check, plan, review, apply, stay in sync; guarantees: never writes T3 Code's database, native transcripts untouched, journal before change, undo");
}

function flowNarrow(t) {
  const stepH = 150;
  let y = 70;
  let out = "";
  STEPS.forEach((s, i) => {
    const lines = wrap(s.lines, NW - 80 - 130, 21);
    const h = Math.max(stepH - 20, 60 + lines.length * 30);
    out += `
  <rect x="40" y="${y}" width="${NW - 80}" height="${h}" rx="12" fill="${t.panel}" stroke="${i === 2 ? t.accent : t.line}"/>
  <circle cx="84" cy="${y + 44}" r="22" fill="none" stroke="${t.accent}" stroke-width="2.5"/>
  ${text(84, y + 52, String(i + 1), { size: 22, fill: t.accent, weight: 700, anchor: "middle" })}
  ${text(126, y + 46, s.head, { size: 27, fill: t.ink, weight: 700 })}
  ${text(NW - 60, y + 46, s.cmd, { size: 19, font: MONO, fill: t.accent, weight: 600, anchor: "end" })}
  ${lines.map((l, j) => text(126, y + 84 + j * 30, l, { size: 21, fill: t.muted })).join("\n  ")}`;
    y += h + 18;
  });
  const H = y + 22;
  const body = `
  ${text(40, 46, "How t3sm works", { size: 24, fill: t.dim })}${out}`;
  return svg(NW, H, t, body, "How t3sm works: check, plan, review, apply, stay in sync");
}

// ------------------------------------------------------------------ accounts
const PROJECT_RULES = [
  ["routes in config.json", "Your explicit rule, first match wins"],
  [".vscode/settings.json", "The account VS Code pins for the folder"],
  ["Most recent session", "The account you used there last"],
  ["defaultAccount", "Everything else"],
];

function folder(t, x, y, label, acct, size = 15) {
  return `
  <path d="M${x},${y + 6} h18 l5,6 h33 v38 h-56 z" fill="${t[`${acct}Soft`]}" stroke="${t[acct]}" stroke-width="1.6" stroke-linejoin="round"/>
  ${text(x + 70, y + 26, label, { size, font: MONO, fill: t.ink, weight: 600 })}
  ${text(x + 70, y + 48, `${ACCOUNT_LABEL[acct]} subscription`, { size: size - 1, fill: t[acct], weight: 600 })}`;
}

function dupRow(t, x, y, kind, verdict, size = 15) {
  return `
  <rect x="${x}" y="${y}" width="104" height="30" rx="6" fill="${t.accentSoft}"/>
  ${text(x + 52, y + 20, kind, { size: size - 1, fill: t.accent, weight: 700, anchor: "middle" })}
  ${text(x + 120, y + 20, verdict, { size, fill: t.muted })}`;
}

function accounts(t) {
  const W = 1280; const H = 470;
  const L = 48; const LW = 560; const R = 648; const RW = 584;
  const rules = PROJECT_RULES.map(([h, d], i) => {
    const y = 120 + i * 76;
    return `
  <rect x="${R + 24}" y="${y}" width="${RW - 48}" height="58" rx="10" fill="${t.panel}" stroke="${t.line}"/>
  <circle cx="${R + 56}" cy="${y + 29}" r="14" fill="${t.accent}"/>
  ${text(R + 56, y + 35, String(i + 1), { size: 15, fill: t.accentInk, weight: 700, anchor: "middle" })}
  ${text(R + 84, y + 25, h, { size: 16, font: MONO, fill: t.ink, weight: 600 })}
  ${text(R + 84, y + 47, d, { size: 15, fill: t.muted })}${i < PROJECT_RULES.length - 1 ? `
  <path d="M${R + 56},${y + 58} v18" stroke="${t.accent}" stroke-width="2"/>` : ""}`;
  }).join("");
  const body = `
  <rect x="${L}" y="40" width="${LW}" height="${H - 72}" rx="12" fill="none" stroke="${t.line}"/>
  <rect x="${R}" y="40" width="${RW}" height="${H - 72}" rx="12" fill="none" stroke="${t.line}"/>
  ${text(L + 24, 80, "Which account a session belongs to", { size: 20, fill: t.ink, weight: 700 })}
  ${text(R + 24, 80, "Which account a project opens with", { size: 20, fill: t.ink, weight: 700 })}
  ${text(L + 24, 112, "The folder the transcript lives in is the truth.", { size: 15, fill: t.muted })}
  ${folder(t, L + 28, 134, "~/.claude", "personal")}
  ${folder(t, L + 300, 134, "~/.claude-work", "work")}
  ${text(L + 24, 232, "A session in both folders is compared by content:", { size: 15, fill: t.muted })}
  ${dupRow(t, L + 24, 250, "identical", "one thread, in the project's account")}
  ${dupRow(t, L + 24, 292, "prefix", "one thread, from the longer copy")}
  ${dupRow(t, L + 24, 334, "diverged", "two threads, one per account (a fork)")}
  ${text(L + 24, 396, "Stale copies can be moved aside with t3sm dedupe.", { size: 15, fill: t.dim })}
  ${text(R + 24, 106, "Used for new threads and for converted sessions.", { size: 15, fill: t.muted })}${rules}`;
  return svg(W, H, t, body, "Choosing the subscription. A session belongs to the account whose folder holds it; copies in both accounts are compared (identical: one thread; prefix: the longer copy; diverged: two threads). A project's default account: routes in config.json, then the VS Code pin, then the most recent session, then defaultAccount.");
}

function accountsNarrow(t) {
  let y = 40;
  let out = `
  ${text(40, y + 30, "A session belongs to", { size: 26, fill: t.ink, weight: 700 })}
  ${text(40, y + 64, "the account folder that holds it.", { size: 22, fill: t.muted })}`;
  y += 92;
  out += folder(t, 44, y, "~/.claude", "personal", 20);
  out += folder(t, 44, y + 76, "~/.claude-work", "work", 20);
  y += 172;
  out += `
  ${text(40, y, "Copies in both: identical → one thread;", { size: 21, fill: t.muted })}
  ${text(40, y + 30, "prefix → the longer one; diverged → both.", { size: 21, fill: t.muted })}`;
  y += 82;
  out += `
  ${text(40, y, "A project opens with, first match:", { size: 26, fill: t.ink, weight: 700 })}`;
  y += 22;
  PROJECT_RULES.forEach(([h, d], i) => {
    out += `
  <rect x="40" y="${y}" width="${NW - 80}" height="76" rx="10" fill="${t.panel}" stroke="${t.line}"/>
  <circle cx="78" cy="${y + 38}" r="18" fill="${t.accent}"/>
  ${text(78, y + 45, String(i + 1), { size: 19, fill: t.accentInk, weight: 700, anchor: "middle" })}
  ${text(112, y + 33, h, { size: 21, font: MONO, fill: t.ink, weight: 600 })}
  ${text(112, y + 60, d, { size: 19, fill: t.muted })}`;
    y += 88;
  });
  return svg(NW, y + 24, t, out, "Choosing the subscription: the session's account folder is the truth; a project opens with routes, then the VS Code pin, then the most recent session, then defaultAccount.");
}

// ------------------------------------------------------------------ social card + icon
const STATUS = [
  ["Claude Code", "verified live", "ok"],
  ["OpenCode", "verified live", "ok"],
  ["Codex CLI", "partly verified", "warn"],
  ["Pi", "partly verified", "warn"],
];

function social(t) {
  const W = 1280; const H = 640;
  const win = t3Window(t, 820, 120, 400, { size: 16, rowH: 38, headH: 36 });
  let x = 64;
  const chips = STATUS.map(([name, state, c]) => {
    const label = `${name} · ${state}`;
    const w = Math.round(sansW(label, 17, true) + 44);
    const s = `
  <rect x="${x}" y="470" width="${w}" height="40" rx="20" fill="${t.panel}" stroke="${t.line}"/>
  <circle cx="${x + 21}" cy="490" r="6" fill="${t[c]}"/>
  ${text(x + 35, 496, label, { size: 17, fill: t.ink, weight: 600 })}`;
    x += w + 12;
    return s;
  }).join("");
  const body = `
  ${text(64, 170, "t3sm", { size: 120, fill: t.ink, weight: 800, extra: ' letter-spacing="-3"' })}
  ${text(68, 232, "t3code-session-manager", { size: 26, fill: t.dim, font: MONO })}
  ${["Every agent session, in T3 Code,", "under the right Claude subscription."].map((l, i) => text(66, 310 + i * 46, l, { size: 36, fill: t.muted })).join("\n  ")}${chips}${win.svg}
  ${text(64, H - 44, `github.com/${REPO}`, { size: 20, fill: t.dim, font: MONO })}
  ${text(W - 64, H - 44, "Open source, MIT. BolaLabs", { size: 20, fill: t.dim, anchor: "end" })}`;
  return svg(W, H, t, body, "t3sm social card: every agent session, in T3 Code, under the right Claude subscription");
}

function icon() {
  const t = THEMES.light;
  const body = `
  <rect width="256" height="256" rx="56" fill="${t.accent}"/>
  <path d="M52,72 C120,72 120,128 188,128" fill="none" stroke="${THEMES.dark.personal}" stroke-width="16" stroke-linecap="round"/>
  <path d="M52,128 H188" fill="none" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round"/>
  <path d="M52,184 C120,184 120,128 188,128" fill="none" stroke="${THEMES.dark.work}" stroke-width="16" stroke-linecap="round"/>
  <circle cx="196" cy="128" r="24" fill="#FFFFFF"/>`;
  return svg(256, 256, t, body, "t3sm icon", { frame: false });
}

// ------------------------------------------------------------------ terminal demo (synthetic)
const { renderTerminalSummary } = await import(new URL("../src/plan/report.ts", import.meta.url).href);
const { progressLine } = await import(new URL("../src/apply/apply.ts", import.meta.url).href);

/** A synthetic plan with the counts the demo shows. Nothing here comes from a real machine. */
function demoPlan() {
  const items = [];
  const add = (n, harness, action) => { for (let i = 0; i < n; i++) items.push({ session: { harness }, action, notes: [] }); };
  add(251, "claude", { kind: "import", instanceId: "claude-work" });
  add(155, "claude", { kind: "import", instanceId: "claudeAgent" });
  add(6, "opencode", { kind: "convert-import", instanceId: "claudeAgent" });
  add(41, "claude", { kind: "skip", reason: "backup-copy" });
  add(9, "claude", { kind: "skip", reason: "cwd-missing" });
  add(5, "claude", { kind: "skip", reason: "active" });
  add(3, "claude", { kind: "skip", reason: "subagent" });
  return {
    version: 1, runId: "20261111-093012-a1b2", createdAt: "2026-11-11T09:30:12.000Z", t3Version: "0.1.9-nightly.20261110.4465",
    instancesToCreate: [{ id: "claude-work", driver: "claudeAgent", displayName: "Claude · Work", accentColor: null, homePath: "~/.claude-work", environment: [] }],
    projectsToCreate: Array.from({ length: 12 }, (_, i) => ({ root: `C:/work/p${i}`, title: `p${i}`, defaultInstanceId: null })),
    projectAccounts: [], projectDefaults: [], mirrorCopies: [], items, warnings: [],
  };
}

const PLAN_PATH = "~/.t3code-session-manager/runs/20261111-093012-a1b2/plan.md";
const NAMES = { claudeAgent: "Claude · Personal", "claude-work": "Claude · Work" };
const WAVES = [[5, 171], [5, 148], [3, 71], [1, 22]];
const RESULT = "Imported 412, failed 0, converted 6. Run 20261111-093125-c3d4.";

/** Terminal lines of the two screens: [kind, text]; kinds: cmd (typed), out, dim, bold, ask (typed answer), good. */
function demoScript() {
  const summary = renderTerminalSummary(demoPlan(), { color: false, planPath: PLAN_PATH, names: NAMES }).trimEnd().split("\n");
  const styled = summary.map((l) => [/^Plan /.test(l) ? "bold" : /^\s+(Imports by account|Top skips)/.test(l) ? "dim" : "out", l]);
  const waves = WAVES.map(([p, s], i) => ["out", progressLine({ wave: i + 1, totalWaves: WAVES.length, projects: p, sessions: s, imported: s, retry: 0, failed: 0, deferred: 0 })]);
  return {
    one: [["cmd", "t3sm plan"], ...styled],
    // `--yes` skips the confirmation (which would print the same summary again), so the apply screen stays short.
    two: [["cmd", "t3sm apply --yes"], ...waves, ["good", RESULT], ["prompt", ""]],
  };
}

const TERM = { W: 920, size: 14, lh: 19, padX: 26, top: 58 };
const CYCLE = 18; // seconds

function demo(t, { animated }) {
  const { one, two } = demoScript();
  const rows = Math.max(one.length, two.length);
  const H = TERM.top + rows * TERM.lh + 14;
  const cw = TERM.size * MONO_ADVANCE;
  const css = [];
  let n = 0;
  const pct = (s) => `${((s / CYCLE) * 100).toFixed(2)}%`;

  /** Appear at `on`, disappear at `off` (seconds in the cycle). Base style = visible (the static frame). */
  const show = (on, off) => {
    const id = `a${n++}`;
    css.push(`@keyframes ${id}{0%,${pct(on)}{opacity:0}${pct(on + 0.01)},${pct(off)}{opacity:1}${pct(off + 0.3)},100%{opacity:0}}.${id}{animation:${id} ${CYCLE}s linear infinite}`);
    return id;
  };
  /** A cover over typed text that steps right from `start` over `dur` seconds. */
  const type = (start, dur, chars, width) => {
    const id = `a${n++}`;
    css.push(`@keyframes ${id}{0%,${pct(start)}{transform:translateX(0);animation-timing-function:steps(${chars},end)}${pct(start + dur)},100%{transform:translateX(${width.toFixed(1)}px)}}.${id}{animation:${id} ${CYCLE}s linear infinite}`);
    return id;
  };

  function screen(lines, t0, tEnd, base) {
    let out = "";
    let at = t0;
    lines.forEach(([kind, s], i) => {
      const y = TERM.top + i * TERM.lh + TERM.size;
      const x = TERM.padX;
      if (kind === "cmd" || kind === "prompt") {
        const typed = s;
        const cls = animated ? show(at, tEnd) : null;
        let cover = "";
        if (animated && typed) {
          const w = monoW(typed, TERM.size) + cw;
          const c = type(at + 0.4, typed.length * 0.07, typed.length, w);
          cover = `<rect class="${c}" x="${x + 2 * cw}" y="${y - TERM.size}" width="${w.toFixed(1)}" height="${TERM.lh}" fill="${t.term}" transform="translate(${w.toFixed(1)} 0)"/>`;
          at += 0.4 + typed.length * 0.07 + 0.5;
        }
        out += `
  <g${cls ? ` class="${cls}"` : ""}${base}><text x="${x}" y="${y}" font-family="${MONO}" font-size="${TERM.size}" fill="${t.termInk}"><tspan fill="${t.termPrompt}" font-weight="700">$ </tspan>${esc(typed)}</text>${kind === "prompt" ? `<rect x="${x + 2 * cw}" y="${y - TERM.size + 2}" width="${cw.toFixed(1)}" height="${TERM.size + 2}" fill="${t.termDim}"/>` : ""}${cover}</g>`;
        return;
      }
      if (kind === "ask") {
        const [q, a] = s.split("|");
        const cls = animated ? show(at, tEnd) : null;
        let cover = "";
        if (animated) {
          const w = monoW(a, TERM.size) + cw;
          const c = type(at + 0.6, a.length * 0.15, a.length, w);
          cover = `<rect class="${c}" x="${(x + monoW(q, TERM.size)).toFixed(1)}" y="${y - TERM.size}" width="${w.toFixed(1)}" height="${TERM.lh}" fill="${t.term}" transform="translate(${w.toFixed(1)} 0)"/>`;
          at += 0.6 + a.length * 0.15 + 0.6;
        }
        out += `
  <g${cls ? ` class="${cls}"` : ""}${base}><text x="${x}" y="${y}" font-family="${MONO}" font-size="${TERM.size}" fill="${t.termInk}">${esc(q)}<tspan font-weight="700">${esc(a)}</tspan></text>${cover}</g>`;
        return;
      }
      const fill = kind === "dim" ? t.termDim : kind === "good" ? t.termGood : t.termInk;
      const weight = kind === "bold" || kind === "good" ? ' font-weight="700"' : "";
      const isWave = /^Wave /.test(s);
      const cls = animated ? show(at, tEnd) : null;
      at += isWave ? 0.7 : 0.03;
      out += `
  <text${cls ? ` class="${cls}"` : ""} x="${x}" y="${y}" font-family="${MONO}" font-size="${TERM.size}" fill="${fill}"${weight}${base} xml:space="preserve">${esc(s)}</text>`;
    });
    return out;
  }

  // Screen one (the plan summary) is the static frame; screen two (apply) only plays in the animation.
  const s1 = screen(one, 0.6, 9.4, "");
  const s2 = animated ? screen(two, 10.2, CYCLE - 0.6, ' opacity="0"') : "";
  // The opacity attribute keeps screen two hidden when animations are off; its keyframes override it while running.
  const style = animated ? `
  <style>${css.join("")}@media (prefers-reduced-motion: reduce){[class^="a"]{animation:none!important}}</style>` : "";
  const body = `${style}
  <rect width="${TERM.W}" height="${H}" rx="12" fill="${t.term}"/>
  <rect x="0.5" y="0.5" width="${TERM.W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${t.line}"/>
  <path d="M0.5,40 V12.5 a12,12 0 0 1 12,-12 H${TERM.W - 12.5} a12,12 0 0 1 12,12 V40 Z" fill="${t.termBar}"/>
  ${dot(t, 22, 20, "faint", 6)}${dot(t, 42, 20, "faint", 6)}${dot(t, 62, 20, "faint", 6)}
  ${text(TERM.W / 2, 25, "t3sm · synthetic demo data", { size: 13, fill: t.termDim, weight: 600, anchor: "middle" })}${s1}${s2}`;
  const title = animated
    ? "Terminal demo on synthetic data: t3sm plan prints a summary (406 sessions to import as they are, 6 to convert from OpenCode, 58 skipped, imports split between two accounts); then t3sm apply --yes imports them in 4 waves and reports Imported 412, failed 0, converted 6."
    : "t3sm plan summary on synthetic data: 406 sessions to import as they are, 6 to convert from OpenCode, 58 skipped, 1 new instance, 12 new projects, imports split between Claude · Work and Claude · Personal, and the path of plan.md.";
  return svg(TERM.W, H, t, body, title, { frame: false });
}

// ------------------------------------------------------------------ write
function main() {
  mkdirSync(OUT, { recursive: true });
  const files = {};
  for (const [name, t] of Object.entries(THEMES)) {
    files[`hero-${name}.svg`] = hero(t);
    files[`hero-narrow-${name}.svg`] = heroNarrow(t);
    files[`flow-${name}.svg`] = flow(t);
    files[`flow-narrow-${name}.svg`] = flowNarrow(t);
    files[`accounts-${name}.svg`] = accounts(t);
    files[`accounts-narrow-${name}.svg`] = accountsNarrow(t);
    files[`social-${name}.svg`] = social(t);
    files[`demo-${name}.svg`] = demo(t, { animated: true });
    files[`demo-static-${name}.svg`] = demo(t, { animated: false });
  }
  files["icon.svg"] = icon();
  for (const [name, content] of Object.entries(files)) {
    const file = join(OUT, name);
    writeFileSync(file, content);
    console.log(`wrote ${relative(ROOT, file).replace(/\\/g, "/")}`);
  }
}

main();
