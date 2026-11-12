#!/usr/bin/env node
/**
 * Build dist/ from src/ with Node alone: no TypeScript package needed.
 *
 *   node scripts/build.js            src/ -> dist/ (npm run build; also npm's `prepare`)
 *
 * The sources use erasable TypeScript only (tsconfig: erasableSyntaxOnly), so stripping the types is the whole
 * compile: node:module's stripTypeScriptTypes (Node >= 22.13) replaces them with whitespace, and relative `.ts`
 * import specifiers become `.js` (what tsc's rewriteRelativeImportExtensions did). Type checking stays `npm run
 * typecheck` (tsc --noEmit), in CI.
 *
 * Why not tsc: `npm install -g github:<repo>` prepares a git dependency with an inner `npm install` that inherits
 * global mode on npm 11, so the clone never gets its devDependencies and `tsc` is missing. This script needs nothing
 * but the Node that runs it, so the git install works on every npm.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeModule from "node:module";

/** Relative `.ts` specifiers in import/export statements and dynamic import() become `.js`. */
export function rewriteImports(code) {
  return code.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]*?)\.ts\2/g,
    (_m, lead, q, path) => `${lead}${q}${path}.js${q}`,
  );
}

function stripper() {
  const strip = nodeModule.stripTypeScriptTypes;
  if (typeof strip !== "function") {
    throw new Error(`node:module has no stripTypeScriptTypes in Node ${process.versions.node}; t3sm needs Node 22.18 or newer`);
  }
  // Node prints an ExperimentalWarning the first time; it says nothing useful during a build.
  const emit = process.emitWarning;
  return (code) => {
    process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes("stripTypeScriptTypes") ? undefined : emit.call(process, w, ...rest));
    try { return strip(code, { mode: "strip" }); } finally { process.emitWarning = emit; }
  };
}

function tsFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
  });
}

/** Writes outDir (emptied first) with one .js per .ts under srcDir. Returns the number of files written. */
export function build(srcDir, outDir) {
  const strip = stripper();
  rmSync(outDir, { recursive: true, force: true });
  const sources = tsFiles(srcDir);
  for (const file of sources) {
    const target = join(outDir, relative(srcDir, file)).replace(/\.ts$/, ".js");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rewriteImports(strip(readFileSync(file, "utf8"))));
  }
  return sources.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const n = build(join(root, "src"), join(root, "dist"));
  process.stdout.write(`Built ${n} files into dist/\n`);
}
