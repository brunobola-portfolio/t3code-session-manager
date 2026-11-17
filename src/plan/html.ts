// plan.html (`t3sm plan --html`): the plan as one self-contained page to open in a browser. Inline CSS and JS only, a
// Content-Security-Policy that forbids loading anything, light and dark by `prefers-color-scheme`. English, like
// plan.md. Every value that comes from sessions (titles, paths, project and account names) is untrusted: on the page it
// is HTML-escaped, in the embedded data it is JSON with `<`, `>`, `&` and the line separators escaped (no `</script>`
// breakout), and the script only ever puts it into the page as text (textContent, never innerHTML). Paths show home as
// `~`, emails are masked.

import type { HarnessId, Plan, SkipReason } from "../core/types.ts";
import { tildePath } from "../core/paths.ts";
import { maskEmailsIn } from "../core/mask.ts";
import { folderName } from "../i18n/words.ts";
import { shownAccountName, shownText } from "./names.ts";
import { SKIP_EXPLANATION, planWarnings, summarize } from "./report.ts";

export interface HtmlOptions {
  /** accountId / instanceId -> display name (masked here). */
  names?: Record<string, string>;
  /** The home folder, shown as `~`. */
  home: string;
  platform: NodeJS.Platform;
}

const HTML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text made safe for HTML content and attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESC[c]!);
}

/**
 * JSON safe inside a `<script>` element: `<`, `>` and `&` as \u escapes (so neither `</script>` nor `<!--` can end or
 * change the element) and U+2028 / U+2029 escaped too. JSON.parse reads it back unchanged.
 */
export function safeJsonForScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const HARNESS_NAME: Record<HarnessId, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" };
const ACTION_LABEL: Record<string, string> = { import: "Import", "convert-import": "Convert, then import", skip: "Skip" };

/** One session in the page's data: short keys keep a plan of thousands of sessions small. */
interface Row {
  /** Index into `projects`. */ p: number;
  /** Index into `accounts`. */ a: number;
  h: HarnessId; k: string; r: SkipReason | ""; c: string; id: string; u: string; m: number;
}

/** A warning from plan.md (markdown, escaped for markdown) as plain text. */
function plainWarning(w: string): string {
  return w.replace(/\\(.)/g, "$1").replace(/`/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function renderPlanHtml(plan: Plan, o: HtmlOptions): string {
  const names: Record<string, string> = { ...Object.fromEntries(plan.instancesToCreate.map((i) => [i.id, i.displayName])), ...o.names };
  const path = (p: string): string => shownText(maskEmailsIn(tildePath(p, o.home, o.platform)), 300);
  const titleOf = new Map(plan.projectsToCreate.map((p) => [p.root, p.title]));

  // Projects and accounts once each, rows point at them by index.
  const projects: string[] = [];
  const projectIdx = new Map<string, number>();
  const projectOf = (root: string | null): number => {
    const key = root ?? "";
    const known = projectIdx.get(key);
    if (known !== undefined) return known;
    const title = root === null ? "(no folder)" : shownText(titleOf.get(root) ?? folderName(root), 120);
    // Two folders with the same name are told apart by their path.
    const label = projects.includes(title) && root !== null ? `${title} (${path(root)})` : title;
    projects.push(label);
    projectIdx.set(key, projects.length - 1);
    return projects.length - 1;
  };
  const accounts: string[] = [];
  const accountIdx = new Map<string, number>();
  const accountOf = (id: string | null): number => {
    const key = id ?? "";
    const known = accountIdx.get(key);
    if (known !== undefined) return known;
    const n = id === null ? undefined : names[id];
    accounts.push(id === null ? "(no account)" : n !== undefined && n.trim() !== "" ? shownAccountName(n, 80) : shownAccountName(id, 80));
    accountIdx.set(key, accounts.length - 1);
    return accounts.length - 1;
  };

  const rows: Row[] = plan.items.map((it) => {
    const a = it.action;
    const root = a.kind === "skip" ? it.session.cwd : a.projectRoot;
    return {
      p: projectOf(root), a: accountOf(a.kind === "skip" ? it.session.accountId : a.instanceId),
      h: it.session.harness, k: a.kind, r: a.kind === "skip" ? a.reason : "",
      c: it.session.cwd === null ? "" : path(it.session.cwd), id: shownText(it.session.nativeId, 80),
      u: typeof it.session.updatedAt === "string" ? it.session.updatedAt : "", m: Number(it.session.messageCount) || 0,
    };
  });
  // Grouped by project, newest first inside each.
  rows.sort((x, y) => (projects[x.p]! < projects[y.p]! ? -1 : projects[x.p]! > projects[y.p]! ? 1 : x.u < y.u ? 1 : x.u > y.u ? -1 : 0));

  const data = { rows, projects, accounts, harness: HARNESS_NAME, actions: ACTION_LABEL, reasons: SKIP_EXPLANATION };
  const sum = summarize(plan);
  const warnings = planWarnings(plan, sum).map(plainWarning);
  const e = escapeHtml;
  const stat = (label: string, n: number): string => `<div class="stat"><span class="n">${n}</span><span class="l">${e(label)}</span></div>`;
  const created = plan.projectsToCreate.length === 0 ? "" : `<details><summary>Projects to create (${plan.projectsToCreate.length})</summary><ul>${
    plan.projectsToCreate.map((p) => `<li><b>${e(shownText(p.title, 120))}</b> <code>${e(path(p.root))}</code></li>`).join("")}</ul></details>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>t3sm plan ${e(shownText(plan.runId, 40))}</title>
<style>
:root{--bg:#fff;--fg:#1d1f23;--muted:#61666f;--line:#e2e4e8;--card:#f6f7f9;--accent:#1f7a4d;--skip:#9a6700;--conv:#3b5bdb}
@media (prefers-color-scheme: dark){:root{--bg:#15171a;--fg:#e6e8eb;--muted:#9aa0a8;--line:#2c3036;--card:#1d2024;--accent:#4cc38a;--skip:#e3b341;--conv:#91a7ff}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
p.sub{color:var(--muted);margin:0 0 16px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:110px}
.stat .n{display:block;font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.stat .l{color:var(--muted);font-size:12px}
details{margin:0 0 12px}
summary{cursor:pointer;font-weight:600}
ul{margin:8px 0;padding-left:20px}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);z-index:1}
select,input,button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:5px 8px;max-width:100%}
input[type=search]{flex:1 1 220px}
button{cursor:pointer}
#count{color:var(--muted);margin:8px 0;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.path,td.id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
td.k-import{color:var(--accent)} td.k-convert-import{color:var(--conv)} td.k-skip{color:var(--skip)}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
#more{margin:12px 0}
</style>
</head>
<body>
<main>
<h1>t3sm plan ${e(shownText(plan.runId, 40))}</h1>
<p class="sub">Generated ${e(shownText(plan.createdAt, 40))} for T3 Code ${e(shownText(plan.t3Version, 40))}. Nothing has been written yet: review this, then run <code>t3sm apply</code>. This page is a local file; it loads nothing and sends nothing.</p>
<div class="stats">${stat("to import", sum.byAction["import"] ?? 0)}${stat("to convert, then import", sum.byAction["convert-import"] ?? 0)}${stat("skipped", sum.byAction["skip"] ?? 0)}${stat("instances to create", plan.instancesToCreate.length)}${stat("projects to create", plan.projectsToCreate.length)}${stat("mirror copies", plan.mirrorCopies.length)}</div>
${warnings.length === 0 ? "" : `<details><summary>Warnings (${warnings.length})</summary><ul>${warnings.map((w) => `<li>${e(w)}</li>`).join("")}</ul></details>`}
${created}
<div class="filters">
<select id="f-project" aria-label="Project"></select>
<select id="f-account" aria-label="Account"></select>
<select id="f-action" aria-label="Action"></select>
<select id="f-reason" aria-label="Skip reason"></select>
<input id="f-search" type="search" placeholder="Search project, folder, session id" aria-label="Search">
<button id="f-clear" type="button">Clear</button>
</div>
<div id="count" aria-live="polite"></div>
<div class="wrap"><table>
<thead><tr><th>Project</th><th>Agent</th><th>Account</th><th>Action</th><th>Reason</th><th>Last activity</th><th>Messages</th><th>Folder</th><th>Session id</th></tr></thead>
<tbody id="rows"></tbody>
</table></div>
<button id="more" type="button" hidden>Show more</button>
</main>
<script type="application/json" id="plan-data">${safeJsonForScript(data)}</script>
<script>
(function () {
  "use strict";
  var D = JSON.parse(document.getElementById("plan-data").textContent);
  var rows = D.rows, PAGE = 500, shown = PAGE, match = [];
  var $ = function (id) { return document.getElementById(id); };
  var fp = $("f-project"), fa = $("f-account"), fk = $("f-action"), fr = $("f-reason"), fs = $("f-search");
  var hay = rows.map(function (r) { return (D.projects[r.p] + " " + D.accounts[r.a] + " " + r.c + " " + r.id).toLowerCase(); });
  function opt(sel, value, label) { var o = document.createElement("option"); o.value = value; o.textContent = label; sel.appendChild(o); }
  function fill(sel, all, values, label) {
    var n = {}; values.forEach(function (v) { n[v] = (n[v] || 0) + 1; });
    opt(sel, "", all + " (" + rows.length + ")");
    Object.keys(n).sort(function (x, y) { return label(x).localeCompare(label(y)); }).forEach(function (v) { opt(sel, v, label(v) + " (" + n[v] + ")"); });
  }
  fill(fp, "All projects", rows.map(function (r) { return String(r.p); }), function (v) { return D.projects[v]; });
  fill(fa, "All accounts", rows.map(function (r) { return String(r.a); }), function (v) { return D.accounts[v]; });
  fill(fk, "All actions", rows.map(function (r) { return r.k; }), function (v) { return D.actions[v] || v; });
  fill(fr, "All skip reasons", rows.filter(function (r) { return r.r; }).map(function (r) { return r.r; }), function (v) { return v; });
  function cell(tr, text, cls, title) { var td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; if (title) td.title = title; tr.appendChild(td); }
  function draw() {
    var body = $("rows"), frag = document.createDocumentFragment(), end = Math.min(shown, match.length);
    for (var i = 0; i < end; i++) {
      var r = rows[match[i]], tr = document.createElement("tr");
      cell(tr, D.projects[r.p]); cell(tr, D.harness[r.h] || r.h); cell(tr, D.accounts[r.a]);
      cell(tr, D.actions[r.k] || r.k, "k-" + r.k); cell(tr, r.r, "", r.r ? D.reasons[r.r] : "");
      cell(tr, r.u ? r.u.slice(0, 16).replace("T", " ") : ""); cell(tr, String(r.m), "num"); cell(tr, r.c, "path"); cell(tr, r.id, "id");
      frag.appendChild(tr);
    }
    body.textContent = ""; body.appendChild(frag);
    $("more").hidden = end >= match.length;
    $("more").textContent = "Show more (" + (match.length - end) + " left)";
  }
  function apply() {
    var p = fp.value, a = fa.value, k = fk.value, why = fr.value, q = fs.value.trim().toLowerCase(), c = { "import": 0, "convert-import": 0, skip: 0 };
    match = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if ((p && String(r.p) !== p) || (a && String(r.a) !== a) || (k && r.k !== k) || (why && r.r !== why) || (q && hay[i].indexOf(q) < 0)) continue;
      match.push(i); c[r.k] = (c[r.k] || 0) + 1;
    }
    shown = PAGE;
    $("count").textContent = "Showing " + match.length + " of " + rows.length + " sessions: " + c["import"] + " to import, " + c["convert-import"] + " to convert, " + c.skip + " skipped.";
    draw();
  }
  var timer = 0;
  fs.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(apply, 120); });
  [fp, fa, fk, fr].forEach(function (s) { s.addEventListener("change", apply); });
  $("f-clear").addEventListener("click", function () { fp.value = fa.value = fk.value = fr.value = fs.value = ""; apply(); });
  $("more").addEventListener("click", function () { shown += PAGE; draw(); });
  apply();
})();
</script>
</body>
</html>
`;
}
