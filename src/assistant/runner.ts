// The guided assistant's state machine: steps run in order; b goes back to the previous step shown, q ends cleanly,
// a failing step ends with its command's exit code. Resuming is derived from real state, never from a state file.

import { describeError } from "../cli/errors.ts";
import { Back, Quit, Stop, newCtx, say, t, type AssistantDeps } from "./core.ts";
import type { Caps } from "../ui/caps.ts";
import type { Lang } from "./i18n.ts";
import { STEPS, resumePoint, summary, type Step } from "./steps.ts";

export interface AssistantOptions {
  lang: Lang; color: boolean; langFromFlag: boolean;
  /** The language without --lang and without config.json "language" (default English); the save offer compares with it. */
  defaultLang?: Lang;
  steps?: Step[];
  /** The terminal's capabilities (default: the term's own). */
  caps?: Caps;
  /** The clock for relative dates (tests). */
  now?: () => number;
}

/** Exit code: 0 finished or quit (5 when the import finished with failures); a failing step's own code otherwise. */
export async function runAssistant(d: AssistantDeps, o: AssistantOptions): Promise<number> {
  const ctx = newCtx(d, o);
  const steps = o.steps ?? STEPS;
  try {
    const holder = await d.lockHolder();
    if (holder) { say(ctx, t(ctx, "lockHeld", { pid: holder.pid })); return 0; }
    const [cfg, runs, scheduled] = await Promise.all([d.config(), d.runs(), d.scheduleInstalled().catch(() => false)]);
    ctx.resume = resumePoint({ configExists: cfg.exists, hasPlan: cfg.hasPlan, runs, scheduleInstalled: scheduled, decisionsPending: cfg.decisionsPending });

    const history: number[] = [];
    for (let i = 0; i < steps.length;) {
      let r;
      try {
        r = await steps[i]!(ctx);
      } catch (e) {
        if (!(e instanceof Back)) throw e;
        if (history.length === 0) { say(ctx, t(ctx, "noBack")); continue; }
        if (ctx.done.length > 0) say(ctx, t(ctx, "backNote"));
        i = history.pop()!;
        continue;
      }
      if (r.to === "skip") { i++; continue; }
      // A step that only sent the user to the decisions (the gate) is not a step to go back to: Back from the first
      // question would land on it and the gate would send the user straight back to the decisions.
      if (!(r.to === "goto" && r.gated)) history.push(i);
      i = r.to === "goto" ? r.step - 1 : i + 1;
    }
    return ctx.worst;
  } catch (e) {
    // Every exit after a write lists what was done, with run ids and how to undo each (once).
    const recap = (): void => { if (ctx.done.length > 0 && !ctx.summaryShown) summary(ctx); };
    // The recap's panel starts with its own blank line.
    if (e instanceof Quit) { if (ctx.done.length === 0 || ctx.summaryShown) d.print("\n"); recap(); say(ctx, t(ctx, "quit")); return 0; }
    if (e instanceof Stop) { recap(); return e.code; }
    const { code, message } = describeError(e);
    say(ctx, message);
    say(ctx, t(ctx, "errorStop"));
    recap();
    return code;
  } finally {
    d.term.dispose?.(); // one reader for the whole session: closed once, here (a review list never closes it)
  }
}
