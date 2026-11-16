// Types for scripts/build.js (imported by test/scripts/build.test.ts).
/** Relative `.ts` specifiers in import/export statements and dynamic import() become `.js`. */
export function rewriteImports(code: string): string;
/**
 * Writes outDir (emptied first) with one .js per .ts under srcDir, plus outDir/build.json `{version, builtAt}`.
 * Returns the number of .js files written.
 */
export function build(srcDir: string, outDir: string, meta?: { version?: string; builtAt?: string; helpDir?: string; channel?: "npm" }): number;
