// t3sm start (and bare `t3sm` on a terminal): the guided assistant. Not on a terminal: prints the quick start, exit 0.

import { homedir } from "node:os";
import { stateDir } from "../../core/paths.ts";
import { loadConfig } from "../../core/config.ts";
import type { AssistantDeps } from "../../assistant/core.ts";
import { realAssistantDeps } from "../../assistant/deps.ts";
import { CATALOGUES, isLang, resolveLang, wrap, type Lang } from "../../assistant/i18n.ts";
import { runAssistant } from "../../assistant/runner.ts";
import type { Io } from "../main.ts";

export interface StartDeps {
  /** `t3sm <argv>` (main), for the commands the assistant runs. */
  main: (argv: string[], io: Io) => Promise<number>;
  home?: string;
  /** Replaces the real dependencies (tests). */
  assistant?: AssistantDeps;
}

export async function startCommand(args: string[], io: Io, deps: StartDeps): Promise<number> {
  let flagLang: Lang | null = null;
  let noColor = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-color") noColor = true;
    else if (a === "--lang" || a.startsWith("--lang=")) {
      const v = a === "--lang" ? args[++i] : a.slice("--lang=".length);
      if (!isLang(v)) { io.stderr("--lang must be en or pt. Run `t3sm start --help`.\n"); return 2; }
      flagLang = v;
    } else { io.stderr(`Unknown option: ${a}. Run \`t3sm start --help\`.\n`); return 2; }
  }
  const home = deps.home ?? homedir();
  // An invalid config.json is doctor's to report (step 2): the language falls back to English meanwhile.
  const configLang = await loadConfig(stateDir(io.env, home), home).then((c) => c?.language ?? null, () => null);
  const lang = resolveLang(flagLang, io.env, configLang);
  if (!io.isTTY) {
    io.stdout(wrap(CATALOGUES[lang].quickStart).join("\n") + "\n");
    return 0;
  }
  noColor ||= Boolean(io.env["NO_COLOR"]);
  const d = deps.assistant ?? realAssistantDeps(io, { main: deps.main, home, noColor });
  return runAssistant(d, { lang, color: !noColor, langFromFlag: flagLang !== null });
}
