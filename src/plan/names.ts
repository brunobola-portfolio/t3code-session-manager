import { maskAddressesIn } from "../core/mask.ts";

// Clean, unique, bounded titles for T3 projects (spec §4.5). `cleanText` and `truncateTitle` are shared with thread titles.

/** Folder names that say nothing about the project; the title then uses `parent/last`. Compared case-insensitively. */
export const GENERIC_SEGMENTS: readonly string[] = [
  "src", "source", "app", "apps", "frontend", "backend", "front", "back", "api", "web", "client", "server",
  "main", "master", "project", "projects", "code", "repo", "lib", "packages", "www", "public", "dist", "build",
  "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12",
];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string): string[] => [...segmenter.segment(s)].map((g) => g.segment);

/** NFC, no control or invisible characters (a joiner survives only inside an emoji sequence), single spaces, trimmed. */
export function cleanText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\t\n\r\v\f]/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, (c, i: number, all: string) => (c === "\u200D" && /\p{Extended_Pictographic}\uFE0F?$/u.test(all.slice(0, i)) ? c : ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Untrusted text (a title, path, error or note from a transcript or T3 Code) made safe for one terminal line: no
 * control or format characters, so no escape sequence reaches the terminal (cleanText), cut in the middle to `max`
 * graphemes when given.
 */
export function shownText(s: unknown, max?: number): string {
  const t = cleanText(typeof s === "string" ? s : String(s));
  return max === undefined ? t : truncateTitle(t, max);
}

/**
 * An account's display name (config.json's or T3 Code's) as t3sm shows it anywhere, --json included: safe for one line
 * (shownText) and with any email address in it masked, since people often name an account after its email.
 */
export function shownAccountName(name: string, max = 60): string {
  // Clean first (an invisible character inside an address must not hide it from the mask), then mask, then cut.
  return truncateTitle(maskAddressesIn(cleanText(name)), max);
}

/** At most `max` graphemes, cut in the middle with "…" so the start and the end stay visible. */
export function truncateTitle(s: string, max: number): string {
  const g = graphemes(s);
  if (g.length <= max) return s;
  if (max <= 1) return "…";
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return g.slice(0, head).join("") + "…" + g.slice(g.length - (keep - head)).join("");
}

function segmentsOf(root: string, platform: NodeJS.Platform): string[] {
  const parts = root.split(platform === "win32" ? /[\\/]/ : "/").filter((x) => x !== "");
  return parts.filter((x, i) => !(i === 0 && /^[A-Za-z]:$/.test(x)));
}

export function projectTitle(
  root: string,
  taken: ReadonlySet<string>,
  o: { maxLength: number; platform: NodeJS.Platform },
): string {
  const segs = segmentsOf(root, o.platform).map(cleanText).filter((x) => x !== "");
  const last = segs[segs.length - 1] ?? cleanText(root);
  const parent = segs[segs.length - 2];
  const grand = segs[segs.length - 3];
  const great = segs[segs.length - 4];
  const generic = GENERIC_SEGMENTS.includes(last.toLowerCase());
  const base = truncateTitle(generic && parent ? `${parent}/${last}` : last, o.maxLength);
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  const free = (t: string): boolean => !used.has(t.toLowerCase());
  // The label is never cut; the base gives up room for it so the whole title stays within the limit.
  const withLabel = (label: string): string => {
    const suffix = ` · ${label}`;
    const room = Math.max(8, o.maxLength - graphemes(suffix).length);
    return truncateTitle(generic && parent ? `${parent}/${last}` : last, room) + suffix;
  };
  if (free(base)) return base;
  // A `parent/last` base already shows the parent, so its labels start one level higher.
  const labels = generic && parent
    ? [grand, grand && great ? `${great}/${grand}` : undefined]
    : [parent, parent && grand ? `${grand}/${parent}` : undefined];
  for (const label of labels) {
    if (label === undefined) continue;
    const t = withLabel(label);
    if (free(t)) return t;
  }
  for (let n = 2; ; n++) {
    const t = `${truncateTitle(base, Math.max(8, o.maxLength - String(n).length - 3))} (${n})`;
    if (free(t)) return t;
  }
}
