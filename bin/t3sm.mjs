#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { resolveEntry } from "./entry.mjs";

// The OpenCode adapter reads a private copy of OpenCode's database with node:sqlite, which Node 22/24 still label
// experimental: drop that one warning (it would print on every run for OpenCode users); every other warning stays.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (String(warning?.message ?? warning).startsWith("SQLite is an experimental feature")) return;
  return emitWarning.call(process, warning, ...rest);
};

// A checkout runs src/ (never a stale dist/); an installed package runs dist/ (bin/entry.mjs).
const entry = resolveEntry(new URL(import.meta.url));
if (entry.kind === "none") {
  process.stderr.write("t3sm: neither src/cli/main.ts nor dist/cli/main.js was found. Run `npm run build`.\n");
  process.exit(1);
}
const { main } = await import(entry.url);

const io = {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  // Ctrl+C at a prompt, or input closed (Ctrl+D / Ctrl+Z), answers "\u0003": every confirmation reads it as "no", the
  // guided assistant as "quit". Ctrl+C while a command runs is that command's own signal handling.
  prompt: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ac = new AbortController();
    rl.on("SIGINT", () => ac.abort());
    rl.on("close", () => ac.abort());
    try {
      return await rl.question(q, { signal: ac.signal });
    } catch (e) {
      if (e?.name === "AbortError") { process.stderr.write("\n"); return "\u0003"; }
      throw e;
    } finally {
      rl.close();
    }
  },
  env: process.env,
};

process.exitCode = await main(process.argv.slice(2), io);
