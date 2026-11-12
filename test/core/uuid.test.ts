import { test } from "node:test";
import assert from "node:assert/strict";
import { uuidV5, isUuid, T3SM_NAMESPACE } from "../../src/core/uuid.ts";

test("uuidV5 is stable and RFC 4122 v5", () => {
  const a = uuidV5("opencode:ses_1");
  assert.equal(a, uuidV5("opencode:ses_1"));
  assert.notEqual(a, uuidV5("opencode:ses_2"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab]/);
  assert.equal(T3SM_NAMESPACE, "b7e1c3a2-5f4d-4e8b-9a6c-2d1f0e3b4a59");
});

test("uuidV5 known vector", () => {
  assert.equal(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
});

test("isUuid", () => {
  assert.equal(isUuid("2ed6657d-e927-568b-95e1-2665a8aea6a2"), true);
  assert.equal(isUuid("2ED6657D-E927-568B-95E1-2665A8AEA6A2"), true);
  assert.equal(isUuid("ses_1"), false);
  assert.equal(isUuid(""), false);
});
