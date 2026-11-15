import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFolder, isT3Refused, type FolderEnv } from "../../src/plan/folders.ts";
import type { FolderCategory } from "../../src/core/types.ts";

const win: FolderEnv = {
  platform: "win32",
  home: "C:/Users/demo",
  tmpdir: "C:/Users/demo/AppData/Local/Temp",
  env: { WINDIR: "C:\\Windows", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramData: "C:\\ProgramData" },
  t3BaseDir: "C:/Users/demo/.t3",
  t3WorktreesDir: "C:/Users/demo/.t3/worktrees",
};
const posix: FolderEnv = {
  platform: "linux",
  home: "/home/demo",
  tmpdir: "/var/tmp/demo-tmp",
  env: {},
  t3BaseDir: "/home/demo/.t3",
  t3WorktreesDir: "/home/demo/.t3/worktrees",
};

const cases: { name: string; env: FolderEnv; cwd: string; want: FolderCategory }[] = [
  { name: "win home", env: win, cwd: "C:/Users/demo", want: "home" },
  { name: "win Downloads child", env: win, cwd: "C:/Users/demo/Downloads/x", want: "t3-refused" },
  { name: "win Downloads itself", env: win, cwd: "C:/Users/demo/Downloads", want: "t3-refused" },
  { name: "win Documents/Codex", env: win, cwd: "C:/Users/demo/Documents/Codex/2026/x", want: "t3-refused" },
  { name: "win T3 base", env: win, cwd: "C:/Users/demo/.t3/state", want: "t3-refused" },
  { name: "win T3 worktrees", env: win, cwd: "C:/Users/demo/.t3/worktrees/app/wt1", want: "t3-refused" },
  { name: "win exact tmpdir", env: win, cwd: "C:/Users/demo/AppData/Local/Temp", want: "t3-refused" },
  { name: "win inside tmpdir", env: win, cwd: "C:/Users/demo/AppData/Local/Temp/job1", want: "temp" },
  { name: "win scratchpad", env: win, cwd: "C:/Users/demo/AppData/Local/Temp/claude/abc/scratchpad/demo", want: "temp" },
  { name: "win scratchpad elsewhere", env: win, cwd: "D:/Work/scratchpad/x", want: "temp" },
  { name: "win D:/tmp", env: win, cwd: "D:/tmp/demo", want: "temp" },
  { name: "win D:\\temp", env: win, cwd: "D:\\Temp\\demo", want: "temp" },
  { name: "win Windows", env: win, cwd: "C:/Windows/System32", want: "system" },
  { name: "win Program Files", env: win, cwd: "C:/Program Files/Tool", want: "system" },
  { name: "win Program Files x86", env: win, cwd: "C:/Program Files (x86)/Tool", want: "system" },
  { name: "win ProgramData", env: win, cwd: "C:/ProgramData/x", want: "system" },
  { name: "win AppData non-temp", env: win, cwd: "C:/Users/demo/AppData/Local/PowerToys", want: "system" },
  { name: "win project", env: win, cwd: "D:/Work/app", want: "project" },
  { name: "win project in home", env: win, cwd: "C:/Users/demo/code/app", want: "project" },
  { name: "win sibling prefix is not inside", env: win, cwd: "C:/Users/demo/Downloads2/x", want: "project" },
  { name: "win lower drive/case/backslash", env: win, cwd: "d:\\Work\\App", want: "project" },
  { name: "win trailing slash", env: win, cwd: "D:/Work/App/", want: "project" },
  { name: "win \\\\?\\ prefix", env: win, cwd: "\\\\?\\D:\\Work\\App", want: "project" },
  { name: "win \\\\?\\ home", env: win, cwd: "\\\\?\\C:\\Users\\demo", want: "home" },
  { name: "win upper-case home", env: win, cwd: "C:\\USERS\\DEMO", want: "home" },
  { name: "win env var names case-insensitive", env: { ...win, env: { windir: "C:\\Windows" } }, cwd: "C:/Windows/x", want: "system" },
  { name: "posix home", env: posix, cwd: "/home/demo", want: "home" },
  { name: "posix home trailing slash", env: posix, cwd: "/home/demo/", want: "home" },
  { name: "posix Downloads", env: posix, cwd: "/home/demo/Downloads/x", want: "t3-refused" },
  { name: "posix /tmp exact", env: posix, cwd: "/tmp", want: "t3-refused" },
  { name: "posix /private/tmp exact", env: posix, cwd: "/private/tmp", want: "t3-refused" },
  { name: "posix tmpdir exact", env: posix, cwd: "/var/tmp/demo-tmp", want: "t3-refused" },
  { name: "posix inside /tmp", env: posix, cwd: "/tmp/job", want: "temp" },
  { name: "posix inside tmpdir", env: posix, cwd: "/var/tmp/demo-tmp/job", want: "temp" },
  { name: "posix /usr", env: posix, cwd: "/usr/local/share", want: "system" },
  { name: "posix /opt", env: posix, cwd: "/opt", want: "system" },
  { name: "posix /Library", env: posix, cwd: "/Library/x", want: "system" },
  { name: "posix project", env: posix, cwd: "/home/demo/code/app", want: "project" },
  { name: "posix case-sensitive Downloads", env: posix, cwd: "/home/demo/downloads/x", want: "project" },
  { name: "posix AppData is not system", env: posix, cwd: "/home/demo/AppData/x", want: "project" },
  { name: "posix upper-case home differs", env: posix, cwd: "/HOME/DEMO", want: "project" },
  { name: "macOS case-folded home", env: { ...posix, platform: "darwin" }, cwd: "/HOME/DEMO", want: "home" },
];

for (const c of cases) {
  test(`classifyFolder: ${c.name}`, () => {
    assert.equal(classifyFolder(c.cwd, c.env), c.want);
  });
}

test("isT3Refused: home and every t3-refused folder, nothing else", () => {
  assert.equal(isT3Refused("C:/Users/demo", win), true);
  assert.equal(isT3Refused("C:/Users/demo/Downloads/x", win), true);
  assert.equal(isT3Refused("C:/Users/demo/AppData/Local/Temp", win), true);
  assert.equal(isT3Refused("C:/Users/demo/AppData/Local/Temp/job1", win), false);
  assert.equal(isT3Refused("C:/Windows/System32", win), false);
  assert.equal(isT3Refused("D:/Work/app", win), false);
  assert.equal(isT3Refused("/tmp", posix), true);
});
