// What a Claude Code user record shows: Claude Code writes its own UI as user turns (slash commands, `!` shell runs and
// their output, task notifications). The same rules T3 Code's importer applies (AgentSessionScanner, 2026-11-18 and
// 2026-11-19 upstream), so t3sm plans what T3 Code will import.

/** Claude Code's model name for its own local errors, such as "Invalid API key". */
export const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

const UI_OUTPUT = /^(?:<(?:task-notification|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>|\[Request interrupted by user(?: for tool use)?\]$)/;

export interface ClaudeUserText {
  /** What a person sees in the thread ("": nothing). */
  shown: string;
  /** The part that may name the thread ("": a bare command, a shell run). */
  request: string;
}

export function claudeUserText(text: string): ClaudeUserText {
  if (UI_OUTPUT.test(text)) return { shown: "", request: "" };
  const shell = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(text)?.[1];
  if (shell !== undefined) return { shown: `!${shell}`, request: "" };
  if (/^<command-(?:name|message)>/.test(text)) {
    const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim()
      || `/${/<command-message>([^<]*)<\/command-message>/.exec(text)?.[1]?.trim() ?? ""}`;
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
    return { shown: args === "" ? name : `${name} ${args}`, request: args };
  }
  return { shown: text, request: text };
}
