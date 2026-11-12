// t3sm update: how this t3sm was installed, and the one npm command that installs the newest release.
// t3sm itself makes no network call here: npm fetches the release (`#semver:*` = the highest vX.Y.Z tag on GitHub).

import { spawn } from "node:child_process";

export type InstallKind = "checkout" | "global" | "npx";

/** `root` is the package root (the folder holding bin/ and package.json). */
export function installKind(root: string): InstallKind {
  const parts = root.split(/[\\/]+/);
  if (!parts.includes("node_modules")) return "checkout";
  return parts.includes("_npx") ? "npx" : "global";
}

/** `owner/name` of a GitHub repository URL. Throws when it is not one. */
export function repoSlug(repositoryUrl: string): string {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repositoryUrl);
  if (!m) throw new Error(`package.json's repository is not a GitHub URL: ${repositoryUrl}`);
  return `${m[1]}/${m[2]}`;
}

/** The npm spec of the newest release, from package.json's repository URL. */
export function releaseSpec(repositoryUrl: string): string {
  return `github:${repoSlug(repositoryUrl)}#semver:*`;
}

/** The environment npm runs with: everything but CLAUDE_CONFIG_DIR (a child process never inherits it). */
export function npmEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k.toUpperCase() !== "CLAUDE_CONFIG_DIR") out[k] = v;
  return out;
}

/** Arguments safe to hand to cmd.exe unquoted (npm is npm.cmd on Windows, which needs a shell). */
const SAFE_ARG = /^[A-Za-z0-9:/._#*@-]+$/;

/** Runs npm with the user's terminal attached (they see npm's own progress). Exit code; 127 when npm is missing. */
export function realNpm(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): (args: string[]) => Promise<number> {
  return async (args) => {
    const bad = args.find((a) => !SAFE_ARG.test(a));
    if (bad !== undefined) throw new Error(`refusing to pass ${JSON.stringify(bad)} to npm`);
    return spawnNpm(args, platform, env);
  };
}

function spawnNpm(args: string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("npm", args, { stdio: "inherit", shell: platform === "win32", env: npmEnv(env) });
    } catch {
      resolve(127);
      return;
    }
    child.on("error", () => resolve(127));
    // cmd.exe reports a missing command as exit 9009; a POSIX shell would say 127.
    child.on("close", (code) => resolve(code === 9009 ? 127 : code ?? 1));
  });
}
