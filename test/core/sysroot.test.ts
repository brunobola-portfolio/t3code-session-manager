import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SYSTEM_ROOT, driveSystemRoot, system32, systemRoot } from "../../src/core/sysroot.ts";

test("systemRoot: a drive path from SystemRoot (else windir); anything else falls back to C:\\Windows", () => {
  assert.equal(systemRoot({ SystemRoot: "D:\\Win" }), "D:\\Win");
  assert.equal(systemRoot({ windir: "E:\\Windows\\" }), "E:\\Windows", "trailing separator dropped");
  assert.equal(systemRoot({}), DEFAULT_SYSTEM_ROOT);
  for (const bad of ["Windows", "\\Windows", "\\\\srv\\share\\Windows", "\\\\?\\C:\\Windows", "C:Windows", "//host/x"]) {
    assert.equal(driveSystemRoot({ SystemRoot: bad }), null, bad);
    assert.equal(systemRoot({ SystemRoot: bad }), DEFAULT_SYSTEM_ROOT, bad);
  }
  assert.equal(system32({ SystemRoot: "D:\\Win" }, "WindowsPowerShell", "v1.0", "powershell.exe"), "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(system32({ SystemRoot: "Windows" }, "taskkill.exe"), "C:\\Windows\\System32\\taskkill.exe");
});
