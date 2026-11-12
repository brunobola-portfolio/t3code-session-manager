// Types for scripts/build.js (imported by test/scripts/build.test.ts).
/** Relative `.ts` specifiers in import/export statements and dynamic import() become `.js`. */
export function rewriteImports(code: string): string;
/** Writes outDir (emptied first) with one .js per .ts under srcDir. Returns the number of files written. */
export function build(srcDir: string, outDir: string): number;
