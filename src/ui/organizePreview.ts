// The organize preview as one before/after table per project (replaces the two side-by-side columns of
// sidebarPreview.ts, which misaligned): the project, the conversations it shows inside it now and after the plan, and
// how many the plan settles, retitles and archives there. Pure: lines in, no writes. Project titles come from T3 Code:
// untrusted, through shownText. The words come from the caller (the CLI and the assistant have their own catalogues).

import type { OrganizePlan } from "../organize/types.ts";
import { shownText } from "../plan/names.ts";
import { table, type Column } from "./components.ts";
import type { Fmt } from "./locale.ts";
import type { Style } from "./style.ts";
import { truncateEnd, wrapText } from "./text.ts";

/** Narrower than this the table becomes a list (five columns would drop the archived count). */
const LIST_BELOW = 60;

export interface OrganizePreviewWords {
  /** Column headers. `visible` may hold "{to}", replaced by the arrow ("→", or "->" without Unicode). */
  project: string; visible: string; settled: string; retitled: string; archived: string;
  /** The line under the table when projects were left out: "and 3 more projects". */
  more(n: number): string;
}

export interface OrganizePreviewOptions {
  /** Projects shown (default 10): the ones the plan changes first, in the plan's order. */
  max?: number;
}

interface Row { title: string; before: number; after: number; settled: number; retitled: number; archived: number }

/** The plan, per project: shown now -> after, settled, retitled, archived. */
export function organizePreviewTable(s: Style, f: Fmt, plan: OrganizePlan, words: OrganizePreviewWords, width: number, o: OrganizePreviewOptions = {}): string[] {
  const max = Math.max(1, o.max ?? 10);
  const to = s.caps.unicode ? "→" : "->";
  const count = (kind: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const a of plan.actions) if (a.kind === kind && a.projectId !== null) m.set(a.projectId, (m.get(a.projectId) ?? 0) + 1);
    return m;
  };
  const settled = count("settle");
  const retitled = count("title");
  const archived = count("archive");
  const all: Row[] = plan.byProject.map((p) => ({
    title: shownText(p.title, 80), before: p.visibleBefore, after: p.visibleAfter,
    settled: settled.get(p.projectId) ?? 0, retitled: retitled.get(p.projectId) ?? 0, archived: archived.get(p.projectId) ?? 0,
  }));
  if (all.length === 0) return [];
  const changed = (r: Row): boolean => r.before !== r.after || r.settled + r.retitled + r.archived > 0;
  const rows = [...all.filter(changed), ...all.filter((r) => !changed(r))].slice(0, max);
  const n = (x: number): string => (x === 0 ? "-" : f.n(x));
  const cols: Column[] = [
    { header: words.project, get: (r) => (r as Row).title, priority: 9, min: 10 },
    { header: words.visible.replace("{to}", to), get: (r) => `${f.n((r as Row).before)} ${to} ${f.n((r as Row).after)}`, align: "right", priority: 8 },
    { header: words.settled, get: (r) => n((r as Row).settled), align: "right", priority: 6 },
    { header: words.retitled, get: (r) => n((r as Row).retitled), align: "right", priority: 4 },
    { header: words.archived, get: (r) => n((r as Row).archived), align: "right", priority: 5 },
  ];
  // Narrow: a list, so no count (the archived one above all) is ever dropped or cut. A header names what the numbers
  // are; each project's title is cut if it must be, never its counts, which go on their own line(s).
  const w = Math.max(1, width);
  const list = (): string[] => [
    ...wrapText(`${words.project}: ${words.visible.replace("{to}", to)}`, w).map((l) => s("muted", l)),
    ...rows.flatMap((r) => [
      s("title", truncateEnd(r.title, w, s.sym.ellipsis)),
      ...wrapText([`${f.n(r.before)} ${to} ${f.n(r.after)}`, ...[[words.settled, r.settled], [words.retitled, r.retitled], [words.archived, r.archived]]
        .filter(([, x]) => (x as number) > 0).map(([label, x]) => `${label} ${f.n(x as number)}`)].join(", "), Math.max(1, w - 2), { hang: 0 })
        .filter((l) => l !== "").map((l) => (w >= 4 ? `  ${l}` : l)),
    ]),
  ];
  const out = width >= LIST_BELOW ? table(s, cols, rows, width) : list();
  if (all.length > rows.length) out.push(s("muted", truncateEnd(`${s.sym.ellipsis} ${words.more(all.length - rows.length)}`, Math.max(1, width), s.sym.ellipsis)));
  return out;
}
