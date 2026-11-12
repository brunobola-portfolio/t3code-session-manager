export type Entry = { kind: "src" | "dist"; url: string } | { kind: "none" };
export function resolveEntry(binUrl: URL, exists?: (u: URL) => boolean): Entry;
