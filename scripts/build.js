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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Writes outDir (emptied first) with one .js per .ts under srcDir, the help topics (docs/help/*.md) in outDir/help,
 * plus outDir/build.json `{version, builtAt}` (the
 * version from the package.json next to srcDir; builtAt now unless given; `channel: "npm"` with meta.channel, which
 * `T3SM_BUILD_CHANNEL=npm` sets for the package the Release workflow publishes). The background watcher compares builtAt
 * with the one it started from and restarts into a new build (src/core/version.ts). Returns the number of .js files.
 */
export function build(srcDir, outDir, meta = {}) {
  const strip = stripper();
  rmSync(outDir, { recursive: true, force: true });
  const sources = tsFiles(srcDir);
  for (const file of sources) {
    const target = join(outDir, relative(srcDir, file)).replace(/\.ts$/, ".js");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rewriteImports(strip(readFileSync(file, "utf8"))));
  }
  const version = meta.version ?? JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf8")).version;
  const builtAt = meta.builtAt ?? new Date().toISOString();
  mkdirSync(outDir, { recursive: true });
  // `channel: "npm"` marks the package the Release workflow publishes to the registry, so an install of it updates from
  // there (src/ops/update.ts isRegistryInstall); an install from GitHub or a checkout has no channel.
  const stamp = meta.channel === "npm" ? { version, builtAt, channel: "npm" } : { version, builtAt };
  writeFileSync(join(outDir, "build.json"), JSON.stringify(stamp) + "\n");
  // The help topics (`t3sm help <topic>`): docs/help/*.md in both languages, read by the installed package from dist/help.
  const help = meta.helpDir ?? join(srcDir, "..", "docs", "help");
  if (existsSync(help)) {
    mkdirSync(join(outDir, "help"), { recursive: true });
    for (const f of readdirSync(help).filter((x) => x.endsWith(".md"))) copyFileSync(join(help, f), join(outDir, "help", f));
  }
  return sources.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const channel = process.env.T3SM_BUILD_CHANNEL === "npm" ? "npm" : undefined;
  const n = build(join(root, "src"), join(root, "dist"), channel ? { channel } : {});
  process.stdout.write(`Built ${n} files into dist/${channel ? " (channel npm)" : ""}\n`);
}
