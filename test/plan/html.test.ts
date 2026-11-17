// plan.html (`t3sm plan --html`): one self-contained file, every value from sessions escaped, the filter data embedded
// as JSON that can never close its script element, home shown as ~, emails masked, nothing loaded from the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Plan, PlanItem } from "../../src/core/types.ts";
import { renderPlanHtml, safeJsonForScript } from "../../src/plan/html.ts";
import { HOME, sess, uuid } from "./helpers.ts";

const EVIL_TITLE = `<script>alert("x")</script> & 'quoted' "title"`;
const EVIL_CWD = `${HOME}/work/</script><img src=x onerror=alert(1)>`;

function evilPlan(): Plan {
  const items: PlanItem[] = [
    {
      session: sess({ nativeId: uuid(1), cwd: `${HOME}/work/demo` }),
      action: { kind: "import", projectRoot: `${HOME}/work/demo`, instanceId: "claudeAgent", expectedThreadId: "x" },
      notes: [],
    },
    {
      session: sess({ nativeId: uuid(2), cwd: EVIL_CWD }),
      action: { kind: "skip", reason: "cwd-missing" },
      notes: [],
    },
    {
      session: sess({ nativeId: uuid(3), cwd: "C:/work/demo@example.com/app", accountId: "claude-org" }),
      action: { kind: "skip", reason: "active" },
      notes: [],
    },
  ];
  return {
    version: 1, runId: "20261117-120000-abcd", createdAt: "2026-11-17T12:00:00.000Z", t3Version: "0.0.30",
    instancesToCreate: [], projectsToCreate: [{ root: `${HOME}/work/demo`, title: EVIL_TITLE, defaultInstanceId: "claudeAgent" }],
    projectAccounts: [], projectDefaults: [], mirrorCopies: [], items, warnings: ["a <b>warning</b> with `code`"],
  };
}

const render = (): string => renderPlanHtml(evilPlan(), { names: { claudeAgent: "owner@example.com", "claude-org": "Org" }, home: HOME, platform: "win32" });

function dataOf(html: string): { rows: { p: number; a: number; c: string; k: string; r: string }[]; projects: string[]; accounts: string[] } {
  const m = /<script type="application\/json" id="plan-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "the data script is there");
  return JSON.parse(m[1]!);
}

test("plan.html escapes every value: a title with <script> and quotes never becomes markup", () => {
  const html = render();
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;quoted&#39; &quot;title&quot;/, "the title escaped in the page");
  assert.match(html, /a &lt;b&gt;warning&lt;\/b&gt; with code/, "a warning shown as text");
  // Only t3sm's own two script elements open and close.
  assert.equal(html.match(/<script/gi)!.length, 2);
  assert.equal(html.match(/<\/script/gi)!.length, 2);
});

test("plan.html: the filter data is JSON that cannot break out of its script element, and reads back whole", () => {
  const html = render();
  const d = dataOf(html);
  assert.ok(d.projects.includes(EVIL_TITLE), "the title survives the round trip as text");
  assert.ok(d.rows.some((r) => r.c === "~/work/</script><img src=x onerror=alert(1)>"), "the path survives, home as ~");
  assert.equal(safeJsonForScript({ x: "</script><!-- \u2028\u2029 &" }), '{"x":"\\u003c/script\\u003e\\u003c!-- \\u2028\\u2029 \\u0026"}');
  assert.deepEqual(JSON.parse(safeJsonForScript({ x: "</script>" })), { x: "</script>" });
});

test("plan.html: home as ~, emails masked, one row per session with its action, reason, project and account", () => {
  const html = render();
  const d = dataOf(html);
  assert.equal(d.rows.length, 3);
  assert.doesNotMatch(html, /owner@example\.com|demo@example\.com/);
  assert.ok(d.accounts.includes("o***@example.com"));
  assert.ok(d.rows.some((r) => r.c === "C:/work/d***@example.com/app"));
  assert.ok(!html.includes(HOME), "the home folder never appears");
  assert.deepEqual(d.rows.map((r) => r.k).sort(), ["import", "skip", "skip"]);
  assert.deepEqual(d.rows.map((r) => r.r).sort(), ["", "active", "cwd-missing"]);
});

test("plan.html is self-contained: no external URL, a policy that forbids loading anything, light and dark", () => {
  const html = render();
  // The page itself (the data script holds the sessions' own text, escaped, which may say anything).
  const page = html.replace(/<script type="application\/json" id="plan-data">[\s\S]*?<\/script>/, "");
  assert.doesNotMatch(page, /https?:\/\//);
  assert.doesNotMatch(page, /\ssrc=|\shref=|@import|url\(/);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">/);
  assert.match(html, /prefers-color-scheme: dark/);
  for (const id of ["f-project", "f-account", "f-action", "f-reason", "f-search"]) assert.match(html, new RegExp(`id="${id}"`));
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  assert.doesNotThrow(() => new Function(script), "the page's script parses");
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/, "session text reaches the page as text only");
});

test("plan.html stays small and quick to build for thousands of sessions", () => {
  const plan = evilPlan();
  const base = plan.items[0]!;
  plan.items = Array.from({ length: 5000 }, (_, i) => ({ ...base, session: { ...base.session, nativeId: uuid(10_000 + i) } }));
  const t0 = performance.now();
  const html = renderPlanHtml(plan, { names: {}, home: HOME, platform: "win32" });
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(dataOf(html).rows.length, 5000);
  assert.ok(html.length < 5000 * 400, `${html.length} bytes`);
});
