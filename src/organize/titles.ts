// Readable titles for imported threads (spec §5.2). T3 Code titles an imported Claude thread from its `custom-title` /
// `ai-title` record when present, else from the first user message, which in real histories is often technical
// (`<command-name>/model</command-name>`, `<ide_opened_file>…`, `[external unsupported block: image]`).
// `proposeTitle` computes a clean one; `isTechnicalTitle` tells the planner which current titles deserve replacing.
import { cleanText, truncateTitle } from "../plan/names.ts";
import { extractText, obj, scanJsonl } from "../sources/jsonl.ts";

const TAG_ONLY_RE = /<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g;

/** Starts with a tag, an external-block marker or a caveat, or nothing but tags and whitespace is left. */
export function isTechnicalTitle(t: string): boolean {
  const s = t.trim();
  if (s === "" || s.startsWith("<") || s.startsWith("[external") || s.startsWith("Caveat:")) return true;
  return cleanText(s.replace(TAG_ONLY_RE, " ")) === "";
}

// Blocks removed whole when closed: command plumbing, IDE context, reminders, environment, browser notes.
const BLOCK_RE = /<(command-[\w-]+|local-command-[\w-]+|ide_[\w-]+|system-reminder|environment_context|browser_instruction)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
// An opening tag of the same family that never closes: its line goes.
const OPEN_LINE_RE = /^[^\S\n]*<(?:command-[\w-]+|local-command-[\w-]+|ide_[\w-]+|system-reminder|environment_context|browser_instruction)(?:\s[^>]*)?>.*$/gm;
const EXTERNAL_RE = /\[external [^\]\n]*\]/g;
const CAVEAT_LINE_RE = /^[^\S\n]*Caveat:.*$/gm;
const INTERRUPT_RE = /\[Request interrupted by user(?: for tool use)?\]/g;
const COMMAND_NAME_RE = /<command-name>\s*([^<]*?)\s*<\/command-name>/;

interface Stripped { text: string; command: string | null }

function strip(raw: string): Stripped {
  const command = COMMAND_NAME_RE.exec(raw)?.[1] || null;
  const text = cleanText(
    raw.replace(BLOCK_RE, " ").replace(OPEN_LINE_RE, " ").replace(EXTERNAL_RE, " ").replace(INTERRUPT_RE, " ").replace(CAVEAT_LINE_RE, " "),
  );
  return { text, command };
}

const str = (v: unknown): string => (typeof v === "string" ? cleanText(v) : "");

/**
 * Latest `custom-title`, else latest `ai-title`, else latest `summary`, else the first user message that is not
 * tool plumbing once technical blocks are removed (a lone slash command counts only when nothing real follows).
 * Cleaned with `cleanText` and cut to `maxLength` graphemes in the middle; null when nothing remains or the file
 * cannot be read.
 */
export async function proposeTitle(file: string, o: { maxLength: number }): Promise<string | null> {
  let custom = "";
  let ai = "";
  let summary = "";
  let firstText = "";
  let firstCommand = "";
  try {
    await scanJsonl(file, {}, (rec) => {
      const type = rec["type"];
      if (type === "custom-title") custom = str(rec["customTitle"]) || custom;
      else if (type === "ai-title") ai = str(rec["aiTitle"]) || ai;
      else if (type === "summary") summary = str(rec["summary"]) || summary;
      else if (type === "user" && firstText === "") {
        if (rec["isMeta"] === true || rec["isSidechain"] === true || rec["isCompactSummary"] === true || rec["isVisibleInTranscriptOnly"] === true) return;
        const content = obj(rec["message"])?.["content"];
        const s = strip(extractText(content));
        if (s.text !== "") firstText = s.text;
        else if (s.command !== null && firstCommand === "") firstCommand = s.command;
      }
    });
  } catch {
    return null;
  }
  const best = custom || ai || summary || firstText || firstCommand;
  const clean = cleanText(best);
  return clean === "" ? null : truncateTitle(clean, o.maxLength);
}
