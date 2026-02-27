import test from "node:test";
import assert from "node:assert/strict";
import { getAtPath, parsePath, setAtPath, unsetAtPath } from "../shared/config-path.js";

test("parsePath handles dot and bracket notation", () => {
  assert.deepEqual(parsePath("routing.routes.main.projectRoot"), ["routing", "routes", "main", "projectRoot"]);
  assert.deepEqual(
    parsePath("connectors.instances[discord.main].config.botChannelMap[12345]"),
    ["connectors", "instances", "discord.main", "config", "botChannelMap", "12345"],
  );
});

test("setAtPath and getAtPath support nested objects", () => {
  const payload: Record<string, unknown> = {};
  setAtPath(payload, parsePath("a.b.c"), 42);

  const read = getAtPath(payload, parsePath("a.b.c"));
  assert.equal(read.found, true);
  assert.equal(read.value, 42);
});

test("unsetAtPath removes keys", () => {
  const payload: Record<string, unknown> = { a: { b: { c: 1 } } };
  const removed = unsetAtPath(payload, parsePath("a.b.c"));
  assert.equal(removed, true);

  const read = getAtPath(payload, parsePath("a.b.c"));
  assert.equal(read.found, false);
});
