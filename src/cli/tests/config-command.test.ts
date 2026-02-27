import test from "node:test";
import assert from "node:assert/strict";
import { parseConfigSetValue } from "../commands/config.js";

test("parseConfigSetValue parses JSON5 by default", () => {
  assert.deepEqual(parseConfigSetValue('{ foo: "bar" }'), { foo: "bar" });
  assert.equal(parseConfigSetValue("123"), 123);
  assert.equal(parseConfigSetValue("true"), true);
});

test("parseConfigSetValue falls back to raw string when JSON5 parse fails", () => {
  assert.equal(parseConfigSetValue("not-json"), "not-json");
});

test("parseConfigSetValue strict mode throws on invalid JSON5", () => {
  assert.throws(() => parseConfigSetValue("not-json", true), /Failed to parse JSON5 value/);
});
