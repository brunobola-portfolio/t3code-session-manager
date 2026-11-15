// The screen registry. Every screen task (T19 onwards) imports `SCREENS` and pushes its screens; screens.test.ts runs
// each one through the matrix: widths 40/80/120 x colour 0/1 x Unicode on/off x language en/pt.
//
// `render(caps, lang)` returns the screen's lines for `caps.columns` wide. The matrix asserts, per line:
//   - displayWidth <= caps.columns;
//   - no ESC when caps.color is 0;
//   - Unicode off: nothing outside ASCII. Fixtures use ASCII content so the rule can stay strict for "en"; for "pt"
//     the accented Latin-1 letters (U+00C0-U+00FF without the multiplication and division signs) that Portuguese text needs are the only allowed exception: box
//     drawing, symbols and arrows still must be ASCII.

import type { Lang } from "../../src/assistant/i18n.ts";
import type { Caps } from "../../src/ui/caps.ts";
import { makeStyle } from "../../src/ui/style.ts";
import { appHeader, callout, kv, panel, stepHeader, table } from "../../src/ui/components.ts";
import { COMMAND_SCREENS } from "./screens.commands.ts";
import { ASSISTANT_SCREENS } from "./screens.assistant.ts";
import { MORE_SCREENS } from "./screens.more.ts";

/** A screen's lines; the guided assistant's screens are the transcript of a scripted run, so they may be async. */
export interface Screen { name: string; render(caps: Caps, lang: Lang): string[] | Promise<string[]> }

export const SCREENS: Screen[] = [];

interface DemoRow { project: string; path: string; sessions: number; note: string }
const DEMO_ROWS: DemoRow[] = [
  { project: "app", path: "C:/work/demo/packages/app/src/index.ts", sessions: 1234, note: "ready" },
  { project: "api", path: "~/code/api/services/orders/create.ts", sessions: 56, note: "waiting" },
];

SCREENS.push({
  name: "components-demo",
  render(caps, lang) {
    const s = makeStyle(caps);
    const w = caps.columns;
    const pt = lang === "pt";
    return [
      ...appHeader(s, { version: "0.3.0", subtitle: pt ? "Traga as suas sessoes para o T3 Code" : "Bring your sessions into T3 Code" }, w),
      "",
      ...stepHeader(s, { n: 3, total: 11, title: pt ? "Contas" : "Accounts", done: [1, 2], word: pt ? { step: "Passo", of: "de" } : { step: "Step", of: "of" } }, w),
      "",
      ...panel(s, { title: pt ? "Isto e o que vou fazer" : "Here is what I will do", body: [pt ? "Importar 5 conversas para 4 projetos." : "Import 5 conversations into 4 projects."] }, w),
      "",
      ...kv(s, [[pt ? "Contas" : "Accounts", "2"], [pt ? "Caminho" : "Path", "C:/work/demo/packages/app/src/index.ts"]], w),
      "",
      ...table(s, [
        { header: pt ? "Projeto" : "Project", get: (r) => (r as DemoRow).project, priority: 10 },
        { header: pt ? "Caminho" : "Path", get: (r) => (r as DemoRow).path, truncate: "middle", priority: 5 },
        { header: pt ? "Sessoes" : "Sessions", get: (r) => String((r as DemoRow).sessions), align: "right", priority: 8 },
        { header: pt ? "Nota" : "Note", get: (r) => (r as DemoRow).note, priority: 1 },
      ], DEMO_ROWS, w),
      "",
      ...callout(s, { kind: "needs-you", title: pt ? "Precisa de si" : "Needs you", body: [pt ? "3 conversas por decidir." : "3 conversations to decide."], command: "t3sm start --resume" }, w),
    ];
  },
});

// Accented Portuguese content: the matrix must still hold (widths with accents, only Latin-1 letters allowed when
// Unicode is off). English renders ASCII so the strict rule applies to it.
SCREENS.push({
  name: "accents-pt",
  render(caps, lang) {
    const s = makeStyle(caps);
    const w = caps.columns;
    const pt = lang === "pt";
    const rows = [pt ? ["Sessões", "Início da migração", "ação"] : ["Sessions", "Start of migration", "action"]];
    return [
      ...panel(s, { title: pt ? "Atenção" : "Attention", tone: "warn", body: [pt ? "Conversações já continuadas num terminal: decida o destino." : "Conversations already continued in a terminal: decide."] }, w),
      ...kv(s, [[pt ? "Última execução" : "Last run", pt ? "15/11 às 10:20" : "15/11 at 10:20"]], w),
      ...table(s, [
        { header: pt ? "Sessões" : "Sessions", get: (r) => (r as string[])[0]!, priority: 5 },
        { header: pt ? "Descrição" : "Description", get: (r) => (r as string[])[1]!, priority: 3 },
        { header: pt ? "Ação" : "Action", get: (r) => (r as string[])[2]!, priority: 1 },
      ], rows, w),
      ...callout(s, { kind: "info", title: pt ? "Útil saber" : "Worth knowing", body: [pt ? "Não encontrámos nenhuma instância do Pi." : "No Pi instance was found."] }, w),
    ];
  },
});

// The command screens (Task 21): status, doctor, plan, apply, sync, organize and the error panel.
SCREENS.push(...COMMAND_SCREENS);

// The guided assistant (Task 20): every step and state, as the transcript of a scripted run.
SCREENS.push(...ASSISTANT_SCREENS);

// The remaining command screens and help (Task 22).
SCREENS.push(...MORE_SCREENS);
