import { ConfigError, NoPlanError } from "../core/config.ts";
import { RpcError, ShapeError, T3AuthError, T3HttpError, T3Incompatible, T3NotRunning } from "../t3/errors.ts";
import { InstanceHomeDrift } from "../ops/accounts.ts";
import { ApplyRefusal } from "../apply/apply.ts";
import { JournalWriteError } from "../ops/quarantine.ts";
import { shownText } from "../plan/names.ts";
import { lostContact, redactUnexpected } from "../ops/errorCodes.ts";
import { panel } from "../ui/components.ts";
import { wrapText } from "../ui/text.ts";
import { helpCommand } from "./helpTopics.ts";
import type { CliKey, CliUi } from "./ui.ts";

export { describeError, oneLine } from "../ops/errorCodes.ts";

/**
 * What a screen says about an error: a title in the user's language (what happened), the detail (the error's own text,
 * English, sanitised; none when the title says it all), what to do, and the `t3sm help` topic.
 */
export function errorParts(e: unknown, platform: NodeJS.Platform = process.platform): { title: CliKey; detail: string | null; todo: CliKey; help: string } {
  const help = helpCommand("errors");
  if (e instanceof T3NotRunning) return { title: "error.t3Down.title", detail: null, todo: platform === "win32" ? "error.t3DownWin.todo" : "error.t3Down.todo", help: "t3sm doctor" };
  if (e instanceof T3Incompatible || e instanceof ShapeError) return { title: "error.incompatible.title", detail: e.message, todo: "error.incompatible.todo", help };
  if (e instanceof JournalWriteError) return { title: "error.journal.title", detail: e.message, todo: "error.journal.todo", help };
  if (e instanceof NoPlanError) return { title: "error.noPlan.title", detail: null, todo: "error.noPlan.todo", help: "t3sm plan" };
  if (e instanceof ConfigError || e instanceof InstanceHomeDrift || e instanceof ApplyRefusal) return { title: "error.config.title", detail: e.message, todo: "error.config.todo", help };
  if (e instanceof T3AuthError) return { title: "error.auth.title", detail: `${e.message}${e.hint ? ` ${e.hint}` : ""}`, todo: "error.auth.todo", help };
  if (lostContact(e)) return { title: "error.t3Lost.title", detail: e.message, todo: "error.t3Lost.todo", help: "t3sm doctor" };
  if (e instanceof T3HttpError || e instanceof RpcError) return { title: "error.rejected.title", detail: e.message, todo: "error.rejected.todo", help };
  return { title: "error.unexpected.title", detail: redactUnexpected(e instanceof Error ? e.message : String(e)), todo: "error.unexpected.todo", help: "t3sm doctor" };
}

/** The error as a panel: what happened (title and detail), what to do, and the command that helps. Exit codes: describeError. */
export function renderError(e: unknown, ui: CliUi, platform: NodeJS.Platform = process.platform): string[] {
  const { s, t } = ui;
  const width = Math.max(1, ui.width);
  const p = errorParts(e, platform);
  const inner = Math.max(1, width - 4);
  const body: string[] = [];
  // The detail keeps its own lines (a config error lists one problem per line, then the hint), without Markdown
  // backticks; an indented line stays indented.
  if (p.detail !== null) {
    for (const raw of p.detail.split(/\r?\n/).slice(0, 40)) {
      const line = shownText(raw.replace(/`([^`\n]+)`/g, "$1"), 2000);
      if (!line.trim()) continue;
      const indent = /^\s*/.exec(raw)?.[0].length ? "  " : "";
      body.push(...wrapText(line.trim(), Math.max(1, inner - indent.length)).map((l) => indent + l));
    }
  }
  if (body.length > 0) body.push("");
  body.push(...wrapText(`${t("error.whatToDo")}: ${t(p.todo)}`, inner));
  body.push(`${s.sym.arrow} ${s("key", p.help)}`);
  return panel(s, { tone: "err", title: t(p.title), body }, width);
}
