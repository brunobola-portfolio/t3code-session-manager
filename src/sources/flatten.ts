// Tool calls as conversation text, shared by every convert-mode reader (SourceAdapter.read contract):
// `[tool <name>] <input> → <output>`, the part after the name at most TOOL_TEXT_MAX characters (`…` appended when clipped).

/** Characters of `<input> → <output>` kept per flattened tool call. */
export const TOOL_TEXT_MAX = 500;

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** A tool input as the user would recognise it: the lone string argument (`ls -la`), else compact JSON. */
export function toolInput(input: unknown): string {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const vals = Object.values(input as Record<string, unknown>);
    if (vals.length === 1 && typeof vals[0] === "string") return vals[0];
  }
  return input === undefined ? "" : JSON.stringify(input);
}

/** One flattened tool call line. */
export function toolLine(name: string, input: string, output: string): string {
  return `[tool ${name}] ${clip(`${input} → ${output}`, TOOL_TEXT_MAX)}`;
}
