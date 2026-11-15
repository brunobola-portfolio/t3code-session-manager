// t3sm start (and bare `t3sm` on a terminal): the guided assistant. Not on a terminal: prints the quick start, exit 0.

import { homedir } from "node:os";
import { stateDir } from "../../core/paths.ts";
import { loadConfig } from "../../core/config.ts";
import type { AssistantDeps } from "../../assistant/core.ts";
import { realAssistantDeps } from "../../assistant/deps.ts";
import { CATALOGUES, resolveLang, wrap, type Lang } from "../../assistant/i18n.ts";
import { parseGlobalFlags, unknownOption } from "../ui.ts";
import { runAssistant } from "../../assistant/runner.ts";
import { realIsElevated, warnIfElevated } from "../../ops/elevated.ts";
import type { Io } from "../main.ts";

export interface StartDeps {
  /** `t3sm <argv>` (main), for the commands the assistant runs. */
  main: (argv: string[], io: Io) => Promise<number>;
  home?: string;
  /** Replaces the real dependencies (tests). */
  assistant?: AssistantDeps;
  /** Whether this shell runs as Administrator (default: `net session` on Windows, only with the real dependencies). */
  elevated?: () => Promise<boolean>;
}

export async function startCommand(args: string[], io: Io, deps: StartDeps): Promise<number> {
  // main has already taken --lang / --no-color out of argv (Io.langFlag, Io.caps); a direct call passes them here, read
  // by the same parser.
  const g = parseGlobalFlags(args);
  if ("error" in g) { io.stderr(g.error); return 2; }
  if (g.rest.length > 0) { unknownOption(io, g.rest[0]!, "start"); return 2; }
  const flagLang: Lang | null = g.lang ?? io.langFlag ?? null;
  const home = deps.home ?? homedir();
  // An invalid config.json is doctor's to report (step 2): the language falls back to the environment's meanwhile.
  const configLang = await loadConfig(stateDir(io.env, home), home).then((c) => c?.language ?? null, () => null);
  const lang = resolveLang(flagLang, io.env, configLang);
  if (!io.isTTY) {
    io.stdout(wrap(CATALOGUES[lang].quickStart).join("\n") + "\n");
    return 0;
  }
  await warnIfElevated({ stderr: (s) => io.stderr(s), lang }, deps.elevated ?? (deps.assistant === undefined && deps.home === undefined ? realIsElevated : async () => false), "start");
  const noColor = g.noColor || io.caps?.color === 0 || Boolean(io.env["NO_COLOR"]);
  // The commands the assistant runs print in its language.
  const child: Io = { ...io, lang };
  const d = deps.assistant ?? realAssistantDeps(child, { main: deps.main, home, noColor });
  return runAssistant(d, { lang, color: !noColor, langFromFlag: flagLang !== null, defaultLang: resolveLang(null, io.env, null), ...(io.caps ? { caps: io.caps } : {}) });
}
